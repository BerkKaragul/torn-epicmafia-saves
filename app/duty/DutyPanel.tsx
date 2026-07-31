"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { currentPushStatus, disablePush, enablePush, type PushStatus } from "./push";
import { fmtClock, fmtDuration, fmtMoney } from "@/lib/format";
import { alarmInterval, armAlarm, playAlarm } from "@/lib/alarm";
import { supabaseBrowser } from "@/lib/supabase-browser";

interface Me {
  member: { torn_id: number; name: string; is_admin: boolean; key_valid: boolean };
  activeShift: {
    id: string;
    started_at: string;
    planned_minutes: number | null;
    hourly_rate_snapshot: number;
  } | null;
  rates: {
    hourly_rate: number;
    per_save_bonus: number;
    save_bonus_mode: "flat" | "scaled";
    current_hourly_rate: number;
    eligible_savers: number;
  } | null;
  saving_enabled: boolean;
  unpaid: { duty_seconds: number; hours_amount: number; save_count: number; saves_amount: number };
  chain_active: boolean;
  chain: {
    id: number;
    current: number;
    max: number;
    timeout_s: number;
    cooldown_s: number;
    observed_at: number;
  };
  alert_threshold_s: number;
  unavailable_state: string | null;
  missed_turns: number;
  slots: { cap: number; active: number };
}

