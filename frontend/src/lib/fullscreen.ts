/**
 * Cross-browser fullscreen helpers. Desktop Safari never implemented the standard
 * requestFullscreen/exitFullscreen/fullscreenElement/fullscreenchange — only their
 * webkit-prefixed equivalents — so calling the unprefixed API there doesn't throw, it
 * just silently no-ops (`element.requestFullscreen` is simply undefined, and optional
 * chaining on it does nothing). These fall back to the prefixed versions when present.
 *
 * iOS Safari is a separate, unfixable case: it doesn't support whole-page fullscreen at
 * all (only a single <video> element via webkitEnterFullscreen), on either prefix — no
 * JS-side fallback can produce that API where the browser never shipped it.
 */

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}

interface WebkitFullscreenDocument extends Document {
  webkitExitFullscreen?: () => void;
  webkitFullscreenElement?: Element | null;
}

export function requestFullscreen(element: HTMLElement = document.documentElement): Promise<void> {
  const el = element as WebkitFullscreenElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return Promise.resolve(el.webkitRequestFullscreen());
  return Promise.reject(new Error("Fullscreen is not supported in this browser."));
}

export function exitFullscreen(): Promise<void> {
  const doc = document as WebkitFullscreenDocument;
  if (document.exitFullscreen) return document.exitFullscreen();
  if (doc.webkitExitFullscreen) return Promise.resolve(doc.webkitExitFullscreen());
  return Promise.resolve();
}

export function isFullscreenActive(): boolean {
  const doc = document as WebkitFullscreenDocument;
  return !!(document.fullscreenElement || doc.webkitFullscreenElement);
}

/** Registers a fullscreenchange listener that also catches Safari's prefixed event name;
 * returns a cleanup function that removes both. */
export function onFullscreenChange(handler: () => void): () => void {
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
  };
}
