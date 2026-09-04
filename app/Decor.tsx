"use client";

import { useEffect, useState } from "react";

// Purely decorative animated GIFs down the empty side gutters. Fixed,
// pointer-events-none and only mounted on wide screens (so phones never fetch
// the ~1.5MB files or get them over the UI). Per-device on/off (localStorage)
// via a tiny corner toggle, since this is a shared tool and not everyone wants
// the garnish.

// served from /public/decor
const LEFT = ["/decor/babe.gif", "/decor/kiss.gif"];
const RIGHT = ["/decor/dancing.gif", "/decor/love.gif"];

function Column({ items, side }: { items: string[]; side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed top-0 z-0 flex h-full w-24 select-none flex-col items-center justify-around py-10 xl:w-32 ${
        side === "left" ? "left-0" : "right-0"
      }`}
    >
      {items.map((src, i) => (
        <img
          key={`${side}-${i}`}
          src={src}
          alt=""
          className="cw-float w-full rounded-xl"
          style={{
            ["--cw-rot" as string]: `${(i % 2 === 0 ? -1 : 1) * 3}deg`,
            opacity: 0.85,
            animation: `cwFloat ${6 + (i % 3)}s ease-in-out ${(i * 0.8).toFixed(1)}s infinite`,
            filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.55))",
          }}
        />
      ))}
    </div>
  );
}

export function Decor() {
  // default ON (the owner asked for it); only show on wide screens so phones
  // don't download the GIFs or collide with the content
  const [on, setOn] = useState(false);
  const [wide, setWide] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setOn(localStorage.getItem("cw_decor") !== "0");
    } catch {
      setOn(true);
    }
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    setReady(true);
    return () => mq.removeEventListener("change", sync);
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
      {on && wide && (
        <>
          <Column items={LEFT} side="left" />
          <Column items={RIGHT} side="right" />
        </>
      )}
      {wide && (
        <button
          onClick={toggle}
          title={on ? "Hide the GIFs (remembered on this device)" : "Show the GIFs"}
          aria-label={on ? "Hide the GIFs" : "Show the GIFs"}
          className={`fixed bottom-3 right-3 z-30 flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900/85 px-2.5 py-1 text-xs font-medium text-neutral-300 shadow-md backdrop-blur transition hover:bg-neutral-800 ${
            on ? "opacity-80" : "opacity-60"
          }`}
        >
          {on ? "🌴 Hide GIFs" : "🥥 Show GIFs"}
        </button>
      )}
    </>
  );
}