export function DutyPanel() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planned, setPlanned] = useState<string>("");
  const [nowTick, setNowTick] = useState(Date.now());
  const [push, setPush] = useState<PushStatus>("unsupported");
  const [pushError, setPushError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [leaveMsg, setLeaveMsg] = useState("");
  const [sirenOn, setSirenOn] = useState(false);
  const sirenRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/me");
    if (res.ok) setMe(await res.json());
  }, []);

  useEffect(() => {
    load();
    currentPushStatus().then(setPush);
    const t = setInterval(() => setNowTick(Date.now()), 500);
    // refresh billable totals + live chain state periodically
    const r = setInterval(load, 20_000);
    // ...and immediately whenever the poller says something changed
    const channel = supabaseBrowser()
      ?.channel("chain")
      .on("broadcast", { event: "poke" }, () => load())
      .subscribe();
    return () => {
      clearInterval(t);
      clearInterval(r);
      channel?.unsubscribe();
    };
  }, [load]);

  async function togglePush() {
    setPushError(null);
    try {
      setPush(push === "on" ? await disablePush() : await enablePush());
    } catch (e) {
      setPushError(e instanceof Error ? e.message : "Push setup failed");
    }
  }

  async function startShift() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planned ? { plannedMinutes: Number(planned) } : {}),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function stopShift() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shifts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: leaveMsg }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error);
      setStopping(false);
      setLeaveMsg("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  // live chain countdown, extrapolated between poller updates
  const nowS = Math.floor(nowTick / 1000);
  const chainLive = !!me && me.chain.id > 0 && me.chain.current > 0 && me.chain.cooldown_s === 0;
  const chainRemaining =
    me && chainLive ? Math.max(0, me.chain.timeout_s - (nowS - me.chain.observed_at)) : 0;
  const chainDanger = !!me && chainLive && chainRemaining <= me.alert_threshold_s;
  const chainCritical = chainLive && chainRemaining <= 45;

  // siren while the chain is in danger (armed by the user, browsers require it)
  useEffect(() => {
    if (sirenRef.current) {
      clearInterval(sirenRef.current);
      sirenRef.current = null;
    }
    if (!sirenOn || !chainDanger) return;
    playAlarm(chainCritical);
    sirenRef.current = setInterval(() => playAlarm(chainCritical), alarmInterval(chainCritical));
    return () => {
      if (sirenRef.current) clearInterval(sirenRef.current);
      sirenRef.current = null;
    };
  }, [sirenOn, chainDanger, chainCritical]);

  if (!me) return <p className="text-neutral-500">Loading…</p>;

  const shift = me.activeShift;
  const elapsedS = shift ? (nowTick - new Date(shift.started_at).getTime()) / 1000 : 0;
  const plannedS = shift?.planned_minutes ? shift.planned_minutes * 60 : null;
  const remainingS = plannedS ? Math.max(0, plannedS - elapsedS) : null;

  return (
    <div className="flex flex-col gap-6">
      <section
        className={`rounded-xl border p-4 transition-colors ${
          chainDanger
            ? "animate-pulse border-red-600 bg-red-950/60"
            : chainLive
              ? "border-emerald-800 bg-neutral-900"
              : "border-neutral-800 bg-neutral-900"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {chainLive ? (
            <>
              <span
                className={`text-4xl font-black tabular-nums ${
                  chainCritical
                    ? "text-red-400"
                    : chainDanger
                      ? "text-amber-400"
                      : "text-emerald-400"
                }`}
              >
                {fmtClock(chainRemaining)}
              </span>
              <span className="text-sm text-neutral-400">
                chain <span className="font-bold text-neutral-200">{me.chain.current.toLocaleString()}</span>
                {me.chain.max > 0 && ` / ${me.chain.max.toLocaleString()}`}
              </span>
              {chainDanger && (
                <span className="rounded bg-red-800 px-2 py-1 text-sm font-bold text-white">
                  SAVE NEEDED
                </span>
              )}
            </>
          ) : (
            <span className="text-sm text-neutral-400">
              {me.chain.cooldown_s > 0 ? "Chain on cooldown" : "No chain running"}
            </span>
          )}
          <button
            onClick={() => {
              const next = !sirenOn;
              if (next) {
                armAlarm();
                playAlarm(false);
              }
              setSirenOn(next);
            }}
            className={`ml-auto rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
              sirenOn
                ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
                : "border-neutral-700 text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {sirenOn ? "🔊 Siren armed" : "🔇 Arm danger siren"}
          </button>
        </div>
      </section>

      {!me.saving_enabled && (
        <section className="rounded-xl border border-red-800 bg-red-950/40 p-4">
          <p className="font-bold text-red-300">Saving is switched off right now</p>
          <p className="mt-1 text-sm text-neutral-400">
            The admins have paused saver duty — you can&apos;t enlist and no pay accrues until
            it&apos;s turned back on.
          </p>
        </section>
      )}

      {me.unavailable_state && (
        <section className="rounded-xl border border-amber-700 bg-amber-950/40 p-4">
          <p className="font-bold text-amber-300">
            {me.unavailable_state === "Traveling"
              ? "✈ You're flying — you can't save right now"
              : `You're in ${me.unavailable_state} — you can't save right now`}
          </p>
          <p className="mt-1 text-sm text-neutral-400">
            You keep your place in the queue, but the turn skips you and your pay clock is
            paused until you&apos;re back.
          </p>
        </section>
      )}

      {shift ? (
        <section className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-6">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
            <h2 className="text-lg font-bold text-emerald-300">You are ON DUTY</h2>
          </div>
          <p className="mt-3 text-4xl font-bold tabular-nums">{fmtDuration(elapsedS)}</p>
          <p className="mt-1 text-sm text-neutral-400">
            on duty · {fmtMoney(me.rates?.current_hourly_rate ?? 0)}/h right now
            {(me.rates?.eligible_savers ?? 0) > 2 && (
              <span className="text-amber-400">
                {" "}
                (split {me.rates?.eligible_savers} ways)
              </span>
            )}{" "}
            while a chain is live
            {remainingS !== null && (
              <> · auto-ends in <span className="tabular-nums">{fmtDuration(remainingS)}</span></>
            )}
          </p>
          <div
            className={`mt-3 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold ${
              me.chain_active
                ? "bg-emerald-900/60 text-emerald-300"
                : "bg-neutral-800 text-neutral-400"
            }`}
          >
            {me.chain_active ? (
              <>🟢 Chain live — your pay clock is running</>
            ) : (
              <>⏸ No chain right now — availability pay is paused</>
            )}
          </div>
          {stopping ? (
            <div className="mt-4 rounded-lg border border-red-900 bg-red-950/30 p-3">
              <p className="text-sm font-medium text-red-300">
                Leaving duty — warn the other savers?
              </p>
              <input
                value={leaveMsg}
                onChange={(e) => setLeaveMsg(e.target.value)}
                maxLength={200}
                placeholder="Optional urgent note, e.g. “can't save anymore, react fast!”"
                className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Sent as a push to everyone still on duty (always sent if you leave while it&apos;s
                your turn).
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={stopShift}
                  disabled={busy}
                  className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40"
                >
                  Confirm — stop saving
                </button>
                <button
                  onClick={() => setStopping(false)}
                  disabled={busy}
                  className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300 hover:bg-neutral-800"
                >
                  Keep saving
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setStopping(true)}
              disabled={busy}
              className="mt-4 rounded-md bg-red-700 px-4 py-2 font-semibold text-white transition hover:bg-red-600 disabled:opacity-40"
            >
              Stop saving
            </button>
          )}
        </section>
      ) : (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-bold">
            Enlist as a saver
            {me.slots.cap > 0 && (
              <span
                className={`ml-2 text-sm font-semibold ${
                  me.slots.active >= me.slots.cap ? "text-red-400" : "text-neutral-500"
                }`}
              >
                {me.slots.active}/{me.slots.cap} slots
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-neutral-400">
            Posted rate: {fmtMoney(me.rates?.hourly_rate ?? 0)}/hour (1–2 savers get it in full;
            3+ share double that) +{" "}
            {(me.rates?.per_save_bonus ?? 0) > 0 ? (
              <>
                {fmtMoney(me.rates?.per_save_bonus ?? 0)} per save
                {me.rates?.save_bonus_mode === "scaled" && (
                  <span className="text-amber-400"> (scales with chain size — ×chain/100)</span>
                )}
              </>
            ) : (
              <span className="text-amber-300">a save bonus based on the war reward</span>
            )}
            .
          </p>
          {me.slots.cap > 0 && me.slots.active >= me.slots.cap && (
            <p className="mt-2 text-sm text-amber-400">
              All saver slots are taken — the button unlocks when someone stops.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select
              value={planned}
              onChange={(e) => setPlanned(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">No time limit</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="180">3 hours</option>
              <option value="240">4 hours</option>
              <option value="360">6 hours</option>
              <option value="480">8 hours</option>
            </select>
            <button
              onClick={startShift}
              disabled={
                busy ||
                !me.saving_enabled ||
                (me.slots.cap > 0 && me.slots.active >= me.slots.cap)
              }
              className="rounded-md bg-emerald-600 px-5 py-2 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              I can save — start
            </button>
          </div>
        </section>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-lg font-bold">Alerts</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Get a push notification when it&apos;s your turn to save or the chain timer runs low —
          works even with the site closed.
        </p>
        {push === "unsupported" ? (
          <p className="mt-3 text-sm text-neutral-500">
            This browser doesn&apos;t support push notifications.
          </p>
        ) : push === "denied" ? (
          <p className="mt-3 text-sm text-amber-400">
            Notifications are blocked for this site — allow them in your browser settings, then
            reload.
          </p>
        ) : (
          <button
            onClick={togglePush}
            className={`mt-3 rounded-md border px-4 py-2 text-sm font-semibold transition ${
              push === "on"
                ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
                : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            {push === "on" ? "🔔 Notifications ON — click to disable" : "Enable notifications"}
          </button>
        )}
        {pushError && <p className="mt-2 text-sm text-red-400">{pushError}</p>}
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-lg font-bold">Owed to you (unpaid)</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Availability pay counts only time a chain was actually live — dead peacetime while
          you&apos;re enlisted doesn&apos;t pay.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-2xl font-bold tabular-nums">
              {fmtDuration(me.unpaid.duty_seconds)}
            </p>
            <p className="text-xs text-neutral-500">paid on-chain time</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums">{fmtMoney(me.unpaid.hours_amount)}</p>
            <p className="text-xs text-neutral-500">for availability</p>
          </div>
          <div>
            <p className="text-2xl font-bold tabular-nums">{me.unpaid.save_count}</p>
            <p className="text-xs text-neutral-500">saves confirmed</p>
          </div>
          <div>
            {(me.rates?.per_save_bonus ?? 0) > 0 ? (
              <>
                <p className="text-2xl font-bold tabular-nums">
                  {fmtMoney(me.unpaid.saves_amount)}
                </p>
                <p className="text-xs text-neutral-500">for saves</p>
              </>
            ) : (
              <>
                <p className="text-lg font-bold text-amber-300">war reward</p>
                <p className="text-xs text-neutral-500">save bonus paid from it</p>
              </>
            )}
          </div>
          <div>
            <p
              className={`text-2xl font-bold tabular-nums ${me.missed_turns > 0 ? "text-red-400" : ""}`}
            >
              {me.missed_turns}
            </p>
            <p className="text-xs text-neutral-500">chains lost on your turn</p>
          </div>
        </div>
      </section>
    </div>
  );
}
