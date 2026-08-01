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
  respect: number;
  war_hits: number;
  retaliations: number;
  assists: number;
  saves: number;
  save_seconds: number;
  chain_pay: number;
}

interface Config {
  pool: number;
  retalFixed: number;
  // respect pool gets respectPct% of the leftover, the hit pool the rest;
  // saves/assists count as fictional hits in the hit pool
  respectPct: number;
  saveAsHits: number;
  assistAsHits: number;
}

const DEFAULT: Config = {
  pool: 0,
  retalFixed: 900_000,
  respectPct: 75,
  saveAsHits: 1,
  assistAsHits: 1,
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const fmtNum = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

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

  // Each member's total = chain-hour pay + retal pay (fixed each) + a share of
  // what's left of the prize. A respect pool (respectPct%) is shared by respect
  // and a hit pool (the rest) by war hits, with saves/assists as fictional hits.
  // Each pool is normalised within itself; empty pools are dropped so nothing is
  // lost. Largest-remainder keeps the integer shares summing exactly to what was
  // actually distributed.
  const { rows, sumChain, sumRetal, distributed, prize } = useMemo(() => {
    const prize = Math.max(0, Math.round(config.pool));
    const retalFixed = Math.max(0, config.retalFixed);

    const base = report.map((r) => ({
      member_id: r.member_id,
      name: r.name,
      respect: Number(r.respect),
      war_hits: Number(r.war_hits),
      retaliations: Number(r.retaliations),
      assists: Number(r.assists),
      saves: Number(r.saves),
      chainPay: Math.round(Number(r.chain_pay)),
      retalPay: Math.round(Number(r.retaliations) * retalFixed),
    }));

    const sumChain = base.reduce((s, r) => s + r.chainPay, 0);
    const sumRetal = base.reduce((s, r) => s + r.retalPay, 0);
    const distributable = Math.max(0, prize - sumChain - sumRetal);

    // Two category pools of the leftover: a respect pool (respectPct%) shared by
    // respect, and a hit pool (the rest) shared by war hits — with saves and
    // assists folded in as fictional hits.
    const pct = Math.min(100, Math.max(0, config.respectPct));
    const categories: { w: number; vals: number[] }[] = [
      { w: pct, vals: base.map((r) => r.respect) },
      {
        w: 100 - pct,
        vals: base.map(
          (r) => r.war_hits + config.saveAsHits * r.saves + config.assistAsHits * r.assists,
        ),
      },
    ];

    // only categories with a positive weight AND something to divide take a cut
    const active = categories
      .map((c) => ({ ...c, total: c.vals.reduce((a, b) => a + b, 0) }))
      .filter((c) => c.w > 0 && c.total > 0);
    const wTotal = active.reduce((s, c) => s + c.w, 0);

    const shares = base.map(() => 0);
    if (wTotal > 0) {
      for (const c of active) {
        const catPool = (c.w / wTotal) * distributable;
        base.forEach((_, i) => {
          shares[i] += (c.vals[i] / c.total) * catPool;
        });
      }
    }

    // largest-remainder rounding to the integer total we actually distributed
    const targetInt = Math.round(shares.reduce((a, b) => a + b, 0));
    const floors = shares.map(Math.floor);
    const left = targetInt - floors.reduce((a, b) => a + b, 0);
    const order = shares
      .map((s, i) => ({ i, frac: s - Math.floor(s) }))
      .sort((a, b) => b.frac - a.frac);
    const shareInt = floors.slice();
    for (let j = 0; j < left && order.length > 0; j++) shareInt[order[j % order.length].i] += 1;

    const rows = base
      .map((r, i) => ({ ...r, share: shareInt[i], total: r.chainPay + r.retalPay + shareInt[i] }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    const distributed = shareInt.reduce((a, b) => a + b, 0);
    return { rows, sumChain, sumRetal, distributed, prize };
  }, [report, config]);

  const overspent = prize > 0 && sumChain + sumRetal > prize;
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
      "member,respect,war_hits,retals,saves,assists,chain_pay,retal_pay,war_share,total",
      ...rows.map((r) =>
        [
          `"${r.name}"`,
          Math.round(r.respect),
          r.war_hits,
          r.retaliations,
          r.saves,
          r.assists,
          r.chainPay,
          r.retalPay,
          r.share,
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

  const numInput = (label: string, k: keyof Config, step: number, hint?: string) => (
    <label className="text-sm">
      <span className="text-neutral-400">{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={config[k] as number}
        onChange={(e) => setNum(k)(e.target.value)}
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
          Total earnings per member = their chain-hour pay + retal pay (a fixed amount per retal) +
          a share of what&apos;s left of the prize pool (respect pool + hit pool).
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
        <h3 className="font-bold">Payout weights</h3>
        <p className="mt-1 text-xs text-neutral-500">
          The leftover is split into a respect pool (shared by respect) and a hit pool (shared by
          war hits). Saves and assists count as fictional hits in the hit pool — set how many hits
          each is worth.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {numInput("Retal payment ($ each)", "retalFixed", 50_000, "fixed, paid off the top")}
          {numInput("Respect pool %", "respectPct", 5, "hit pool gets the rest")}
          {numInput("Save = N hits", "saveAsHits", 0.5)}
          {numInput("Assist = N hits", "assistAsHits", 0.5)}
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
          <h3 className="font-bold">Payout</h3>
          <span className="text-lg font-black tabular-nums text-emerald-400">
            {fmtMoney(sumChain + sumRetal + distributed)}
          </span>
          <span className="text-sm text-neutral-500">
            across {rows.length} member(s) · chain {fmtMoney(sumChain)} + retals{" "}
            {fmtMoney(sumRetal)} + split {fmtMoney(distributed)}
          </span>
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="ml-auto rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            ⬇ CSV
          </button>
        </div>

        {overspent && (
          <p className="mt-2 text-sm text-red-400">
            ⚠ Chain pay + retals ({fmtMoney(sumChain + sumRetal)}) already exceed the pool — there&apos;s
            nothing left to split. Raise the pool or lower the retal amount.
          </p>
        )}

        {loading ? (
          <p className="mt-3 text-sm text-neutral-500">Loading…</p>
        ) : config.pool <= 0 ? (
          <p className="mt-3 text-sm text-amber-400">Enter a total pool above to calculate.</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">Nothing to pay for this war yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-1.5 pr-3">Member</th>
                  <th className="py-1.5 pr-3">Respect</th>
                  <th className="py-1.5 pr-3">Hits</th>
                  <th className="py-1.5 pr-3">Retals</th>
                  <th className="py-1.5 pr-3">Saves</th>
                  <th className="py-1.5 pr-3">Assists</th>
                  <th className="py-1.5 pr-3">Chain $</th>
                  <th className="py-1.5 pr-3">Retal $</th>
                  <th className="py-1.5 pr-3">Split $</th>
                  <th className="py-1.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.member_id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{fmtNum(r.respect)}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.war_hits}</td>
                    <td className="py-2 pr-3 tabular-nums text-sky-300">{r.retaliations || "—"}</td>
                    <td className="py-2 pr-3 tabular-nums text-emerald-400">{r.saves || "—"}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">{r.assists || "—"}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-500">{fmtMoney(r.chainPay)}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-500">{fmtMoney(r.retalPay)}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-300">{fmtMoney(r.share)}</td>
                    <td className="py-2 font-bold tabular-nums text-emerald-300">
                      {fmtMoney(r.total)}
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
