"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney, fmtTct } from "@/lib/format";
import { downloadCsv } from "@/lib/download";
import type { EventPayoutLine, EventPayoutTotals } from "@/lib/types";

interface EventResp {
  event: {
    id: number;
    name: string;
    ends_at: string;
    ended_at: string | null;
    save_bonus: number;
    running: boolean;
    payout_saved_at: string | null;
  } | null;
  frozen?: boolean;
  lines?: EventPayoutLine[];
  totals?: EventPayoutTotals | null;
}

function fmtDur(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Everyone's event earnings — live while the event runs, the frozen payout once
 * an admin locks it in. Admins freeze / unpublish from here.
 */
export function EventStandings({ meId, isAdmin }: { meId: number; isAdmin: boolean }) {
  const [data, setData] = useState<EventResp | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // two-tap confirmation instead of confirm(): browsers can silently switch
  // native dialogs off for a page, which would leave these buttons dead
  const [armed, setArmed] = useState<"freeze" | "unpublish" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/event");
      if (res.ok) setData(await res.json());
    } catch {
      /* offline; keep the last snapshot */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function freeze() {
    if (armed !== "freeze") return setArmed("freeze");
    setArmed(null);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/event/payout", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setMsg(res.ok ? `Frozen ✔ — ${fmtMoney(body.grand)} across ${body.members} member(s)` : body.error);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (armed !== "unpublish") return setArmed("unpublish");
    setArmed(null);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/event/payout", { method: "DELETE" });
      if (!res.ok) setMsg((await res.json().catch(() => ({}))).error ?? "Failed");
      await load();
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!data?.lines || !data.event) return;
    const rows = [
      "member,time_minutes,chain_pay,saves,saves_pay,total",
      ...data.lines.map((l) =>
        [
          `"${l.name}"`,
          Math.round(l.save_seconds / 60),
          l.chain_pay,
          l.saves,
          l.saves_pay,
          l.total,
        ].join(","),
      ),
    ];
    downloadCsv(rows, `event-payout-${data.event.name.replace(/[^a-z0-9]+/gi, "-")}.csv`);
  }

  if (!data?.event) return null;
  const lines = data.lines ?? [];
  const totals = data.totals;

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-bold">{data.frozen ? "🎃 Final event payout" : "🎃 Event standings"}</h2>
        {totals && (
          <span className="ml-auto text-xs text-neutral-500">
            {fmtMoney(totals.grand)} total · {totals.saves} save(s)
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-600">
        {data.frozen
          ? `Locked ${data.event.payout_saved_at ? fmtTct(data.event.payout_saved_at) : ""} — these are the numbers that get paid.`
          : `Live: hourly pay while a chain is live + ${fmtMoney(data.event.save_bonus)} per confirmed save. Paid after the event ends.`}
      </p>

      {lines.length === 0 ? (
        <p className="mt-3 text-neutral-500">Nobody has earned anything yet — be the first. 🦇</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1.5 pr-3">Saver</th>
                <th className="py-1.5 pr-3 text-right">Time</th>
                <th className="py-1.5 pr-3 text-right">Hourly $</th>
                <th className="py-1.5 pr-3 text-right">Saves</th>
                <th className="py-1.5 pr-3 text-right">Saves $</th>
                <th className="py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const isMe = l.member_id === meId;
                return (
                  <tr
                    key={l.member_id}
                    className={`border-t border-neutral-800 ${isMe ? "bg-emerald-950/30" : ""}`}
                  >
                    <td className="py-2 pr-3 font-medium">
                      {l.name}
                      {isMe && <span className="ml-1.5 text-xs text-emerald-500">(you)</span>}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                      {fmtDur(l.save_seconds)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                      {fmtMoney(l.chain_pay)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                      {l.saves || "—"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                      {fmtMoney(l.saves_pay)}
                    </td>
                    <td className="py-2 text-right font-bold tabular-nums text-orange-300">
                      {fmtMoney(l.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-4">
          <button
            onClick={freeze}
            disabled={busy || lines.length === 0}
            className="rounded-md bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-500 disabled:opacity-40"
          >
            {armed === "freeze"
              ? data.event.running
                ? "Still running — tap again to freeze anyway"
                : "Tap again to publish"
              : data.frozen
                ? "Re-freeze payout"
                : "Freeze & publish payout"}
          </button>
          {data.frozen && (
            <button
              onClick={unpublish}
              disabled={busy}
              className="rounded-md border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-400 hover:border-red-900 hover:text-red-400"
            >
              {armed === "unpublish" ? "Tap again to unpublish" : "Unpublish"}
            </button>
          )}
          {lines.length > 0 && (
            <button
              onClick={exportCsv}
              className="rounded-md border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-400 hover:bg-neutral-800"
            >
              CSV
            </button>
          )}
          <span className="text-xs text-neutral-600">
            Admins only. Freeze once the event has ended and late saves are attributed.
          </span>
          {msg && <p className="w-full text-sm text-amber-300">{msg}</p>}
        </div>
      )}
    </section>
  );
}
