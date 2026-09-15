"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";
import { downloadPayoutPdf, type PayoutTotals } from "@/lib/payoutPdf";
import { normalizeConfig, type WarPayoutRow } from "@/lib/warPayout";

interface SavedPayout {
  torn_war_id: number;
  config: unknown;
  totals: PayoutTotals;
  lines: WarPayoutRow[];
  saved_at: string;
  saved_by: number;
  wars: {
    opponent_name: string | null;
    started_at: string | null;
    ended_at: string | null;
    our_score: number | null;
    their_score: number | null;
  } | null;
  members: { name: string } | null;
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
const fmtNum = (n: number) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

export function PayoutsArchive({ meId, isAdmin }: { meId: number; isAdmin: boolean }) {
  const [payouts, setPayouts] = useState<SavedPayout[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/payouts");
    const body = await res.json().catch(() => ({}));
    const list: SavedPayout[] = res.ok ? (body.payouts ?? []) : [];
    setPayouts(list);
    // the newest war is what people come here for — open it straight away
    if (list.length > 0) setOpen((cur) => cur ?? list[0].torn_war_id);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function removePayout(p: SavedPayout) {
    const name = p.wars?.opponent_name ?? `war ${p.torn_war_id}`;
    if (!confirm(`Unpublish the payout for ${name}? Members will no longer see it.`)) return;
    await fetch(`/api/admin/war-payout?war_id=${p.torn_war_id}`, { method: "DELETE" });
    await load();
  }

  function exportCsv(p: SavedPayout) {
    const cfg = normalizeConfig(p.config);
    const tag = (p.wars?.opponent_name ?? "war").replace(/[^a-z0-9]+/gi, "-");
    const rows = [
      "member,respect,war_hits,outside_hits,retals,saves,assists,chain_pay,retal_pay,war_share,total",
      ...p.lines.map((r) =>
        [
          `"${r.name}"`,
          Math.round(r.respect),
          r.war_hits,
          cfg.includeOutside ? r.outside_hits : 0,
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
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `war-payout-${tag}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPdf(p: SavedPayout) {
    downloadPayoutPdf({
      opponent: p.wars?.opponent_name ?? `War ${p.torn_war_id}`,
      startedAt: p.wars?.started_at ?? null,
      endedAt: p.wars?.ended_at ?? null,
      ourScore: p.wars?.our_score,
      theirScore: p.wars?.their_score,
      savedAt: p.saved_at,
      savedByName: p.members?.name ?? null,
      totals: p.totals,
      lines: p.lines,
      config: normalizeConfig(p.config),
    });
  }

  if (payouts === null) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  if (payouts.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="font-bold">No payouts published yet</h2>
        <p className="mt-1 text-sm text-neutral-500">
          A war shows up here once an admin locks in its final numbers on the War pay page. Until
          then the figures are still moving, so nothing is shown.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-black">Payouts</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Final, locked-in earnings for every finished war — chain-hour pay, retals and your share
          of the prize pool. Your own row is highlighted.
        </p>
      </div>

      {payouts.map((p) => {
        const cfg = normalizeConfig(p.config);
        const mine = p.lines.find((l) => Number(l.member_id) === meId);
        const isOpen = open === p.torn_war_id;
        return (
          <section
            key={p.torn_war_id}
            className="rounded-xl border border-neutral-800 bg-neutral-900"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-5">
              <button
                onClick={() => setOpen(isOpen ? null : p.torn_war_id)}
                className="flex items-baseline gap-2 text-left"
              >
                <span className="text-neutral-600">{isOpen ? "▾" : "▸"}</span>
                <h2 className="font-bold">vs {p.wars?.opponent_name ?? `War ${p.torn_war_id}`}</h2>
                <span className="text-xs text-neutral-500">
                  {fmtDate(p.wars?.started_at ?? null)}
                  {p.wars?.our_score != null && p.wars?.their_score != null
                    ? ` · ${p.wars.our_score}–${p.wars.their_score}`
                    : ""}
                </span>
              </button>

              <span className="text-lg font-black tabular-nums text-emerald-400">
                {fmtMoney(p.totals.grand)}
              </span>
              <span className="text-xs text-neutral-500">across {p.totals.members} member(s)</span>

              {mine && (
                <span className="rounded-md border border-emerald-800 bg-emerald-950/50 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                  You earned {fmtMoney(mine.total)}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => exportPdf(p)}
                  className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800"
                >
                  ⬇ PDF
                </button>
                <button
                  onClick={() => exportCsv(p)}
                  className="rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs font-semibold text-neutral-400 hover:bg-neutral-800"
                >
                  CSV
                </button>
                {isAdmin && (
                  <button
                    onClick={() => removePayout(p)}
                    title="Unpublish this payout"
                    className="rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs font-semibold text-neutral-600 hover:border-red-900 hover:text-red-400"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="border-t border-neutral-800 px-5 pb-5 pt-4">
                <p className="text-xs text-neutral-600">
                  chain {fmtMoney(p.totals.sumChain)} + retals {fmtMoney(p.totals.sumRetal)} + split{" "}
                  {fmtMoney(p.totals.distributed)} · from a {fmtMoney(p.totals.prize)} pool · locked{" "}
                  {fmtDate(p.saved_at)}
                  {p.members?.name ? ` by ${p.members.name}` : ""}
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase text-neutral-500">
                      <tr>
                        <th className="py-1.5 pr-3">Member</th>
                        <th className="py-1.5 pr-3">Respect</th>
                        <th className="py-1.5 pr-3">Hits</th>
                        {cfg.includeOutside && <th className="py-1.5 pr-3">Outside</th>}
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
                      {p.lines.map((r) => {
                        const isMe = Number(r.member_id) === meId;
                        return (
                          <tr
                            key={r.member_id}
                            className={`border-t border-neutral-800 ${
                              isMe ? "bg-emerald-950/30" : ""
                            }`}
                          >
                            <td
                              className={`py-2 pr-3 font-medium ${
                                isMe ? "text-emerald-200" : ""
                              }`}
                            >
                              {r.name}
                              {isMe && <span className="ml-1.5 text-xs text-emerald-500">you</span>}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-400">
                              {fmtNum(r.respect)}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-400">
                              {r.war_hits}
                            </td>
                            {cfg.includeOutside && (
                              <td className="py-2 pr-3 tabular-nums text-neutral-400">
                                {r.outside_hits || "—"}
                              </td>
                            )}
                            <td className="py-2 pr-3 tabular-nums text-sky-300">
                              {r.retaliations || "—"}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-emerald-400">
                              {r.saves || "—"}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-400">
                              {r.assists || "—"}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-500">
                              {fmtMoney(r.chainPay)}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-500">
                              {fmtMoney(r.retalPay)}
                            </td>
                            <td className="py-2 pr-3 tabular-nums text-neutral-300">
                              {fmtMoney(r.share)}
                            </td>
                            <td className="py-2 font-bold tabular-nums text-emerald-300">
                              {fmtMoney(r.total)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
