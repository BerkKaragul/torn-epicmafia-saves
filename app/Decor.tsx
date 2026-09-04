"use client";

import { useEffect, useState } from "react";

// Purely decorative beach/summer flourishes down the empty side gutters. Fixed,
// pointer-events-none and hidden on small screens so they never touch the actual
// UI or the danger alerts. Per-device on/off (localStorage) via a tiny corner
// toggle, since this is a shared tool and not everyone wants the garnish.

const LEFT = ["🍹", "👙", "🌴", "🦩", "🕶️", "🌺", "🐚"];
const RIGHT = ["🍸", "💃", "🌊", "🏖️", "☀️", "🧉", "🌴"];

function Column({ items, side }: { items: string[]; side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed top-0 z-0 hidden h-full w-14 select-none flex-col items-center justify-around py-8 lg:flex xl:w-20 ${
        side === "left" ? "left-0" : "right-0"
      }`}
    >
      {items.map((e, i) => (
        <span
          key={`${side}-${i}`}
          className="cw-float text-2xl xl:text-3xl"
          style={{
            // varied bob speed, phase, tilt and opacity so it reads organic
            ["--cw-rot" as string]: `${(i % 2 === 0 ? -1 : 1) * (4 + (i % 3) * 3)}deg`,
            opacity: 0.22 + (i % 3) * 0.06,
            animation: `cwFloat ${5 + (i % 4)}s ease-in-out ${(i * 0.6).toFixed(1)}s infinite`,
            filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))",
          }}
        >
          {e}
        </span>
      ))}
    </div>
  );
}

export function Decor() {
  // default ON (the owner asked for it); mounts after read to avoid SSR mismatch
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setOn(localStorage.getItem("cw_decor") !== "0");
    } catch {
      setOn(true);
    }
    setReady(true);
  }, []);

  function toggle() {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("cw_decor", next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  if (!ready) return null;

  return (
    <>
      {on && (
        <>
          <Column items={LEFT} side="left" />
          <Column items={RIGHT} side="right" />
        </>
      )}
      <button
        onClick={toggle}
        title={on ? "Hide beach decor" : "Show beach decor"}
        aria-label={on ? "Hide beach decor" : "Show beach decor"}
        className={`fixed bottom-3 right-3 z-30 rounded-full border border-neutral-700 bg-neutral-900/80 px-2 py-1 text-sm shadow-md backdrop-blur transition hover:bg-neutral-800 ${
          on ? "opacity-70" : "opacity-40"
        }`}
      >
        {on ? "🍹" : "🥥"}
      </button>
    </>
  );
}
