"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface War {
  torn_war_id: number;
  opponent_name: string;
  started_at: string;
  ended_at: string | null;
}

interface ReportRow {
  member_id: number;
  name: string;
  war_hits: number;
  outside_hits: number;
  bonus_hits: number;
  saves: number;
  save_seconds: number;
}

interface Config {
  pool: number;
  warHit: number;
  outsideHit: number;
  bonusHit: number;
  save: number;
  duty: number;
  includeOutside: boolean;
  includeDuty: boolean;
}

const DEFAULT: Config = {
  pool: 0,
  warHit: 0.3,
  outsideHit: 0.5,
  bonusHit: 1,
  save: 0.4,
  duty: 0.2,
  includeOutside: true,
  includeDuty: true,
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const fmtPts = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

export function WarPayoutPanel() {
  const [wars, setWars] = useState<War[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [config, setConfig] = useState<Config>(DEFAULT);
  const [savedConfig, setSavedConfig] = useState<Config>(DEFAULT);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/admin/war-payout")
      .then((r) => r.json())
      .then((b) => {
        const cfg = { ...DEFAULT, ...(b.config ?? {}) };
        setConfig(cfg);
        setSavedConfig(cfg);
        setWars(b.wars ?? []);
        if (b.wars?.length) setSelected(String(b.wars[0].torn_war_id));
      });
  }, []);

  const loadReport = useCallback(async (warId: string) => {
    setLoading(true);
    try {
      const b = await fetch(`/api/admin/war-payout?war_id=${warId}`).then((r) => r.json());
      setReport(b.report ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadReport(selected);
  }, [selected, loadReport]);

  const setNum = (k: keyof Config) => (v: string) =>
    setConfig((c) => ({ ...c, [k]: v === "" ? 0 : Number(v) }));

  // points per member, then split the pool proportionally. Uses largest-
  // remainder so the shares sum EXACTLY to the pool (no lost/created cents).
  const { rows, totalPoints, distributed } = useMemo(() => {
    const scored = report.map((r) => {
      const dutyHours = Number(r.save_seconds) / 3600;
      const points =
        config.warHit * Number(r.war_hits) +
        (config.includeOutside ? config.outsideHit * Number(r.outside_hits) : 0) +
        config.bonusHit * Number(r.bonus_hits) +
        config.save * Number(r.saves) +
        (config.includeDuty ? config.duty * dutyHours : 0);
      return { ...r, dutyHours, points };
    });

    const total = scored.reduce((s, r) => s + r.points, 0);
    const pool = Math.max(0, Math.round(config.pool));

    let withShares = scored.map((r) => ({ ...r, share: 0, exact: 0, floor: 0 }));
    if (total > 0 && pool > 0) {
      withShares = scored.map((r) => {
        const exact = (r.points / total) * pool;
        return { ...r, exact, floor: Math.floor(exact), share: Math.floor(exact) };
      });
      let leftover = pool - withShares.reduce((s, r) => s + r.floor, 0);
      // hand the rounding remainder to the biggest fractional parts first
      const order = [...withShares]
        .map((r, i) => ({ i, frac: r.exact - r.floor }))
        .sort((a, b) => b.frac - a.frac);
      for (let j = 0; j < leftover; j++) withShares[order[j % order.length].i].share += 1;
    }

    return {
      rows: withShares
        .filter((r) => r.points > 0)
        .sort((a, b) => b.share - a.share || b.points - a.points),
      totalPoints: total,
      distributed: withShares.reduce((s, r) => s + r.share, 0),
    };
  }, [report, config]);

  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);

  async function saveDefaults() {
    setMsg(null);
    const res = await fetch("/api/admin/war-payout", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const b = await res.json();
    if (res.ok) {
      setSavedConfig(config);
      setMsg("Saved as defaults.");
    } else setMsg(b.error);
  }

  function exportCsv() {
    const war = wars.find((w) => String(w.torn_war_id) === selected);
    const tag = war ? war.opponent_name.replace(/[^a-z0-9]+/gi, "-") : "all";
    const lines = [
      "member,war_hits,outside_hits,bonus_hits,saves,duty_hours,points,share",
      ...rows.map((r) =>
        [
          `"${r.name}"`,
          r.war_hits,
          r.outside_hits,
          r.bonus_hits,
          r.saves,
          r.dutyHours.toFixed(2),
          r.points.toFixed(2),
          r.share,
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `war-payout-${tag}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const weight = (label: string, k: keyof Config, hint?: string) => (
    <label className="text-sm">
      <span className="text-neutral-400">{label}</span>
      <input
        type="number"
        min={0}
        step={0.1}
        value={config[k] as number}
        onChange={(e) => setNum(k)(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 tabular-nums"
      />
      {hint && <span className="mt-0.5 block text-xs text-neutral-600">{hint}</span>}
    </label>
  );

  const togglableWeight = (
    label: string,
    k: keyof Config,
    toggleKey: "includeOutside" | "includeDuty",
    hint: string,
  ) => (
    <label className="text-sm">
      <span className="flex items-center gap-2 text-neutral-400">
        <input
          type="checkbox"
          checked={config[toggleKey]}
          onChange={(e) => setConfig((c) => ({ ...c, [toggleKey]: e.target.checked }))}
        />
        {label}
      </span>
      <input
        type="number"
        min={0}
        step={0.1}
        value={config[k] as number}
        disabled={!config[toggleKey]}
        onChange={(e) => setNum(k)(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 tabular-nums disabled:opacity-40"
      />
      <span className="mt-0.5 block text-xs text-neutral-600">{hint}</span>
    </label>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">War payout calculator</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Enter the total prize pool for the war. The weights below turn each stat into points
          (they don&apos;t need to add up to anything); everyone gets a share of the pool
          proportional to their points. Shares always add up to exactly the pool.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="text-neutral-400">Total pool ($)</span>
            <input
              type="number"
              min={0}
              value={config.pool || ""}
              onChange={(e) => setNum("pool")(e.target.value)}
              placeholder="e.g. 1000000000"
              className="mt-1 w-64 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-lg font-bold tabular-nums"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">War</span>
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1 block rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
            >
              {wars.map((w) => (
                <option key={w.torn_war_id} value={w.torn_war_id}>
                  {w.ended_at ? "" : "🔴 LIVE — "}vs {w.opponent_name} ({fmtDate(w.started_at)})
                </option>
              ))}
              <option value="all">All time (every chain)</option>
            </select>
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="font-bold">Point weights</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Points per unit. e.g. war hit 0.3 means every war hit is worth 0.3 points.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {weight("War hit", "warHit")}
          {weight("Bonus hit", "bonusHit", "milestone hits (25/50/100…)")}
          {weight("Save", "save")}
          {togglableWeight("Outside hit", "outsideHit", "includeOutside", "non-war attacks")}
          {togglableWeight("Per hour on duty", "duty", "includeDuty", "save/availability time")}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={saveDefaults}
            disabled={!dirty}
            className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {dirty ? "Save as defaults" : "Saved"}
          </button>
          {msg && <span className="text-sm text-amber-300">{msg}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="font-bold">Split</h3>
          <span className="text-lg font-black tabular-nums text-emerald-400">
            {fmtMoney(distributed)}
          </span>
          <span className="text-sm text-neutral-500">
            across {rows.length} member(s) · {fmtPts(totalPoints)} total points
          </span>
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="ml-auto rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            ⬇ CSV
          </button>
        </div>

        {loading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : config.pool <= 0 ? (
          <p className="mt-3 text-sm text-amber-400">Enter a total pool above to split it.</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No points for this war yet — set some weights, or the report has no stats.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-1.5 pr-3">Member</th>
                  <th className="py-1.5 pr-3">War hits</th>
                  {config.includeOutside && <th className="py-1.5 pr-3">Outside</th>}
                  <th className="py-1.5 pr-3">Bonus</th>
                  <th className="py-1.5 pr-3">Saves</th>
                  {config.includeDuty && <th className="py-1.5 pr-3">Duty</th>}
                  <th className="py-1.5 pr-3">Points</th>
                  <th className="py-1.5 pr-3">%</th>
                  <th className="py-1.5">Share</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member_id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.war_hits}</td>
                    {config.includeOutside && (
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.outside_hits}</td>
                    )}
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.bonus_hits}</td>
                    <td className="py-2 pr-3 tabular-nums text-emerald-400">{r.saves}</td>
                    {config.includeDuty && (
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">
                        {r.dutyHours.toFixed(1)}h
                      </td>
                    )}
                    <td className="py-2 pr-3 tabular-nums text-neutral-300">{fmtPts(r.points)}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-500">
                      {totalPoints > 0 ? ((r.points / totalPoints) * 100).toFixed(1) : "0"}%
                    </td>
                    <td className="py-2 font-bold tabular-nums">{fmtMoney(r.share)}</td>
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
