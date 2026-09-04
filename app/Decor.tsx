"use client";

import { useEffect, useState } from "react";

// Decorative random cat GIFs in the four corners, pulled live from Giphy. Fixed,
// pointer-events-none and only mounted on wide screens (phones skip the fetch
// entirely). Per-device on/off (localStorage) via a small toggle. If Giphy is
// unreachable/rate-limited we simply show nothing — never a broken image.
//
// Uses Giphy's public beta key by default; set NEXT_PUBLIC_GIPHY_KEY in Vercel
// for your own (higher, more reliable rate limits).
const GIPHY_KEY = process.env.NEXT_PUBLIC_GIPHY_KEY || "dc6zaTOxFJmzC";
const CORNERS = ["top-2 left-2", "top-2 right-2", "bottom-2 left-2", "bottom-2 right-2"];

interface GiphyItem {
  images?: { fixed_height?: { url?: string } };
}
interface GiphyResp {
  data?: GiphyItem[];
}

export function Decor() {
  const [on, setOn] = useState(false);
  const [wide, setWide] = useState(false);
  const [ready, setReady] = useState(false);
  const [gifs, setGifs] = useState<string[]>([]);

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

  // pull a fresh random set once we know we'll actually show them
  useEffect(() => {
    if (!ready || !wide || !on || gifs.length) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=cat&limit=50&rating=g&bundle=fixed_height`,
        );
        const json: GiphyResp = await res.json();
        const urls = (json.data ?? [])
          .map((g) => g.images?.fixed_height?.url)
          .filter((u): u is string => typeof u === "string");
        for (let i = urls.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [urls[i], urls[j]] = [urls[j], urls[i]];
        }
        if (alive) setGifs(urls.slice(0, 4));
      } catch {
        /* offline / rate-limited — show nothing */
      }
    })();
    return () => {
      alive = false;
    };
  }, [ready, wide, on, gifs.length]);

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
      {on &&
        wide &&
        gifs.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={src}
            alt=""
            aria-hidden
            className={`cw-float pointer-events-none fixed z-0 w-24 rounded-xl xl:w-32 ${CORNERS[i]}`}
            style={{
              ["--cw-rot" as string]: `${(i % 2 === 0 ? -1 : 1) * 3}deg`,
              opacity: 0.9,
              animation: `cwFloat ${6 + (i % 3)}s ease-in-out ${(i * 0.7).toFixed(1)}s infinite`,
              filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.55))",
            }}
          />
        ))}
      {wide && (
        <button
          onClick={toggle}
          title={on ? "Hide the cat GIFs (remembered on this device)" : "Show the cat GIFs"}
          aria-label={on ? "Hide the cat GIFs" : "Show the cat GIFs"}
          className={`fixed bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-neutral-700 bg-neutral-900/85 px-2.5 py-1 text-xs font-medium text-neutral-300 shadow-md backdrop-blur transition hover:bg-neutral-800 ${
            on ? "opacity-80" : "opacity-60"
          }`}
        >
          {on ? "🐱 Hide cats" : "🐱 Show cats"}
        </button>
      )}
    </>
  );
}
