import { describe, expect, test } from "vitest";
import {
  computeWarPayout,
  DEFAULT_CONFIG,
  normalizeConfig,
  type WarPayoutConfig,
  type WarReportRow,
} from "../lib/warPayout.ts";

const row = (r: Partial<WarReportRow> & { member_id: number; name: string }): WarReportRow => ({
  respect: 0,
  war_hits: 0,
  outside_hits: 0,
  retaliations: 0,
  assists: 0,
  saves: 0,
  save_seconds: 0,
  chain_pay: 0,
  ...r,
});

const cfg = (over: Partial<WarPayoutConfig> = {}): WarPayoutConfig => ({
  ...DEFAULT_CONFIG,
  pool: 1_000_000_000,
  retalFixed: 0,
  ...over,
});

describe("computeWarPayout", () => {
  test("the whole pool is handed out, to the dollar", () => {
    const p = computeWarPayout(
      [
        row({ member_id: 1, name: "A", respect: 300, war_hits: 30 }),
        row({ member_id: 2, name: "B", respect: 210, war_hits: 31 }),
        row({ member_id: 3, name: "C", respect: 97, war_hits: 7 }),
      ],
      cfg(),
    );
    expect(p.distributed).toBe(1_000_000_000);
    expect(p.rows.reduce((s, r) => s + r.total, 0)).toBe(1_000_000_000);
  });

  test("chain pay and retals come off the top, the rest is split", () => {
    const p = computeWarPayout(
      [
        row({ member_id: 1, name: "A", respect: 100, war_hits: 10, chain_pay: 5_000_000 }),
        row({ member_id: 2, name: "B", respect: 100, war_hits: 10, retaliations: 2 }),
      ],
      cfg({ pool: 100_000_000, retalFixed: 1_000_000 }),
    );
    expect(p.sumChain).toBe(5_000_000);
    expect(p.sumRetal).toBe(2_000_000);
    expect(p.distributed).toBe(100_000_000 - 5_000_000 - 2_000_000);
    // identical respect + hits, so the split is even; the extras sit on top
    const [a, b] = p.rows.slice().sort((x, y) => x.member_id - y.member_id);
    expect(a.share).toBe(b.share);
    expect(a.total).toBe(a.share + 5_000_000);
    expect(b.total).toBe(b.share + 2_000_000);
  });

  test("an empty pool is dropped rather than losing its slice", () => {
    // nobody landed a war hit, so the hit pool has nothing to divide — its 25%
    // must fall through to the respect pool instead of vanishing
    const p = computeWarPayout(
      [
        row({ member_id: 1, name: "A", respect: 60 }),
        row({ member_id: 2, name: "B", respect: 40 }),
      ],
      cfg({ pool: 1_000_000, respectPct: 75 }),
    );
    expect(p.distributed).toBe(1_000_000);
    expect(p.rows.find((r) => r.member_id === 1)!.share).toBe(600_000);
  });

  test("saves draw from both pools, assists and outside hits from theirs", () => {
    const base = [
      row({ member_id: 1, name: "Fighter", respect: 100, war_hits: 10 }),
      row({ member_id: 2, name: "Saver", saves: 5 }),
    ];
    const paid = computeWarPayout(base, cfg({ saveAsHits: 1, saveScore: 1 }));
    const unpaid = computeWarPayout(base, cfg({ saveAsHits: 0, saveScore: 0 }));
    expect(paid.rows.find((r) => r.member_id === 2)!.share).toBeGreaterThan(0);
    expect(unpaid.rows.find((r) => r.member_id === 2)).toBeUndefined();
  });

  test("outside hits pay nothing unless the admin opts in", () => {
    const base = [
      row({ member_id: 1, name: "A", war_hits: 10 }),
      row({ member_id: 2, name: "B", outside_hits: 10 }),
    ];
    const off = computeWarPayout(base, cfg({ respectPct: 0 }));
    const on = computeWarPayout(base, cfg({ respectPct: 0, includeOutside: true }));
    expect(off.rows.find((r) => r.member_id === 2)).toBeUndefined();
    expect(on.rows.find((r) => r.member_id === 2)!.share).toBe(
      on.rows.find((r) => r.member_id === 1)!.share,
    );
  });

  test("overspending the pool is flagged and never goes negative", () => {
    const p = computeWarPayout(
      [row({ member_id: 1, name: "A", war_hits: 5, chain_pay: 900, retaliations: 1 })],
      cfg({ pool: 1000, retalFixed: 500 }),
    );
    expect(p.overspent).toBe(true);
    expect(p.distributed).toBe(0);
    expect(p.rows[0].total).toBe(1400);
  });

  test("members owed nothing are left off the payout", () => {
    const p = computeWarPayout(
      [
        row({ member_id: 1, name: "A", respect: 100, war_hits: 10 }),
        row({ member_id: 2, name: "Ghost" }),
      ],
      cfg(),
    );
    expect(p.rows.map((r) => r.name)).toEqual(["A"]);
  });
});

describe("normalizeConfig", () => {
  test("fills gaps with defaults and rejects junk", () => {
    const c = normalizeConfig({ pool: 500, respectPct: "bad", includeOutside: 1 });
    expect(c.pool).toBe(500);
    expect(c.respectPct).toBe(DEFAULT_CONFIG.respectPct);
    expect(c.retalFixed).toBe(DEFAULT_CONFIG.retalFixed);
    expect(c.includeOutside).toBe(true);
  });

  test("negative values fall back rather than inverting the maths", () => {
    expect(normalizeConfig({ retalFixed: -5 }).retalFixed).toBe(DEFAULT_CONFIG.retalFixed);
  });
});
