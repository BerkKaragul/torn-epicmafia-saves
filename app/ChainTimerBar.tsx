"use client";

// Compact live chain timer, reusable on any page. Reads the shared /api/state,
// reacts to the poller's realtime "poke", and extrapolates the countdown
// between updates so it ticks smoothly.

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { fmtClock } from "@/lib/format";
import type { StatePayload } from "@/lib/state";

export function ChainTimerBar() {
  const [state, setState] = useState<StatePayload | null>(null);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const fetchState = async () => {
      try {
        const res = await fetch("/api/state");
        if (res.ok) setState(await res.json());
      } catch {
        /* keep extrapolating */
      }
    };
    fetchState();
    const channel = supabaseBrowser()
      ?.channel("chain")
      .on("broadcast", { event: "poke" }, fetchState)
      .subscribe();
    const poll = setInterval(fetchState, 30_000);
    const tick = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 250);
    return () => {
      channel?.unsubscribe();
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  if (!state) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3 text-sm text-neutral-500">
        Loading chain…
      </div>
    );
  }

  const live = state.chain.id > 0 && state.chain.current > 0 && state.chain.cooldown_s === 0;
  const elapsed = Math.max(0, nowS - state.chain.observed_at);
  const remaining = live ? Math.max(0, state.chain.timeout_s - elapsed) : 0;
  const cooldown = Math.max(0, state.chain.cooldown_s - elapsed);
  const danger = live && remaining <= state.alert_threshold_s;
  const critical = live && remaining <= 45;
  const stale = state.poller_at === null || nowS - state.poller_at > 90;
  const onDuty = state.on_duty.filter((m) => !m.unavailable_state).length;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border p-3 transition-colors ${
        danger
          ? "animate-pulse border-red-600 bg-red-950/60"
          : live
            ? "border-emerald-800 bg-neutral-900"
            : "border-neutral-800 bg-neutral-900"
      }`}
    >
      {live ? (
        <>
          <span
            className={`text-3xl font-black tabular-nums ${
              critical ? "text-red-400" : danger ? "text-amber-400" : "text-emerald-400"
            }`}
          >
            {fmtClock(remaining)}
          </span>
          <span className="text-sm text-neutral-400">
            chain{" "}
            <span className="font-bold text-neutral-200">
              {state.chain.current.toLocaleString()}
            </span>
            {state.chain.max > 0 && ` / ${state.chain.max.toLocaleString()}`}
          </span>
          {danger && (
            <span className="rounded bg-red-800 px-2 py-0.5 text-sm font-bold text-white">
              SAVE NEEDED
            </span>
          )}
        </>
      ) : cooldown > 0 ? (
        <span className="text-sm text-neutral-400">
          Chain cooldown <span className="font-bold text-sky-400">{fmtClock(cooldown)}</span>
        </span>
      ) : (
        <span className="text-sm text-neutral-400">No chain running</span>
      )}
      <span className="ml-auto text-xs text-neutral-500">
        {onDuty} saver{onDuty === 1 ? "" : "s"} on duty
        {stale && <span className="ml-2 text-amber-400">⚠ poller stale</span>}
      </span>
    </div>
  );
}
