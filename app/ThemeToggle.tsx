"use client";

import { useEffect, useState } from "react";
import { applyTheme, readThemePref, THEME_KEY, type ThemePref } from "./theme";

const ORDER: ThemePref[] = ["system", "light", "dark"];
const LABEL: Record<ThemePref, { icon: string; title: string }> = {
  system: { icon: "🖥", title: "Theme: follows your device" },
  light: { icon: "☀", title: "Theme: light" },
  dark: { icon: "🌙", title: "Theme: dark" },
};

export function ThemeToggle() {
  // The boot script has already set the class; this only mirrors the stored
  // choice into the button. Starting at the default and correcting in an effect
  // keeps the server and client markup identical.
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    const stored = readThemePref();
    setPref(stored);
    // re-apply so the browser-chrome colour catches up with a pinned theme —
    // the boot script only sets the class
    applyTheme(stored);
  }, []);

  // while on "system", track the OS flipping (night shift, manual change)
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    setPref(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage blocked: the choice still applies for this page's lifetime
    }
  }

  return (
    <button
      onClick={cycle}
      title={`${LABEL[pref].title} — click to change`}
      aria-label={LABEL[pref].title}
      className="rounded-md border border-neutral-700 px-2 py-1 text-xs leading-none text-neutral-300 hover:bg-neutral-800"
    >
      <span aria-hidden>{LABEL[pref].icon}</span>
    </button>
  );
}
