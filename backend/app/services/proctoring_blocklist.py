"""The tools this platform watches for during an interview.

One list, owned by the server, for two very different detectors:

  * the desktop probe matches running *process names* (desktop-probe/probe.js)
  * the browser checks for injected *DOM elements* (lib/extensionDetection.ts)

Kept here rather than hard-coded in each so a new tool can be added in one place, and so
the probe — which is a separate file handed to the candidate and otherwise frozen at
whatever version they downloaded — picks up additions without being redistributed.

These are substring hints matched case-insensitively, not exact names or versioned
selectors. Vendors rename binaries and restructure their DOM constantly; a hint on the
product name survives that, and the alternative is a list that silently stops matching.

An important limit, stated plainly because it shapes what this can be relied on for: this
is detection, not prevention. Nothing here stops a program running on someone else's
computer. A hit is strong evidence worth a human's attention; a miss proves nothing,
because several of these tools exist specifically to be invisible — they render outside
the page, avoid the DOM entirely, or hide from screen capture by design.
"""

# Desktop applications, matched against the process list the probe collects.
# Entries are lowercase substrings of an executable/process name.
BLOCKED_APP_HINTS: list[str] = [
    # --- Interview "copilot" / answer-overlay tools -------------------------------------
    "interviewcoder",
    "interview-coder",
    "lockedin",
    "finalround",
    "final-round",
    "ghotly",
    "ghostly",
    "beyz",
    "leetcodewizard",
    "leetcode-wizard",
    "parakeet",
    "interviewcopilot",
    "interview-copilot",
    "meetassist",
    "meet-assist",
    "jobjump",
    "hcalls",
    "joblander",
    "cluely",
    # --- General-purpose assistants and remote-control tools ----------------------------
    "chatgpt",
    "claude",
    "copilot",
    "anydesk",
    "teamviewer",
    "rustdesk",
    "ultraviewer",
    "obs",
    "discord",
]

# Browser extensions, matched against the id/class attributes of elements they inject.
AI_EXTENSION_DOM_HINTS: list[str] = [
    # --- Interview answer helpers -------------------------------------------------------
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
    # --- ChatGPT-sidebar style assistants ------------------------------------------------
    "monica",
    "sider",
    "merlin-ext",  # not the bare word "merlin" — too common to be a safe hint
    "chatgpt-sidebar",
    "chatgptbox",
    "compose-ai",
    "poe-ai-extension",
    "tenorshare-ai",
    # --- Extensions whose purpose is defeating the restrictions this page relies on ------
    # Paste re-enablers, right-click/copy unlockers. These don't answer questions for the
    # candidate; they re-enable the exact interactions the interview is monitoring.
    "dont-fuck-with-paste",
    "dontfuckwithpaste",
    "allow-copy",
    "allowcopy",
    "absolute-enable",
    "enable-right-click",
    "righttocopy",
    # Focus fakers that advertise themselves in the DOM. The ones that don't are caught
    # behaviourally instead — see detectProctoringTamper in lib/extensionDetection.ts.
    "anti-blur",
    "antiblur",
    "tab-focus",
    "focus-faker",
    "stay-focused",
]
