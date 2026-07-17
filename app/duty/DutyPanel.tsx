"use client";

import { useCallback, useEffect, useState } from "react";
import { currentPushStatus, disablePush, enablePush, type PushStatus } from "./push";

interface Me {
  member: { torn_id: number; name: string; is_admin: boolean; key_valid: boolean };
  activeShift: {
    id: string;
    started_at: string;
    planned_minutes: number | null;
    hourly_rate_snapshot: number;
  } | null;
  rates: { hourly_rate: number; per_save_bonus: number } | null;
  unpaid: { duty_seconds: number; hours_amount: number; save_count: number; saves_amount: number };
}

const fmtMoney = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

function fmtDuration(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function DutyPanel() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planned, setPlanned] = useState<string>("");
  const [nowTick, setNowTick] = useState(Date.now());
  const [push, setPush] = useState<PushStatus>("unsupported");
  const [pushError, setPushError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/me");
    if (res.ok) setMe(await res.json());
  }, []);

  useEffect(() => {
    load();
    currentPushStatus().then(setPush);
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
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
      const res = await fetch("/api/shifts", { method: "PATCH" });
      const body = await res.json();
      if (!res.ok) setError(body.error);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <p className="text-neutral-500">Loading…</p>;

  const shift = me.activeShift;
  const elapsedS = shift ? (nowTick - new Date(shift.started_at).getTime()) / 1000 : 0;
  const plannedS = shift?.planned_minutes ? shift.planned_minutes * 60 : null;
  const remainingS = plannedS ? Math.max(0, plannedS - elapsedS) : null;
  const liveEarned = shift ? (elapsedS / 3600) * Number(shift.hourly_rate_snapshot) : 0;

  return (
    <div className="flex flex-col gap-6">
      {shift ? (
        <section className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-6">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />
            <h2 className="text-lg font-bold text-emerald-300">You are ON DUTY</h2>
          </div>
          <p className="mt-3 text-4xl font-bold tabular-nums">{fmtDuration(elapsedS)}</p>
          <p className="mt-1 text-sm text-neutral-400">
            earning {fmtMoney(shift.hourly_rate_snapshot)}/h · {fmtMoney(liveEarned)} so far this
            shift
            {remainingS !== null && (
              <> · auto-ends in <span className="tabular-nums">{fmtDuration(remainingS)}</span></>
            )}
          </p>
          <button
            onClick={stopShift}
            disabled={busy}
            className="mt-4 rounded-md bg-red-700 px-4 py-2 font-semibold text-white transition hover:bg-red-600 disabled:opacity-40"
          >
            Stop saving
          </button>
        </section>
      ) : (
        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-bold">Enlist as a saver</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Current rate: {fmtMoney(me.rates?.hourly_rate ?? 0)}/hour on duty +{" "}
            {fmtMoney(me.rates?.per_save_bonus ?? 0)} per save.
          </p>
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
              disabled={busy}
              className="rounded-md bg-emerald-600 px-5 py-2 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
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
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-2xl font-bold tabular-nums">
              {fmtDuration(me.unpaid.duty_seconds)}
            </p>
            <p className="text-xs text-neutral-500">duty time</p>
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
            <p className="text-2xl font-bold tabular-nums">{fmtMoney(me.unpaid.saves_amount)}</p>
            <p className="text-xs text-neutral-500">for saves</p>
          </div>
        </div>
      </section>
    </div>
  );
}
