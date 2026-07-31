"use client";

import { useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";
import type { StatePayload } from "@/lib/state";
import { fmtClock } from "@/lib/format";
import { alarmInterval, armAlarm, playAlarm } from "@/lib/alarm";

export function LiveChain({ initial, myId }: { initial: StatePayload; myId: number }) {
  const [state, setState] = useState<StatePayload>(initial);
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  const [soundOn, setSoundOn] = useState(false);

  // remember the armed choice across navigation/reloads, shared with the duty
  // page via the same key (read in an effect to avoid an SSR hydration mismatch)
  useEffect(() => {
    if (localStorage.getItem("cw_siren") === "1") setSoundOn(true);
  }, []);

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

  // danger siren (armed by the user toggle — browsers require a gesture)
  useEffect(() => {
    if (!soundOn || !danger) return;
    playAlarm(critical);
    const id = setInterval(() => playAlarm(critical), alarmInterval(critical));
    return () => clearInterval(id);
  }, [soundOn, danger, critical]);

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
          onClick={() => {
            const next = !soundOn;
            if (next) {
              armAlarm();
              playAlarm(false); // let them hear exactly what's coming
            }
            localStorage.setItem("cw_siren", next ? "1" : "0");
            setSoundOn(next);
          }}
          className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
            soundOn
              ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
              : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {soundOn ? "🔊 Siren armed" : "🔇 Arm danger siren"}
        </button>
        <a
          href={`https://www.torn.com/factions.php?step=profile&ID=${state.faction_id}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-red-700 px-4 py-1.5 text-sm font-bold text-white hover:bg-red-600"
        >
          Open faction page ↗
        </a>
      </div>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">
          Savers on duty — rotation order
          {state.saver_cap > 0 && (
            <span
              className={`ml-2 text-sm font-semibold ${
                state.on_duty.length >= state.saver_cap ? "text-amber-400" : "text-neutral-500"
              }`}
            >
              {state.on_duty.length}/{state.saver_cap} slots
            </span>
          )}
        </h2>
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
                  {m.unavailable_state && (
                    <span className="ml-2 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs font-semibold text-amber-300">
                      {m.unavailable_state === "Traveling"
                        ? "✈ flying — can't save"
                        : `${m.unavailable_state} — can't save`}
                    </span>
                  )}
                </span>
                <span className="ml-auto text-xs text-neutral-500">
                  on duty {fmtClock(Math.max(0, nowS - m.started_at))}
                  {i === 0 && !m.unavailable_state && (
                    <span className="ml-2 font-semibold text-emerald-400">UP NEXT</span>
                  )}
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
