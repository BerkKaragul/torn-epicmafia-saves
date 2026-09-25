// The war payout maths, shared by the admin calculator (live preview) and the
// API that freezes a war's final numbers. Keeping it pure means the snapshot
// the members read at /payouts is recomputed server-side from the war report
// rather than trusted from the browser — and it's testable on its own.

export interface WarPayoutConfig {
  pool: number;
  retalFixed: number;
  /** respect pool gets respectPct% of the leftover, the hit pool the rest */
  respectPct: number;
  /** saves/assists draw from BOTH pools: a hit factor and a score factor */
  saveAsHits: number;
  assistAsHits: number;
  saveScore: number;
  assistScore: number;
  /** outside hits are normally NOT paid; opting in counts them as fictional hits */
  includeOutside: boolean;
  outsideAsHits: number;
}

export const DEFAULT_CONFIG: WarPayoutConfig = {
  pool: 0,
  retalFixed: 900_000,
  respectPct: 75,
  saveAsHits: 1,
  assistAsHits: 1,
  saveScore: 1,
  assistScore: 1,
  includeOutside: false,
  outsideAsHits: 1,
};

/** One row of the `war_report` RPC. */
export interface WarReportRow {
  member_id: number;
  name: string;
  respect: number;
  war_hits: number;
  outside_hits: number;
  retaliations: number;
  assists: number;
  saves: number;
  save_seconds: number;
  chain_pay: number;
}

export interface WarPayoutRow {
  member_id: number;
  name: string;
  respect: number;
  war_hits: number;
  outside_hits: number;
  retaliations: number;
  assists: number;
  saves: number;
  chainPay: number;
  retalPay: number;
  /** their cut of the leftover prize pool */
  share: number;
  total: number;
}

export interface WarPayout {
  rows: WarPayoutRow[];
  /** total chain-hour pay paid off the top */
  sumChain: number;
  /** total retal pay paid off the top */
  sumRetal: number;
  /** what the respect/hit pools actually handed out */
  distributed: number;
  /** the whole prize as entered */
  prize: number;
  respectPerUnit: number;
  hitPerUnit: number;
  /** chain pay + retals already eat the entire pool — nothing left to split */
  overspent: boolean;
}

/**
 * Each member's total = chain-hour pay + retal pay (fixed each) + a share of
 * what's left of the prize. A respect pool (respectPct%) is shared by respect
 * and a hit pool (the rest) by war hits, with saves/assists as fictional hits.
 * Each pool is normalised within itself; empty pools are dropped so nothing is
 * lost. Largest-remainder keeps the integer shares summing exactly to what was
 * actually distributed.
 */
