"use client";

import { useCallback, useEffect, useState } from "react";

interface War {
  torn_war_id: number;
  opponent_name: string;
  started_at: string;
  ended_at: string | null;
  target: number;
  winner_id: number | null;
  our_score: number;
  their_score: number;
}

interface ReportRow {
  member_id: number;
  name: string;
  war_hits: number;
  outside_hits: number;
  bonus_hits: number;
  respect: number;
  saves: number;
  best_save_seconds: number | null;
  save_seconds: number;
}

const fmtDur = (s: number) =>
  s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s > 0 ? `${Math.round(s / 60)}m` : "—";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function WarsPanel() {
  const [wars, setWars] = useState<War[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadWars = useCallback(async () => {
    const res = await fetch("/api/admin/wars");
    if (!res.ok) return;
    const body = await res.json();
    setWars(body.wars);
    if (body.wars.length && selected === null) {
      setSelected(String(body.wars[0].torn_war_id));
    }
  }, [selected]);

  useEffect(() => {
    loadWars();
  }, [loadWars]);

  useEffect(() => {
    if (selected === null) return;
    setLoading(true);
    fetch(`/api/admin/wars?war_id=${selected}`)
      .then((r) => r.json())
      .then((b) => setReport(b.report ?? []))
      .finally(() => setLoading(false));
  }, [selected]);

  const war = wars.find((w) => String(w.torn_war_id) === selected);
  const totals = (report ?? []).reduce(
    (acc, r) => ({
      war_hits: acc.war_hits + Number(r.war_hits),
      outside_hits: acc.outside_hits + Number(r.outside_hits),
      bonus_hits: acc.bonus_hits + Number(r.bonus_hits),
      saves: acc.saves + Number(r.saves),
      save_seconds: acc.save_seconds + Number(r.save_seconds),
    }),
    { war_hits: 0, outside_hits: 0, bonus_hits: 0, saves: 0, save_seconds: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">War reports</h2>
        <p className="mt-1 text-xs text-neutral-500">
          War hits, outside hits and bonus hits come from Torn&apos;s own chain reports (pulled
          once each chain ends). Saves are ChainWatch&apos;s — hits landed under the save timer by
          the saver whose turn it was.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          >
            {wars.map((w) => (
              <option key={w.torn_war_id} value={w.torn_war_id}>
                {w.ended_at ? "" : "🔴 LIVE — "}vs {w.opponent_name} ({fmtDate(w.started_at)})
              </option>
            ))}
            <option value="all">All time (every chain)</option>
          </select>
          {war && (
            <span className="text-sm text-neutral-400">
              score{" "}
              <span
                className={
                  war.our_score >= war.their_score ? "text-emerald-400" : "text-red-400"
                }
              >
                {war.our_score.toLocaleString()}
              </span>{" "}
              – {war.their_score.toLocaleString()} · target {war.target.toLocaleString()}
              {war.ended_at && war.winner_id && (
                <span className="ml-2 font-semibold">
                  {war.winner_id === war.torn_war_id ? "" : ""}
                </span>
              )}
            </span>
          )}
        </div>
      </section>

      {wars.length === 0 && (
        <p className="text-sm text-neutral-500">
          No wars recorded yet — they sync from Torn within ~10 minutes.
        </p>
      )}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="font-bold">Per member</h3>
          {report && (
            <span className="text-sm text-neutral-500">
              {totals.war_hits.toLocaleString()} war hits ·{" "}
              {totals.outside_hits.toLocaleString()} outside ·{" "}
              {totals.bonus_hits.toLocaleString()} bonus · {totals.saves.toLocaleString()} saves ·{" "}
              {fmtDur(totals.save_seconds)} on duty
            </span>
          )}
        </div>

        {loading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : !report || report.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            Nothing recorded for this war yet. Chain reports arrive once a chain finishes.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-1.5 pr-3">Member</th>
                  <th className="py-1.5 pr-3">War hits</th>
                  <th className="py-1.5 pr-3">Outside hits</th>
                  <th className="py-1.5 pr-3">Bonus hits</th>
                  <th className="py-1.5 pr-3">Saves</th>
                  <th className="py-1.5 pr-3">Save time</th>
                  <th className="py-1.5 pr-3">Best save</th>
                  <th className="py-1.5">Respect</th>
                </tr>
              </thead>
              <tbody>
                {report.map((r) => (
                  <tr key={r.member_id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums">{Number(r.war_hits).toLocaleString()}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">
                      {Number(r.outside_hits).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-amber-300">
                      {Number(r.bonus_hits) || "—"}
                    </td>
                    <td className="py-2 pr-3 font-bold tabular-nums text-emerald-400">
                      {Number(r.saves) || "—"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-300">
                      {fmtDur(Number(r.save_seconds))}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">
                      {r.best_save_seconds !== null
                        ? `${Math.round(Number(r.best_save_seconds))}s left`
                        : "—"}
                    </td>
                    <td className="py-2 tabular-nums text-neutral-400">
                      {Number(r.respect).toLocaleString(undefined, {
                        maximumFractionDigits: 0,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
