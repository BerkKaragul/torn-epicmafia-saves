"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import type { StatePayload } from "@/lib/state";
import { fmtClock } from "@/lib/format";

export function LiveChain({ initial, myId }: { initial: StatePayload; myId: number }) {
  const [state, setState] = useState<StatePayload>(initial);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const [soundOn, setSoundOn] = useState(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const lastBeep = useRef(0);

  // Realtime "poke" → re-fetch the authenticated /api/state. The public
  // channel carries no data, so a forged broadcast can waste a fetch but can
  // never spoof chain state; the 30s poll runs only while the socket is down.
  const channelUp = useRef(false);
  useEffect(() => {
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchState = async () => {
      try {
        const res = await fetch("/api/state");
        if (res.ok) setState(await res.json());
      } catch {
        /* offline; keep extrapolating */
      }
    };
    const debouncedFetch = () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(fetchState, 300);
    };

    const sb = supabaseBrowser();
    const channel = sb
      ?.channel("chain")
      .on("broadcast", { event: "poke" }, debouncedFetch)
      .subscribe((status) => {
        channelUp.current = status === "SUBSCRIBED";
        if (status === "SUBSCRIBED") debouncedFetch();
      });
    const poll = setInterval(() => {
      if (!channelUp.current) fetchState();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") debouncedFetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      channel?.unsubscribe();
      clearInterval(poll);
      if (refetchTimer) clearTimeout(refetchTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // 4 fps local tick keeps the countdown smooth between polls
  useEffect(() => {
    const t = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 250);
    return () => clearInterval(t);
  }, []);

  const chainActive = state.chain.id > 0 && state.chain.current > 0;
  const elapsed = Math.max(0, nowS - state.chain.observed_at);
  const remaining = chainActive ? Math.max(0, state.chain.timeout_s - elapsed) : 0;
  const cooldownLeft = Math.max(0, state.chain.cooldown_s - elapsed);
  const danger = chainActive && remaining <= state.alert_threshold_s;
  const critical = chainActive && remaining <= 45;
  const pollerStale = state.poller_at === null || nowS - state.poller_at > 90;
  const myTurn = state.turn_member_id === myId;

  // tab title
  useEffect(() => {
    document.title = chainActive
      ? `(${fmtClock(remaining)}) ${state.chain.current} CHAIN`
      : "ChainWatch — EPIC Mafia";
  }, [chainActive, remaining, state.chain.current]);

  // danger beep (armed by the user toggle — browsers require a gesture)
  useEffect(() => {
    if (!soundOn || !danger) return;
    const now = Date.now();
    if (now - lastBeep.current < 2000) return;
    lastBeep.current = now;
    try {
      audioCtx.current ??= new AudioContext();
      const ctx = audioCtx.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = critical ? 1100 : 780;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch {
      /* audio unavailable */
    }
  }, [soundOn, danger, critical, nowS]);

  return (
    <div className="flex flex-col gap-4">
      {pollerStale && (
        <div className="rounded-md border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm text-amber-300">
          ⚠ The chain poller hasn&apos;t reported in a while — numbers may be stale.
        </div>
      )}

      <section
        className={`rounded-2xl border p-8 text-center transition-colors ${
          danger
            ? "animate-pulse border-red-600 bg-red-950/60"
            : chainActive
              ? "border-emerald-800 bg-neutral-900"
              : "border-neutral-800 bg-neutral-900"
        }`}
      >
        {chainActive ? (
          <>
            <p className="text-sm uppercase tracking-widest text-neutral-400">Chain</p>
            <p className="mt-1 text-6xl font-black tabular-nums">
              {state.chain.current.toLocaleString()}
              {state.chain.max > 0 && (
                <span className="text-2xl font-semibold text-neutral-500">
                  {" "}
                  / {state.chain.max.toLocaleString()}
                </span>
              )}
            </p>
            <p
              className={`mt-4 text-7xl font-black tabular-nums ${
                critical ? "text-red-400" : danger ? "text-amber-400" : "text-emerald-400"
              }`}
            >
              {fmtClock(remaining)}
            </p>
            {danger && (
              <p className="mt-2 text-lg font-bold text-red-300">
                {myTurn ? "🚨 YOUR TURN — GO SAVE!" : "Timer low — saver needed!"}
              </p>
            )}
          </>
        ) : cooldownLeft > 0 ? (
          <>
            <p className="text-sm uppercase tracking-widest text-neutral-400">Chain cooldown</p>
            <p className="mt-3 text-5xl font-black tabular-nums text-sky-400">
              {fmtClock(cooldownLeft)}
            </p>
            <p className="mt-2 text-sm text-neutral-500">No chain can start until this ends.</p>
          </>
        ) : (
          <>
            <p className="text-sm uppercase tracking-widest text-neutral-400">No active chain</p>
            <p className="mt-3 text-2xl font-bold text-neutral-300">
              Timer starts with the first hits.
            </p>
          </>
        )}
      </section>

      <div className="flex items-center justify-between">
        <button
          onClick={() => setSoundOn((v) => !v)}
          className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
            soundOn
              ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
              : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {soundOn ? "🔊 Alarm armed" : "🔇 Arm alarm sound"}
        </button>
        <a
          href="https://www.torn.com/loader.php?sid=attack"
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-red-700 px-4 py-1.5 text-sm font-bold text-white hover:bg-red-600"
        >
          Open Torn attack page ↗
        </a>
      </div>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">Savers on duty — rotation order</h2>
        {state.on_duty.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nobody is enlisted right now. Go to <span className="font-medium">My duty</span> to
            start a shift.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {state.on_duty.map((m, i) => (
              <li
                key={m.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  i === 0
                    ? "border-emerald-700 bg-emerald-950/40"
                    : "border-neutral-800 bg-neutral-950"
                }`}
              >
                <span
                  className={`w-6 text-center font-bold ${i === 0 ? "text-emerald-400" : "text-neutral-600"}`}
                >
                  {i === 0 ? "▶" : i + 1}
                </span>
                <span className="font-medium">
                  {m.name}
                  {m.id === myId && <span className="ml-1.5 text-xs text-emerald-500">(you)</span>}
                </span>
                <span className="ml-auto text-xs text-neutral-500">
                  on duty {fmtClock(Math.max(0, nowS - m.started_at))}
                  {i === 0 && <span className="ml-2 font-semibold text-emerald-400">UP NEXT</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {state.last_save && (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-sm">
          <h2 className="font-bold">Last save</h2>
          <p className="mt-1 text-neutral-400">
            Hit #{state.last_save.chain_count.toLocaleString()}
            {state.last_save.remaining_at_hit_s !== null && (
              <>
                {" "}
                with{" "}
                <span className="font-semibold text-amber-300">
                  {Math.max(0, Math.round(state.last_save.remaining_at_hit_s))}s
                </span>{" "}
                on the clock
              </>
            )}
            {state.last_save.status === "unattributed" && " — by a non-enlisted member"}
          </p>
        </section>
      )}
    </div>
  );
}
