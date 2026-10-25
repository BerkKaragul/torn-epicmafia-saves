"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtMoney, fmtTct } from "@/lib/format";

// Event mode switch (migration 0042). An event pays saving without a ranked war
// for a fixed window; while it runs Torn City saves count, normal /duty sends
// people to /event, and the site wears the event theme.

interface EventInfo {
  id: number;
  name: string;
  started_at: string;
  ends_at: string;
  ended_at: string | null;
  save_bonus: number;
  payout_saved_at: string | null;
}

// first use: Halloween 2026 ends 1 Nov 16:00 TCT
const DEFAULT_NAME = "Halloween Event";
const DEFAULT_END_TCT = "2026-11-01T16:00";

/** datetime-local value (read as TCT = UTC) ⇄ ISO */
const tctInputToIso = (v: string) => (v ? new Date(`${v}:00Z`).toISOString() : "");
const isoToTctInput = (iso: string) => iso.slice(0, 16);

export function EventControl({
  defaultSaveBonus,
  onChange,
}: {
  defaultSaveBonus: number;
  onChange: () => void;
}) {
  const [event, setEvent] = useState<EventInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(DEFAULT_NAME);
  const [endTct, setEndTct] = useState(DEFAULT_END_TCT);
  const [bonus, setBonus] = useState(String(defaultSaveBonus ?? 0));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // two-tap confirmation (native confirm() can be silently disabled)
  const [armed, setArmed] = useState<"start" | "end" | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/event");
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setEvent(body.event ?? null);
      setRunning(Boolean(body.running));
      if (body.event && body.running) {
        setEndTct(isoToTctInput(body.event.ends_at));
        setBonus(String(body.event.save_bonus));
      }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function send(method: "POST" | "PATCH", payload: Record<string, unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/event", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? ok : (body.error ?? "Failed"));
      await load();
      onChange();
    } finally {
      setBusy(false);
    }
  }

  function start() {
    if (armed !== "start") return setArmed("start");
    setArmed(null);
    send(
      "POST",
      { name, ends_at: tctInputToIso(endTct), save_bonus: Number(bonus) },
      "Event started 🎃 — members are being sent to /event",
    );
  }

  function endNow() {
    if (armed !== "end") return setArmed("end");
    setArmed(null);
    send("PATCH", { end_now: true }, "Event ended — normal saving is back");
  }

  if (!loaded) return null;

  const input =
    "mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm";

  return (
    <section
      className={`rounded-xl border-2 p-5 ${
        running ? "border-orange-600 bg-orange-950/30" : "border-neutral-800 bg-neutral-900"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-bold">🎃 Event mode {running ? "is ON" : "is off"}</h2>
        {running && (
          <Link href="/event" className="text-xs text-orange-300 underline">
            open event page →
          </Link>
        )}
      </div>

      {running && event ? (
        <>
          <p className="mt-1 text-xs text-neutral-400">
            <strong className="text-neutral-200">{event.name}</strong> · started{" "}
            {fmtTct(event.started_at)} · ends {fmtTct(event.ends_at)} ·{" "}
            {fmtMoney(event.save_bonus)} per save. Torn City saves count; members enlist on
            /event. When it ends, event shifts close and normal saving returns by itself.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <label className="text-sm">
              <span className="text-neutral-400">Ends at (TCT)</span>
              <input
                type="datetime-local"
                value={endTct}
                onChange={(e) => setEndTct(e.target.value)}
                className={input}
              />
            </label>
            <label className="text-sm">
              <span className="text-neutral-400">$ per save (event)</span>
              <input
                type="number"
                min={0}
                value={bonus}
                onChange={(e) => setBonus(e.target.value)}
                className={input}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() =>
                send(
                  "PATCH",
                  { ends_at: tctInputToIso(endTct), save_bonus: Number(bonus) },
                  "Event updated ✔",
                )
              }
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Save changes
            </button>
            <button
              disabled={busy}
              onClick={endNow}
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40"
            >
              {armed === "end" ? "Tap again — end the event now" : "End event now"}
            </button>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            The $ per save applies to every save in the event, past ones included, until the
            payout is frozen on the event page.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-neutral-400">
            Pays saving without a ranked war until the end time: hourly pay while a chain is live
            (current $/hour above) plus a flat $ per save, with Torn City saves counting. Starting
            ends every open shift (savers re-enlist on /event), turns saving ON, and puts the
            site in its Halloween look.
            {event && !running && (
              <>
                {" "}
                Last event: {event.name} ({fmtTct(event.started_at)} →{" "}
                {fmtTct(event.ended_at ?? event.ends_at)})
                {event.payout_saved_at ? " — payout published." : " — "}
                {!event.payout_saved_at && (
                  <Link href="/event" className="text-orange-300 underline">
                    freeze its payout
                  </Link>
                )}
              </>
            )}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <label className="text-sm">
              <span className="text-neutral-400">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
            </label>
            <label className="text-sm">
              <span className="text-neutral-400">Ends at (TCT)</span>
              <input
                type="datetime-local"
                value={endTct}
                onChange={(e) => setEndTct(e.target.value)}
                className={input}
              />
            </label>
            <label className="text-sm">
              <span className="text-neutral-400">$ per save (event)</span>
              <input
                type="number"
                min={0}
                value={bonus}
                onChange={(e) => setBonus(e.target.value)}
                className={input}
              />
            </label>
          </div>
          <button
            disabled={busy || !name.trim() || !endTct}
            onClick={start}
            className="mt-3 rounded-md bg-orange-600 px-5 py-2.5 font-bold text-white hover:bg-orange-500 disabled:opacity-40"
          >
            {armed === "start" ? "Tap again — start it now" : "🎃 Start event now"}
          </button>
        </>
      )}
      {msg && <p className="mt-2 text-sm text-amber-300">{msg}</p>}
    </section>
  );
}
