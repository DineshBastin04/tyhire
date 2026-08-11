/**
 * Best-effort heuristic for AI answer-helper / "cheat assistant" browser extensions
 * (Monica AI, Sider, Merlin, and similar ChatGPT-sidebar-style tools) being active on the
 * page during the interview. These extensions inject their own DOM elements — a floating
 * launcher icon, an overlay sidebar, an injected root container — directly into every
 * page they run on, and almost universally tag those elements with the extension's own
 * product name in the id/class (for their own CSS scoping) regardless of version. This
 * scans for that, the same substring-hint approach already used for virtual-camera
 * device labels (see VIRTUAL_CAMERA_HINTS in interview/[token]/page.tsx) — a loose,
 * name-based heuristic rather than a versioned, exact selector that would break the
 * moment the extension ships a DOM restructure.
 *
 * Explicitly a heuristic, not a certainty, same as that virtual-camera check: a hit is
 * real signal (nothing in this app's own DOM would ever legitimately match these
 * product-name hints), but a miss proves nothing — extensions using a fully isolated
 * Shadow DOM root, or any tool simply not in this list, are invisible to this. Never
 * trusted alone as an automated judgment — like every other fused signal, it's reviewed
 * by a person (see services/integrity.py), not auto-penalized.
 */
const AI_EXTENSION_DOM_HINTS = [
  "monica", // Monica AI
  "sider", // Sider AI sidebar
  "merlin-ext", // Merlin AI (not the bare word "merlin" — too common to be a safe hint)
  "chatgpt-sidebar",
  "chatgptbox",
  "compose-ai",
  "poe-ai-extension",
  "tenorshare-ai", // seen bundled into several "AI answer" extension clones
];

/** Scans every element's id/class for the hints above. Attributes only, deliberately —
 * not full innerHTML/outerHTML text — so this can't be triggered by the interview page's
 * own copy ever mentioning one of these product names in passing. */
export function detectAiExtensionArtifacts(): boolean {
  const elements = document.querySelectorAll("[id], [class]");
  for (const el of elements) {
    const id = el.id.toLowerCase();
    const className = typeof el.className === "string" ? el.className.toLowerCase() : "";
    if (AI_EXTENSION_DOM_HINTS.some((hint) => id.includes(hint) || className.includes(hint))) {
      return true;
    }
  }
  return false;
}
