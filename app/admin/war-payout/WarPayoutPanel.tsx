"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { downloadCsv } from "@/lib/download";
import { fmtMoney } from "@/lib/format";
import {
  computeWarPayout,
  DEFAULT_CONFIG,
  type WarPayoutConfig,
  type WarReportRow,
} from "@/lib/warPayout";

interface War {
  torn_war_id: number;
  opponent_name: string;
  started_at: string;
  ended_at: string | null;
}

/** What the API reports back about an already-frozen payout for this war. */
interface SavedPayout {
  saved_at: string;
  totals: { grand: number; members: number };
  members: { name: string } | null;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
const fmtNum = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

export function WarPayoutPanel() {
  const [wars, setWars] = useState<War[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<WarReportRow[]>([]);
  const [config, setConfig] = useState<WarPayoutConfig>(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState<WarPayoutConfig>(DEFAULT_CONFIG);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retalMsg, setRetalMsg] = useState<string | null>(null);
  const [retalBusy, setRetalBusy] = useState(false);
  const [pendingChains, setPendingChains] = useState(0);
  const [saved, setSaved] = useState<SavedPayout | null>(null);
  const [freezeBusy, setFreezeBusy] = useState(false);
  const [freezeMsg, setFreezeMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/war-payout")
      .then((r) => r.json())
      .then((b) => {
        const cfg = { ...DEFAULT_CONFIG, ...(b.config ?? {}) };
        setConfig(cfg);
        setSavedConfig(cfg);
        setWars(b.wars ?? []);
        if (b.wars?.length) setSelected(String(b.wars[0].torn_war_id));
      });
  }, []);

  const loadReport = useCallback(async (warId: string) => {
    setLoading(true);
    setFreezeMsg(null);
    try {
      const b = await fetch(`/api/admin/war-payout?war_id=${warId}`).then((r) => r.json());
      setReport(b.report ?? []);
      setPendingChains(b.pending_chains ?? 0);
      setSaved(b.saved ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function fetchRetals() {
    if (!selected || selected === "all") return;
    setRetalBusy(true);
    setRetalMsg("Fetching faction attacks — this can take a minute…");
    try {
      const res = await fetch("/api/admin/war-retals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ war_id: Number(selected) }),
      });
      const b = await res.json();
      if (res.ok) {
        setRetalMsg(
          `Counted ${b.retals} retals + ${b.assists} assists across ${b.members} member(s) — scanned ${b.scanned} attacks over ${b.pages} page(s)${b.capped ? " (hit the page cap — rerun if a huge war)" : ""}.`,
        );
        await loadReport(selected);
      } else {
        setRetalMsg(b.error || "Failed.");
      }
    } catch {
      setRetalMsg("Request failed.");
    } finally {
      setRetalBusy(false);
    }
  }

  useEffect(() => {
    if (selected) loadReport(selected);
  }, [selected, loadReport]);

  const setNum = (k: keyof WarPayoutConfig) => (v: string) =>
    setConfig((c) => ({ ...c, [k]: v === "" ? 0 : Number(v) }));

  // Live preview of exactly the maths the server will redo when the numbers are
  // frozen — same module, so what you see is what gets published.
  const { rows, sumChain, sumRetal, distributed, prize, respectPerUnit, hitPerUnit, overspent } =
    useMemo(() => computeWarPayout(report, config), [report, config]);

  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  const war = wars.find((w) => String(w.torn_war_id) === selected);
  const isAllTime = selected === "all";
  const warRunning = Boolean(war && !war.ended_at);

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

  // The final act: publish these numbers to /payouts for the whole faction.
  async function freezePayout() {
    if (!selected || isAllTime) return;
    const name = war ? `vs ${war.opponent_name}` : `war ${selected}`;
    const warning = saved
      ? `${name} already has final data saved (${fmtMoney(saved.totals.grand)}, ${fmtDate(saved.saved_at)}).\n\nReplace it with what's on screen now?`
      : `Lock in ${fmtMoney(sumChain + sumRetal + distributed)} across ${rows.length} member(s) as the FINAL payout for ${name}?\n\nIt becomes visible to every member on the Payouts page.`;
    if (!confirm(warning)) return;

    setFreezeBusy(true);
    setFreezeMsg(null);
    try {
      const res = await fetch("/api/admin/war-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ war_id: Number(selected), config }),
      });
      const b = await res.json();
      if (res.ok) {
        setFreezeMsg(
          `Published — ${fmtMoney(b.grand)} across ${b.members} member(s) is now on the Payouts page.`,
        );
        await loadReport(selected);
      } else {
        setFreezeMsg(b.error || "Could not save.");
      }
    } catch {
      setFreezeMsg("Request failed.");
    } finally {
      setFreezeBusy(false);
    }
  }

  function exportCsv() {
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
    downloadCsv(lines, `war-payout-${tag}.csv`);
  }

  const numInput = (label: string, k: keyof WarPayoutConfig, step: number, hint?: string) => (
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
          <div className="flex flex-col text-sm">
            <span className="text-neutral-400">Retals</span>
            <button
              onClick={fetchRetals}
              disabled={retalBusy || !selected || isAllTime}
              title="Count every war retal (chain + non-chain) from faction attacks — needs faction API access on your key"
              className="mt-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 font-semibold text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              {retalBusy ? "Fetching…" : "↻ Fetch war retals"}
            </button>
          </div>
        </div>
        {retalMsg && <p className="mt-2 text-xs text-amber-300">{retalMsg}</p>}
        <p className="mt-1 text-xs text-neutral-600">
          Retals shown here come from the chain reports until you fetch — that misses hits landed
          outside a chain. Fetching pulls the full count from faction attacks (needs faction API
          access on your key).
        </p>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h3 className="font-bold">Payout weights</h3>
        <p className="mt-1 text-xs text-neutral-500">
          The leftover is split into a respect pool and a hit pool. Saves and assists draw from
          BOTH: a <b>hit</b> factor (fictional hits in the hit pool) and a <b>score</b> factor
          (fictional respect in the respect pool, measured in average-war-hit respect). Tune each
          on its own.
        </p>

        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {numInput("Retal payment ($ each)", "retalFixed", 50_000, "fixed, paid off the top")}
          {numInput("Respect pool %", "respectPct", 5, "hit pool gets the rest")}
          <div />
          {numInput("Save → hits", "saveAsHits", 0.5, "in the hit pool")}
          {numInput("Save → score", "saveScore", 0.5, "avg-hit respect, in the respect pool")}
          <div />
          {numInput("Assist → hits", "assistAsHits", 0.5, "in the hit pool")}
          {numInput("Assist → score", "assistScore", 0.5, "avg-hit respect, in the respect pool")}
          <label className="text-sm">
            <span className="flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={config.includeOutside}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, includeOutside: e.target.checked }))
                }
              />
              Pay outside hits
            </span>
            <span className="mt-0.5 block text-xs text-neutral-600">off by default; rare</span>
          </label>
          {config.includeOutside &&
            numInput("Outside → hits", "outsideAsHits", 0.5, "in the hit pool")}
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
          {(respectPerUnit > 0 || hitPerUnit > 0) && (
            <span className="text-sm text-sky-300">
              ≈ {fmtMoney(Math.round(respectPerUnit))}/score · {fmtMoney(Math.round(hitPerUnit))}/hit
            </span>
          )}
          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="ml-auto rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            ⬇ CSV
          </button>
        </div>

        {pendingChains > 0 && (
          <p className="mt-2 rounded-md border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
            ⚠ {pendingChains} chain{pendingChains > 1 ? "s" : ""} from this war {pendingChains > 1 ? "haven't" : "hasn't"}{" "}
            finished/synced yet. Milestone-bonus respect (50th/100th/…/2500th hits) can only be
            stripped once a chain ends and Torn publishes its report — so respect, and the split, may
            be inflated right now. Wait for the chain to finish, then it corrects automatically.
          </p>
        )}

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
                  {config.includeOutside && <th className="py-1.5 pr-3">Outside</th>}
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
                    {config.includeOutside && (
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">
                        {r.outside_hits || "—"}
                      </td>
                    )}
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

      {/* ── the commit step ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-5">
        <h3 className="font-bold text-emerald-200">Lock in the final data</h3>
        <p className="mt-1 text-xs text-neutral-400">
          Everything above is live — it moves as chains sync and weights change. Pressing this
          freezes the numbers exactly as shown and publishes them to the{" "}
          <a href="/payouts" className="underline hover:text-neutral-200">
            Payouts page
          </a>
          , where every member can read their line and download the PDF. Do it once the war is
          over, the retals are fetched, and the figures are settled.
        </p>

        {saved && (
          <p className="mt-3 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-300">
            Already published: {fmtMoney(saved.totals.grand)} across {saved.totals.members}{" "}
            member(s), locked {fmtDate(saved.saved_at)}
            {saved.members?.name ? ` by ${saved.members.name}` : ""}. Saving again replaces it.
          </p>
        )}

        {warRunning && (
          <p className="mt-3 text-sm text-amber-400">
            ⚠ This war is still running — the report will keep changing after you publish.
          </p>
        )}
        {pendingChains > 0 && (
          <p className="mt-2 text-sm text-amber-400">
            ⚠ {pendingChains} chain report{pendingChains > 1 ? "s" : ""} still pending — respect may
            be inflated. Better to wait.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={freezePayout}
            disabled={freezeBusy || isAllTime || rows.length === 0 || config.pool <= 0}
            title={
              isAllTime
                ? "Pick a specific war — “all time” isn't a war payout"
                : "Publish these numbers as this war's final payout"
            }
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {freezeBusy
              ? "Saving…"
              : saved
                ? "💾 Replace saved war data"
                : "💾 Save as this war's final data"}
          </button>
          {isAllTime && (
            <span className="text-sm text-neutral-500">
              Pick a specific war above to publish a payout.
            </span>
          )}
          {freezeMsg && <span className="text-sm text-emerald-300">{freezeMsg}</span>}
        </div>
      </section>
    </div>
  );
}
