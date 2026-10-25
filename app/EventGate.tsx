"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useActiveEvent } from "./EventContext";
import { fmtTct } from "@/lib/format";

// Home page during an event: there is no normal saving, so a popup sends members
// to the event page — once per browser session, so it doesn't nag on every
// visit — and a banner keeps the way there in sight after it's closed.
const SEEN_KEY = "cw_event_gate";

export function EventGate() {
  const event = useActiveEvent();
  const [open, setOpen] = useState(false);
  const goRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!event) return;
    try {
      if (sessionStorage.getItem(SEEN_KEY) === String(event.id)) return;
      sessionStorage.setItem(SEEN_KEY, String(event.id));
    } catch {
      // storage blocked: show it anyway — it's a single dismissable popup
    }
    setOpen(true);
  }, [event]);

  useEffect(() => {
    if (!open) return;
    goRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!event) return null;

  return (
    <>
      <Link
        href="/event"
        className="mb-6 flex items-center gap-3 rounded-2xl border-2 border-orange-600 bg-orange-950/40 p-4 shadow-[0_0_30px_rgba(234,88,12,0.25)] transition hover:bg-orange-950/70"
      >
        <span className="text-4xl" aria-hidden>
          🎃
        </span>
        <span className="min-w-0">
          <span className="block font-black text-orange-300">{event.name} is ON</span>
          <span className="block text-sm text-neutral-300">
            No normal saving right now — enlist on the event page. Saves in Torn City count too.
            Ends {fmtTct(event.ends_at)}.
          </span>
        </span>
        <span className="ml-auto shrink-0 rounded-md bg-orange-600 px-3 py-2 text-sm font-bold text-white">
          Go →
        </span>
      </Link>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${event.name} — go to the event page`}
          onClick={() => setOpen(false)}
          className="cw-war-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="cw-war-pop w-full max-w-lg rounded-2xl border-2 border-orange-600 bg-[#170b1f] px-6 py-8 text-center shadow-[0_0_60px_rgba(234,88,12,0.5)]"
          >
            <p className="text-5xl" aria-hidden>
              🦇🎃🦇
            </p>
            <p className="cw-flicker mt-3 text-3xl font-black tracking-tight text-orange-400 sm:text-4xl">
              {event.name.toUpperCase()}
            </p>
            <p className="mt-4 text-base font-semibold text-neutral-100">
              Normal saving is closed during the event.
            </p>
            <p className="mt-1 text-sm text-neutral-300">
              Enlist and save from the event page — and this time saves made in{" "}
              <strong className="text-orange-300">Torn City</strong> count and pay too.
            </p>
            <p className="mt-2 text-xs text-neutral-500">Ends {fmtTct(event.ends_at)}</p>
            <div className="mt-6 flex flex-col items-center gap-2">
              <Link
                ref={goRef}
                href="/event"
                className="w-full rounded-lg bg-orange-600 px-5 py-3 text-lg font-black text-white outline-none ring-orange-300 transition hover:bg-orange-500 focus-visible:ring-2 sm:w-auto"
              >
                🎃 Go to the Halloween event →
              </Link>
              <button
                onClick={() => setOpen(false)}
                className="text-xs text-neutral-500 underline hover:text-neutral-300"
              >
                just looking at the chain
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
