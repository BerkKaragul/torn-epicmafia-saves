"use client";

import { useEffect, useState } from "react";
import { fmtMoney, fmtTct } from "@/lib/format";

const STEPS = [
  { icon: "🎃", text: "Tap **“I can save — start”** below. From **Torn City** or abroad — both count." },
  { icon: "🔔", text: "**Arm the danger siren** so you hear when it’s your turn." },
  { icon: "⏳", text: "When it’s **your turn** and the timer is low, hit **anyone** and beat them." },
  { icon: "✋", text: "**HOLD** the result screen — don’t Leave/Mug/Hospitalize yet." },
  { icon: "✅", text: "Land it **under the save line** = a save, paid at the event rate." },
  { icon: "✈️", text: "Flying, hospital or jail? You’re **paused** — no pay, no turn." },
];

function render(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") ? (
      <strong key={i} className="font-semibold text-neutral-100">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function EventHero({
  name,
  startedAt,
  endsAt,
  saveBonus,
  running,
}: {
  name: string;
  startedAt: string;
  endsAt: string;
  saveBonus: number;
  running: boolean;
}) {
  // null until mounted, so server and client render the same first frame
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = now === null ? null : Date.parse(endsAt) - now;
  const live = running && (left === null || left > 0);

  return (
    <section className="relative overflow-hidden rounded-2xl border-2 border-orange-600 bg-gradient-to-b from-[#24102e] to-[#120a1a] p-6 shadow-[0_0_40px_rgba(234,88,12,0.25)]">
      <span aria-hidden className="absolute -right-3 -top-4 text-7xl opacity-25">
        🕸️
      </span>
      <p className="text-4xl" aria-hidden>
        🎃🦇👻
      </p>
      <h1 className="cw-flicker mt-2 text-3xl font-black tracking-tight text-orange-400 sm:text-4xl">
        {name}
      </h1>
      {live ? (
        <>
          <p className="mt-2 text-sm text-neutral-300">
            Paid chain saving with no war. Saves in <strong className="text-orange-300">Torn City</strong>{" "}
            count too. {fmtMoney(saveBonus)} per save + hourly pay while a chain is live.
          </p>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              ends in
            </span>
            <span className="text-3xl font-black tabular-nums text-neutral-50">
              {left === null ? "—" : countdown(left)}
            </span>
            <span className="text-xs text-neutral-500">{fmtTct(endsAt)}</span>
          </div>
          <ol className="mt-5 flex flex-col gap-2.5">
            {STEPS.map((s, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-900 text-xs font-bold text-orange-100">
                  {i + 1}
                </span>
                <span className="text-lg" aria-hidden>
                  {s.icon}
                </span>
                <span className="text-sm text-neutral-300">{render(s.text)}</span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-2 text-sm text-neutral-300">
          The event is over ({fmtTct(startedAt)} → {fmtTct(endsAt)}). Normal saving is back on
          the My duty page. Final numbers are below.
        </p>
      )}
    </section>
  );
}
