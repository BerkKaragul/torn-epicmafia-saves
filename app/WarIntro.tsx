"use client";

import { useEffect, useRef, useState } from "react";

// A one-off war-cry splash that greets a member the first time they open the
// site on a device. Seen-flag lives in localStorage; if storage is blocked we
// just skip it rather than shout at them on every page load.
const SEEN_KEY = "cw_war_intro";
const AUTO_CLOSE_MS = 4000;

export function WarIntro() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      return;
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    // it's modal: take focus while shown, keep Tab from wandering into the page
    // behind, and hand focus back to wherever it was on close
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const t = setTimeout(() => setOpen(false), AUTO_CLOSE_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "Tab") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="War cry"
      onClick={() => setOpen(false)}
      className="cw-war-backdrop fixed outline-none inset-0 z-[100] flex cursor-pointer items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="cw-war-pop w-full max-w-2xl rounded-2xl border-2 border-red-600 bg-[#1a0505] px-5 py-8 text-center shadow-[0_0_60px_rgba(220,38,38,0.6)] sm:px-10 sm:py-12">
        <p className="text-4xl sm:text-5xl" aria-hidden>
          ⚔️🔥⚔️
        </p>
        <p className="cw-war-shake mt-3 break-all text-[clamp(1.75rem,9vw,4rem)] font-black leading-none tracking-tight text-[#ef4444] [text-shadow:0_0_18px_rgba(239,68,68,0.8)]">
          WAAAAAAAAAAARRRRRRRRRR!!!!!!
        </p>
        <p className="mt-4 text-sm font-semibold uppercase tracking-widest text-[#fca5a5]">
          Welcome, soldier — the chain needs you
        </p>
        <p className="mt-6 text-xs text-[#a3a3a3]">tap anywhere to fight</p>
      </div>
    </div>
  );
}
