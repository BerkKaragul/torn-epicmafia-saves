"use client";

import { useEffect, useState } from "react";

const STEPS = [
  { icon: "🟢", text: "Open **My duty** → tap **“I can save”**." },
  { icon: "🔔", text: "Tap **Arm danger siren** so you hear the alarm." },
  { icon: "⏳", text: "Wait. When it’s **your turn**, the siren screams." },
  { icon: "🌍", text: "Attack **anyone abroad** — and **HOLD** the result page." },
  { icon: "✅", text: "Land the hit **under 1:00** = a save. You get paid." },
  { icon: "✈️", text: "Flying, hospital or jail? You’re **paused** — no worries." },
  { icon: "⏹️", text: "Done? Tap **Stop saving**." },
];

// tiny **bold** renderer so the steps stay readable in source
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

export function HowItWorks() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setOpen(localStorage.getItem("cw_guide_hidden") !== "1");
  }, []);

  function hide() {
    localStorage.setItem("cw_guide_hidden", "1");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-4 text-sm text-neutral-500 underline hover:text-neutral-300"
      >
        ❓ How does saving work?
      </button>
    );
  }

  return (
    <section className="mb-6 rounded-2xl border border-emerald-900 bg-emerald-950/20 p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold text-emerald-300">How to save — in 7 steps</h2>
        <button
          onClick={hide}
          className="ml-auto rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
        >
          Got it, hide ✕
        </button>
      </div>

      <ol className="mt-4 flex flex-col gap-3">
        {STEPS.map((s, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-900 text-sm font-bold text-emerald-200">
              {i + 1}
            </span>
            <span className="text-xl">{s.icon}</span>
            <span className="text-sm text-neutral-300">{render(s.text)}</span>
          </li>
        ))}
      </ol>

      <p className="mt-4 rounded-lg bg-neutral-900/70 px-3 py-2 text-xs text-neutral-400">
        💡 A <strong className="text-neutral-200">save</strong> = you stop the chain from dying.
        “Holding” the attack page keeps you on it longer, so the save is safer.
      </p>
    </section>
  );
}
