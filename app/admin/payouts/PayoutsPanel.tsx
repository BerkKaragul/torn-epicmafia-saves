"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface Line {
  id: string;
  member_id: number;
  duty_seconds: number;
  save_count: number;
  hours_amount: number;
  saves_amount: number;
  total_amount: number;
  paid_at: string | null;
  members: { name: string };
}

interface Period {
  id: string;
  period_start: string;
  period_end: string;
  created_at: string;
  payout_lines: Line[];
}

const fmtH = (s: number) => (s / 3600).toFixed(1) + "h";
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

// datetime-local wants "YYYY-MM-DDTHH:mm" in local time
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function PayoutsPanel() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [start, setStart] = useState(() =>
    toLocalInput(new Date(Date.now() - 7 * 24 * 3600 * 1000)),
  );
  const [end, setEnd] = useState(() => toLocalInput(new Date()));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/payouts");
    if (res.ok) setPeriods((await res.json()).periods);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createPeriod(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period_start: new Date(start).toISOString(),
          period_end: new Date(end).toISOString(),
        }),
      });
      const body = await res.json();
      setMsg(res.ok ? `Report created with ${body.lines} member line(s).` : body.error);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function markPaid(lineId: string, paid: boolean) {
    await fetch("/api/admin/payouts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_id: lineId, paid }),
    });
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={createPeriod}
        className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
      >
        <h2 className="font-bold">Generate payout report</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Sweeps <em>everything unpaid up to the end date</em>: ended shifts (counted in full in
          the report where they ended) and confirmed saves, including late manual attributions
          from before the start date. Members still on duty get counted once they stop. Each row
          is claimed exactly once — re-running never double-pays.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-neutral-400">From</span>
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">To</span>
            <input
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? "Crunching…" : "Create report"}
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-amber-300">{msg}</p>}
      </form>

      {periods.map((p) => {
        const total = p.payout_lines.reduce((s, l) => s + Number(l.total_amount), 0);
        const unpaid = p.payout_lines.filter((l) => !l.paid_at);
        return (
          <section key={p.id} className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-bold">
                {fmtDate(p.period_start)} → {fmtDate(p.period_end)}
              </h3>
              <span className="text-sm text-neutral-500">
                {fmtMoney(total)} total · {unpaid.length} unpaid
              </span>
              <a
                href={`/api/admin/payouts?period_id=${p.id}&format=csv`}
                className="ml-auto rounded-md border border-neutral-700 px-2.5 py-1 text-xs font-semibold text-neutral-300 hover:bg-neutral-800"
              >
                ⬇ CSV
              </a>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="py-1.5 pr-3">Member</th>
                    <th className="py-1.5 pr-3">Duty</th>
                    <th className="py-1.5 pr-3">Saves</th>
                    <th className="py-1.5 pr-3">Availability</th>
                    <th className="py-1.5 pr-3">Save bonus</th>
                    <th className="py-1.5 pr-3">Total</th>
                    <th className="py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {p.payout_lines
                    .slice()
                    .sort((a, b) => Number(b.total_amount) - Number(a.total_amount))
                    .map((l) => (
                      <tr key={l.id} className="border-t border-neutral-800">
                        <td className="py-2 pr-3 font-medium">{l.members.name}</td>
                        <td className="py-2 pr-3 tabular-nums">{fmtH(l.duty_seconds)}</td>
                        <td className="py-2 pr-3 tabular-nums">{l.save_count}</td>
                        <td className="py-2 pr-3 tabular-nums">{fmtMoney(l.hours_amount)}</td>
                        <td className="py-2 pr-3 tabular-nums">{fmtMoney(l.saves_amount)}</td>
                        <td className="py-2 pr-3 font-bold tabular-nums">
                          {fmtMoney(l.total_amount)}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            onClick={() => markPaid(l.id, !l.paid_at)}
                            className={`rounded px-2 py-0.5 text-xs font-semibold ${
                              l.paid_at
                                ? "bg-emerald-900/60 text-emerald-300 hover:bg-emerald-900"
                                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                            }`}
                          >
                            {l.paid_at ? "PAID ✔" : "mark paid"}
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
