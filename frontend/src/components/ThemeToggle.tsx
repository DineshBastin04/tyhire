"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

// Light/dark toggle. The actual theme is applied to <html data-theme> by the inline no-flash
// script in layout.tsx before paint; this just reads that initial value, flips it on click, and
// persists the choice to localStorage so it sticks across reloads and sessions.
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  // Read the theme the no-flash script already applied, rather than guessing — avoids a
  // flicker or a wrong initial icon. Runs client-side only.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // storage can be blocked (private mode); the in-page theme still switches for this view.
    }
    setTheme(next);
  }

  // Render nothing until we know the theme, so SSR and first client paint agree.
  if (theme === null) {
    return <span className="w-6" aria-hidden />;
  }

  const goingDark = theme === "light";
  return (
    <button
      onClick={toggle}
      className="text-zinc-600 hover:text-blue-900"
      title={goingDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={goingDark ? "Switch to dark mode" : "Switch to light mode"}
    >
      {/* Simple inline icons so this adds no icon dependency and inherits currentColor. */}
      {goingDark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  );
}
