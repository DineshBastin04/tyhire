/**
 * Two checks against browser-side interview tooling.
 *
 * `detectAiExtensionArtifacts` is a name heuristic: answer-helper extensions inject their
 * own DOM — a floating launcher, an overlay sidebar, an injected root container — and
 * almost universally tag it with the product name in the id/class for their own CSS
 * scoping, regardless of version. Scanning for that survives the DOM restructures that
 * break exact selectors.
 *
 * `detectProctoringTamper` is different in kind and worth the separation: the extensions
 * it looks for exist precisely to avoid being seen. An anti-blur or focus-faker extension
 * has no reason to brand its DOM, and may inject none at all — its whole job is to make
 * the page believe the candidate never left the tab, which silently disables the
 * tab_switch, window_blur and fullscreen_exit signals this interview depends on. So rather
 * than looking for the extension, that check looks for the damage: the browser's own
 * visibility and focus reporting no longer being the browser's.
 *
 * Both are heuristics, and neither is ever an automated judgment — like every signal here
 * they are fused and reviewed by a person (services/integrity.py). A hit is real evidence:
 * nothing in this app's own code would legitimately match a product-name hint or replace a
 * native browser method. A miss proves nothing — an extension in a closed Shadow DOM root,
 * or simply one not on the list, is invisible to the first check.
 */

const AI_EXTENSION_DOM_HINTS = [
  // --- Interview answer helpers ---------------------------------------------------------
  "interview-coder",
  "interviewcoder",
  "lockedin",
  "finalround",
  "final-round",
  "ghotly",
  "ghostly",
  "beyz",
  "leetcode-wizard",
  "leetcodewizard",
  "parakeet",
  "interview-copilot",
  "interviewcopilot",
  "meetassist",
  "meet-assist",
  "jobjump",
  "hcalls",
  "joblander",
  "cluely",
  // --- ChatGPT-sidebar style assistants --------------------------------------------------
  "monica",
  "sider",
  "merlin-ext", // not the bare word "merlin" — too common to be a safe hint
  "chatgpt-sidebar",
  "chatgptbox",
  "compose-ai",
  "poe-ai-extension",
  "tenorshare-ai",
  // --- Extensions for defeating the restrictions this page relies on ---------------------
  "dont-fuck-with-paste",
  "dontfuckwithpaste",
  "allow-copy",
  "allowcopy",
  "absolute-enable",
  "enable-right-click",
  "righttocopy",
  "anti-blur",
  "antiblur",
  "tab-focus",
  "focus-faker",
  "stay-focused",
];

/** Attributes worth reading. Extensions brand their injected elements through any of these:
 * the id/class for CSS scoping, and the resource URL when they pull in their own script,
 * icon or iframe from chrome-extension://<id>/… — which is often the only place the
 * product name appears when the element itself is anonymous. */
const SCANNED_ATTRIBUTES = ["id", "class", "src", "href", "name", "data-extension", "data-testid"];

/** How many elements to examine per sweep. The interview page is small; this only bounds
 * the cost if some extension injects a pathological number of nodes. */
const MAX_NODES_SCANNED = 20000;

function matchesHint(value: string | null): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return AI_EXTENSION_DOM_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Looks for a known tool's fingerprint anywhere in the page, including inside open shadow
 * roots.
 *
 * Shadow DOM matters here: `document.querySelectorAll` stops at a shadow boundary, and
 * injecting a UI into a shadow root is the normal way an extension isolates its styles
 * from the host page — so scanning only the light DOM missed the exact tools this is for.
 * Closed roots remain invisible to any script, which is a real and unavoidable gap.
 *
 * Attributes only, deliberately — never innerHTML/text — so this can't be triggered by the
 * interview page's own copy ever mentioning one of these product names in passing.
 */
export function detectAiExtensionArtifacts(): boolean {
  if (typeof document === "undefined") return false;

  const roots: (Document | ShadowRoot)[] = [document];
  let scanned = 0;

  for (let i = 0; i < roots.length; i++) {
    let elements: ArrayLike<Element>;
    try {
      elements = roots[i].querySelectorAll("*");
    } catch {
      continue;
    }

    for (let j = 0; j < elements.length; j++) {
      if (++scanned > MAX_NODES_SCANNED) return false;
      const el = elements[j];

      for (const attr of SCANNED_ATTRIBUTES) {
        try {
          if (matchesHint(el.getAttribute(attr))) return true;
        } catch {
          // Some injected nodes throw on attribute access; they aren't worth the sweep.
        }
      }

      // Queue any open shadow root so its contents get the same treatment.
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) roots.push(shadow);
    }
  }

  return false;
}

/** True only for a function the browser itself provides. Anything that has been wrapped or
 * replaced stringifies to its own source instead of "[native code]". */
function isNative(fn: unknown): boolean {
  try {
    return typeof fn === "function" && Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return false;
  }
}

/** True when a property has been shadowed on the instance, or redefined on the prototype
 * with a non-native getter — the two ways a page's view of itself gets rewritten. */
function isPropertyHijacked(obj: object, proto: object, name: string): boolean {
  try {
    // Normally `hidden` and `visibilityState` live on Document.prototype, never on the
    // document instance; an own property means something put it there.
    if (Object.prototype.hasOwnProperty.call(obj, name)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor) return false;
    // A real getter is native. A replacement reports its own source.
    return descriptor.get !== undefined && !isNative(descriptor.get);
  } catch {
    return false;
  }
}

/**
 * Looks for the page's visibility/focus machinery having been replaced, which is how
 * anti-blur and "tab focus faker" extensions work. Returns a short reason for the reviewer,
 * or null when everything is the browser's own.
 *
 * Deliberately checks for *tampering* rather than for symptoms. Inferring it from behaviour
 * — a tab that never reports being hidden, animation frames throttling while the page
 * claims to be visible — misfires on slow machines, background load and ordinary
 * minimising. Whether `document.hidden` is still the browser's own getter is a fact, not an
 * inference.
 */
export function detectProctoringTamper(): string | null {
  if (typeof document === "undefined") return null;

  if (isPropertyHijacked(document, Document.prototype, "hidden")) {
    return "Page visibility reporting has been overridden";
  }
  if (isPropertyHijacked(document, Document.prototype, "visibilityState")) {
    return "Page visibility state has been overridden";
  }
  if (!isNative(document.hasFocus)) {
    return "Window focus reporting has been replaced";
  }
  // Event registration itself gets stubbed to swallow blur/visibilitychange before any
  // listener sees them, which leaves the properties above looking untouched.
  if (!isNative(document.addEventListener) || !isNative(window.addEventListener)) {
    return "Browser event handling has been modified";
  }
  return null;
}
