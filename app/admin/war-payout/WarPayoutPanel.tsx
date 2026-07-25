"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface War {
  torn_war_id: number;
  opponent_name: string;
  started_at: string;
  ended_at: string | null;
  our_score: number;
  their_score: number;
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
  warHit: number;
  outsideHit: number;
  bonusHit: number;
  save: number;
  hourly: number;
  includeOutside: boolean;
  includeDuty: boolean;
}

const DEFAULT: Config = {
  warHit: 0,
  outsideHit: 0,
  bonusHit: 0,
  save: 0,
  hourly: 0,
  includeOutside: true,
  includeDuty: true,
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export function WarPayoutPanel() {
  const [wars, setWars] = useState<War[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [config, setConfig] = useState<Config>(DEFAULT);
  const [savedConfig, setSavedConfig] = useState<Config>(DEFAULT);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // initial: config + war list
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

  const num = (k: keyof Config) => (v: string) =>
    setConfig((c) => ({ ...c, [k]: v === "" ? 0 : Number(v) }));

  // per-member computed earnings
  const rows = useMemo(() => {
    return report
      .map((r) => {
        const warHits = config.warHit * Number(r.war_hits);
        const outside = config.includeOutside ? config.outsideHit * Number(r.outside_hits) : 0;
        const bonus = config.bonusHit * Number(r.bonus_hits);
        const saves = config.save * Number(r.saves);
        const duty = config.includeDuty ? (config.hourly * Number(r.save_seconds)) / 3600 : 0;
        const total = Math.round(warHits + outside + bonus + saves + duty);
        return { ...r, warHits, outside, bonus, saves, duty, total };
      })
      .filter((r) => r.total > 0 || r.war_hits > 0 || r.saves > 0)
      .sort((a, b) => b.total - a.total);
  }, [report, config]);

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
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
      setMsg("Saved as the default weights.");
    } else setMsg(b.error);
  }

  function exportCsv() {
    const war = wars.find((w) => String(w.torn_war_id) === selected);
    const tag = war ? war.opponent_name.replace(/[^a-z0-9]+/gi, "-") : "all";
    const lines = [
      "member,war_hits,outside_hits,bonus_hits,saves,duty_hours,total",
      ...rows.map((r) =>
        [
          `"${r.name}"`,
          r.war_hits,
          r.outside_hits,
          r.bonus_hits,
          r.saves,
          (Number(r.save_seconds) / 3600).toFixed(2),
          r.total,
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
        value={config[k] as number}
        onChange={(e) => num(k)(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 tabular-nums"
      />
      {hint && <span className="mt-0.5 block text-xs text-neutral-600">{hint}</span>}
    </label>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">War payout calculator</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Turns each member&apos;s war stats into a suggested payout using the weights below. This
          is a calculator for the bankers — it doesn&apos;t move money or touch the live Balances
          page. Pay people in Torn, then settle their balances as usual.
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
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="font-bold">Weights</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {weight("$ per war hit", "warHit")}
          {weight("$ per bonus hit", "bonusHit", "milestone hits (25/50/100…)")}
          {weight("$ per save", "save")}
          <label className="text-sm">
            <span className="flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={config.includeOutside}
                onChange={(e) => setConfig((c) => ({ ...c, includeOutside: e.target.checked }))}
              />
              $ per outside hit
            </span>
            <input
              type="number"
              min={0}
              value={config.outsideHit}
              disabled={!config.includeOutside}
              onChange={(e) => num("outsideHit")(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 tabular-nums disabled:opacity-40"
            />
            <span className="mt-0.5 block text-xs text-neutral-600">non-war attacks</span>
          </label>
          <label className="text-sm">
            <span className="flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={config.includeDuty}
                onChange={(e) => setConfig((c) => ({ ...c, includeDuty: e.target.checked }))}
              />
              $ per hour on duty
            </span>
            <input
              type="number"
              min={0}
              value={config.hourly}
              disabled={!config.includeDuty}
              onChange={(e) => num("hourly")(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 tabular-nums disabled:opacity-40"
            />
            <span className="mt-0.5 block text-xs text-neutral-600">save/availability time</span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={saveDefaults}
            disabled={!dirty}
            className="rounded-md bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
          >
            {dirty ? "Save as default weights" : "Weights saved"}
          </button>
          {msg && <span className="text-sm text-amber-300">{msg}</span>}
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="font-bold">Payout</h3>
          <span className="text-lg font-black tabular-nums text-emerald-400">
            {fmtMoney(grandTotal)}
          </span>
          <span className="text-sm text-neutral-500">total across {rows.length} member(s)</span>
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
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No payable stats for this war yet, or all weights are zero.
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
                  <th className="py-1.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member_id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">
                      {r.war_hits}
                      {r.warHits > 0 && (
                        <span className="ml-1 text-xs text-neutral-600">{fmtMoney(r.warHits)}</span>
                      )}
                    </td>
                    {config.includeOutside && (
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">
                        {r.outside_hits}
                        {r.outside > 0 && (
                          <span className="ml-1 text-xs text-neutral-600">
                            {fmtMoney(r.outside)}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.bonus_hits}</td>
                    <td className="py-2 pr-3 tabular-nums text-emerald-400">{r.saves}</td>
                    {config.includeDuty && (
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">
                        {(Number(r.save_seconds) / 3600).toFixed(1)}h
                      </td>
                    )}
                    <td className="py-2 font-bold tabular-nums">{fmtMoney(r.total)}</td>
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
