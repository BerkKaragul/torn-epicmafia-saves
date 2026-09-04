"use client";

import { useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface Row {
  member_id: number;
  name: string;
  saves: number;
  save_seconds: number;
  save_pay: number;
}

// Compact duty duration, e.g. "4h 15m", "45m", "0m".
function fmtDur(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
interface Standings {
  war: { opponent_name: string; started_at: string } | null;
  rows: Row[];
}

/**
 * Bottom-of-page standings for the currently LIVE war: each saver's hourly save
 * pay (highest first) and their save count. Mirrors the admin War Pay numbers.
 * Refreshes on a slow cadence since the hourly pay only inches up. Renders
 * nothing when no war is live or nobody has earned yet.
 */
export function WarStandings({ myId }: { myId: number }) {
  const [data, setData] = useState<Standings | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/war-standings");
        if (res.ok && alive) setData(await res.json());
      } catch {
        /* offline; keep the last snapshot */
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!data || !data.war || data.rows.length === 0) return null;

  const total = data.rows.reduce((s, r) => s + r.save_pay, 0);
  const totalSecs = data.rows.reduce((s, r) => s + r.save_seconds, 0);

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-bold">Save pay — live war</h2>
        <span className="text-xs text-neutral-500">vs {data.war.opponent_name}</span>
        <span className="ml-auto text-xs text-neutral-500">
          {fmtMoney(total)} · {fmtDur(totalSecs)} total
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-600">
        Hourly save pay earned in this war so far, highest first. Per-save bonuses are usually
        settled at war&apos;s end, so only the hourly total is shown here.
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-xs uppercase text-neutral-500">
            <tr>
              <th className="py-1.5 pr-3">Saver</th>
              <th className="py-1.5 pr-3 text-right">Save pay</th>
              <th className="py-1.5 pr-3 text-right">Time</th>
              <th className="py-1.5 text-right">Saves</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.member_id} className="border-t border-neutral-800">
                <td className="py-2 pr-3 font-medium">
                  {r.name}
                  {r.member_id === myId && (
                    <span className="ml-1.5 text-xs text-emerald-500">(you)</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-emerald-300">
                  {fmtMoney(r.save_pay)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                  {fmtDur(r.save_seconds)}
                </td>
                <td className="py-2 text-right tabular-nums text-neutral-400">{r.saves || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