export function computeWarPayout(
  report: WarReportRow[],
  config: WarPayoutConfig,
): WarPayout {
  const prize = Math.max(0, Math.round(config.pool));
  const retalFixed = Math.max(0, config.retalFixed);

  const base = report.map((r) => ({
    member_id: Number(r.member_id),
    name: r.name,
    respect: Number(r.respect),
    war_hits: Number(r.war_hits),
    outside_hits: Number(r.outside_hits),
    retaliations: Number(r.retaliations),
    assists: Number(r.assists),
    saves: Number(r.saves),
    chainPay: Math.round(Number(r.chain_pay)),
    retalPay: Math.round(Number(r.retaliations) * retalFixed),
  }));

  const sumChain = base.reduce((s, r) => s + r.chainPay, 0);
  const sumRetal = base.reduce((s, r) => s + r.retalPay, 0);
  const distributable = Math.max(0, prize - sumChain - sumRetal);

  // Two category pools of the leftover: a respect pool (respectPct%) and a hit
  // pool (the rest). Saves and assists draw from BOTH — each is a fictional war
  // hit: it counts as N hits in the hit pool, and carries a fictional respect
  // score (N × the respect an average war hit earned) in the respect pool.
  // Outside hits are only in the hit pool, and only when the admin opts in.
  const pct = Math.min(100, Math.max(0, config.respectPct));
  const totalRespect = base.reduce((s, r) => s + r.respect, 0);
  const totalHits = base.reduce((s, r) => s + r.war_hits, 0);
  const respectPerHit = totalHits > 0 ? totalRespect / totalHits : 0;
  // hit factor → hit pool; score factor → respect pool (in avg-hit respect)
  const ficHits = (r: (typeof base)[number]) =>
    config.saveAsHits * r.saves +
    config.assistAsHits * r.assists +
    (config.includeOutside ? config.outsideAsHits * r.outside_hits : 0);
  const ficRespect = (r: (typeof base)[number]) =>
    respectPerHit * (config.saveScore * r.saves + config.assistScore * r.assists);
  const categories: { key: string; w: number; vals: number[] }[] = [
    { key: "respect", w: pct, vals: base.map((r) => r.respect + ficRespect(r)) },
    { key: "hit", w: 100 - pct, vals: base.map((r) => r.war_hits + ficHits(r)) },
  ];

  // only categories with a positive weight AND something to divide take a cut
  const active = categories
    .map((c) => ({ ...c, total: c.vals.reduce((a, b) => a + b, 0) }))
    .filter((c) => c.w > 0 && c.total > 0);
  const wTotal = active.reduce((s, c) => s + c.w, 0);

  const shares = base.map(() => 0);
  let respectPerUnit = 0;
  let hitPerUnit = 0;
  if (wTotal > 0) {
    for (const c of active) {
      const catPool = (c.w / wTotal) * distributable;
      const perUnit = c.total > 0 ? catPool / c.total : 0;
      if (c.key === "respect") respectPerUnit = perUnit;
      if (c.key === "hit") hitPerUnit = perUnit;
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
  return {
    rows,
    sumChain,
    sumRetal,
    distributed,
    prize,
    respectPerUnit,
    hitPerUnit,
    overspent: prize > 0 && sumChain + sumRetal > prize,
  };
}

/** Coerce an arbitrary jsonb blob into a full config, filling gaps with defaults. */
export function normalizeConfig(raw: unknown): WarPayoutConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof WarPayoutConfig) => {
    const n = Number(o[k]);
    return Number.isFinite(n) && n >= 0 ? n : (DEFAULT_CONFIG[k] as number);
  };
  return {
    pool: num("pool"),
    retalFixed: num("retalFixed"),
    respectPct: num("respectPct"),
    saveAsHits: num("saveAsHits"),
    assistAsHits: num("assistAsHits"),
    saveScore: num("saveScore"),
    assistScore: num("assistScore"),
    outsideAsHits: num("outsideAsHits"),
    includeOutside: Boolean(o.includeOutside),
  };
}

export interface ActionValues {
  /** respect an average war hit earned in this war */
  respectPerHit: number;
  /** what one average war hit took from the split (hit pool + its respect) */
  hit: number;
  save: number;
  assist: number;
  /** fixed retal pay, paid on top of the hit itself */
  retal: number;
  /** null when outside hits weren't paid */
  outside: number | null;
}

/**
 * "What was one hit / save / assist worth?" for a frozen war — an illustration
 * for members, not part of the payout. An average war hit earns hitPerUnit from
 * the hit pool plus (its average respect × respectPerUnit) from the respect
 * pool; saves and assists are fictional hits by construction, so their values
 * are the same formula with their factors. Real hits differ from the average by
 * how much respect each one actually scored.
 *
 * Re-derived from the frozen lines rather than stored totals, so it works for
 * every published war: rows dropped from a snapshot had nothing in either pool,
 * so rerunning the split on the lines gives the same per-unit rates.
 */
export function actionValues(lines: WarPayoutRow[], config: WarPayoutConfig): ActionValues {
  const report: WarReportRow[] = lines.map((l) => ({
    member_id: l.member_id,
    name: l.name,
    respect: l.respect,
    war_hits: l.war_hits,
    outside_hits: l.outside_hits,
    retaliations: l.retaliations,
    assists: l.assists,
    saves: l.saves,
    save_seconds: 0,
    chain_pay: l.chainPay,
  }));
  const { respectPerUnit, hitPerUnit } = computeWarPayout(report, config);
  const totalRespect = report.reduce((s, r) => s + Number(r.respect), 0);
  const totalHits = report.reduce((s, r) => s + Number(r.war_hits), 0);
  const respectPerHit = totalHits > 0 ? totalRespect / totalHits : 0;
  const scoreValue = respectPerHit * respectPerUnit;
  return {
    respectPerHit,
    hit: hitPerUnit + scoreValue,
    save: config.saveAsHits * hitPerUnit + config.saveScore * scoreValue,
    assist: config.assistAsHits * hitPerUnit + config.assistScore * scoreValue,
    retal: config.retalFixed,
    outside: config.includeOutside ? config.outsideAsHits * hitPerUnit : null,
  };
}
