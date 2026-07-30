"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  COMMON_TIMEZONES,
  dayKeyInZone,
  detectTimeZone,
  formatTimeInZone,
  hourBoundaryUtc,
  labelDay,
  tzLabel,
  zonedTimeToUtc,
} from "@/lib/tz";

interface Slot {
  id: string;
  member_id: number;
  name: string;
  start_at: string;
  end_at: string;
  mine: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export function SchedulePanel({ myId }: { myId: number }) {
  const [tz, setTz] = useState("UTC");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [date, setDate] = useState("");
  const [startT, setStartT] = useState("20:00");
  const [endT, setEndT] = useState("21:00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // pick up the browser's timezone (or the saved override) on mount
  useEffect(() => {
    const saved = localStorage.getItem("cw_tz");
    const zone = saved || detectTimeZone();
    setTz(zone);
    setDate(dayKeyInZone(new Date(), zone));
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/availability");
    if (res.ok) setSlots((await res.json()).slots);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  function changeTz(zone: string) {
    setTz(zone);
    localStorage.setItem("cw_tz", zone);
    setDate(dayKeyInZone(new Date(), zone));
  }

  async function addSlot(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const [y, mo, d] = date.split("-").map(Number);
    const [sh, sm] = startT.split(":").map(Number);
    const [eh, em] = endT.split(":").map(Number);
    if (!y || sh == null || eh == null) return;
    const start = zonedTimeToUtc(y, mo, d, sh, sm, tz);
    const end = zonedTimeToUtc(y, mo, d, eh, em, tz);
    setBusy(true);
    try {
      const res = await fetch("/api/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_at: start.toISOString(), end_at: end.toISOString() }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error);
      else await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeSlot(id: string) {
    await fetch("/api/availability", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  }

  const mine = slots
    .filter((s) => s.mine)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));

  // group slots by calendar day (in the chosen tz)
  const days = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = dayKeyInZone(s.start_at, tz);
      (map.get(key) ?? map.set(key, []).get(key)!).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [slots, tz]);

  // how many people cover each hour of a given day (in the chosen tz)
  function coverage(dayKey: string): number[] {
    return Array.from({ length: 24 }, (_, h) => {
      const s = hourBoundaryUtc(dayKey, h, tz).getTime();
      const e = hourBoundaryUtc(dayKey, h + 1, tz).getTime();
      const people = new Set<number>();
      for (const slot of slots) {
        if (new Date(slot.start_at).getTime() < e && new Date(slot.end_at).getTime() > s) {
          people.add(slot.member_id);
        }
      }
      return people.size;
    });
  }

  const minDate = dayKeyInZone(new Date(Date.now() - 2 * DAY), tz);
  const maxDate = dayKeyInZone(new Date(Date.now() + 30 * DAY), tz);

  const covColor = (n: number) =>
    n === 0
      ? "bg-neutral-800"
      : n === 1
        ? "bg-emerald-900"
        : n === 2
          ? "bg-emerald-700"
          : "bg-emerald-500";

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-sky-900 bg-sky-950/20 p-4 text-sm text-neutral-300">
        🗓️ <strong className="text-sky-300">Planning only.</strong> Say when you <em>might</em> be
        free to save so everyone can see coverage. This does <strong>not</strong> put you on duty —
        for that, use <span className="font-medium">My duty</span> when the time comes.
      </div>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-neutral-400">Times shown in</span>
          <select
            value={tz}
            onChange={(e) => changeTz(e.target.value)}
            className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm"
          >
            {[...new Set([tz, ...COMMON_TIMEZONES])].map((z) => (
              <option key={z} value={z}>
                {tzLabel(z)}
              </option>
            ))}
          </select>
          <span className="text-xs text-neutral-600">Torn time (TCT) = UTC</span>
        </div>

        <form onSubmit={addSlot} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-neutral-400">Day</span>
            <input
              type="date"
              value={date}
              min={minDate}
              max={maxDate}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">From</span>
            <input
              type="time"
              value={startT}
              onChange={(e) => setStartT(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">To</span>
            <input
              type="time"
              value={endT}
              onChange={(e) => setEndT(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !date}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            I might save then
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        {mine.length > 0 && (
          <div className="mt-4">
            <p className="text-xs uppercase text-neutral-500">Your slots</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {mine.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-emerald-800 bg-emerald-950/40 px-2.5 py-1 text-sm"
                >
                  <span>
                    {labelDay(dayKeyInZone(s.start_at, tz))} · {formatTimeInZone(s.start_at, tz)}–
                    {formatTimeInZone(s.end_at, tz)}
                  </span>
                  <button
                    onClick={() => removeSlot(s.id)}
                    className="text-neutral-500 hover:text-red-400"
                    title="remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">Who&apos;s planning to save</h2>
        {days.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nobody has added times yet — be the first above.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-5">
            {days.map(([key, daySlots]) => {
              const cov = coverage(key);
              return (
                <div key={key}>
                  <p className="text-sm font-semibold">{labelDay(key)}</p>
                  {/* 24-hour coverage strip */}
                  <div className="mt-1.5 flex gap-px overflow-hidden rounded">
                    {cov.map((n, h) => (
                      <div
                        key={h}
                        className={`h-4 flex-1 ${covColor(n)}`}
                        title={`${h}:00 — ${n} saver${n === 1 ? "" : "s"}`}
                      />
                    ))}
                  </div>
                  <div className="mt-0.5 flex justify-between text-[10px] text-neutral-600">
                    <span>0:00</span>
                    <span>6:00</span>
                    <span>12:00</span>
                    <span>18:00</span>
                    <span>24:00</span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {daySlots
                      .sort((a, b) => a.start_at.localeCompare(b.start_at))
                      .map((s) => (
                        <li key={s.id} className="flex items-center gap-2">
                          <span className="tabular-nums text-neutral-400">
                            {formatTimeInZone(s.start_at, tz)}–{formatTimeInZone(s.end_at, tz)}
                          </span>
                          <span className={s.member_id === myId ? "font-semibold text-emerald-400" : ""}>
                            {s.name}
                            {s.member_id === myId && " (you)"}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
