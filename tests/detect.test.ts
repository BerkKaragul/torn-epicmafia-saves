import { describe, expect, test } from "vitest";
import {
  detect,
  type ChainObservation,
  type DetectorConfig,
} from "../supabase/functions/_shared/logic/detect.ts";

const cfg: DetectorConfig = { saveThresholdS: 90, alertThresholdS: 90, slackS: 5 };

const obs = (o: Partial<ChainObservation> = {}): ChainObservation => ({
  polledAt: 1000,
  chainId: 0,
  current: 0,
  max: 10,
  timeoutS: 0,
  cooldownS: 0,
  ...o,
});

const active = (o: Partial<ChainObservation> = {}): ChainObservation =>
  obs({ chainId: 777, current: 5, max: 25, timeoutS: 290, ...o });

describe("detect: chain lifecycle", () => {
  test("emits chain_started when a chain appears from idle", () => {
    const events = detect(obs({ polledAt: 1000 }), active({ polledAt: 1015, current: 3 }), cfg);
    expect(events).toContainEqual({ type: "chain_started", chainId: 777, at: 1015 });
    expect(events).toContainEqual({
      type: "hits_observed",
      chainId: 777,
      fromCount: 0,
      toCount: 3,
    });
    expect(events.filter((e) => e.type === "save_candidate")).toHaveLength(0);
  });

  test("emits only chain_started when booting mid-chain (no previous observation)", () => {
    const events = detect(null, active({ polledAt: 1015, current: 12 }), cfg);
    expect(events).toEqual([{ type: "chain_started", chainId: 777, at: 1015 }]);
  });

  test("returns no events for identical idle observations", () => {
    expect(detect(obs({ polledAt: 1000 }), obs({ polledAt: 1015 }), cfg)).toEqual([]);
  });

  test("returns no events when the chain ticks down without hits, timer still high", () => {
    const events = detect(
      active({ polledAt: 1000, timeoutS: 290 }),
      active({ polledAt: 1015, timeoutS: 275 }),
      cfg,
    );
    expect(events).toEqual([]);
  });

  test("emits chain_ended (dropped) when the chain vanishes without cooldown", () => {
    const events = detect(
      active({ polledAt: 1000, current: 137, timeoutS: 4 }),
      obs({ polledAt: 1015 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "chain_ended", chainId: 777, finalCount: 137, reason: "dropped" },
    ]);
  });

  test("emits chain_ended (completed) when cooldown appears after the chain", () => {
    const events = detect(
      active({ polledAt: 1000, current: 250, max: 250, timeoutS: 3 }),
      obs({ polledAt: 1015, cooldownS: 3600 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "chain_ended", chainId: 777, finalCount: 250, reason: "completed" },
    ]);
  });

  test("emits chain_ended (completed) when the same chain id enters cooldown", () => {
    const events = detect(
      active({ polledAt: 1000, current: 250, max: 250, timeoutS: 3 }),
      active({ polledAt: 1015, current: 250, max: 250, timeoutS: 0, cooldownS: 3600 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "chain_ended", chainId: 777, finalCount: 250, reason: "completed" },
    ]);
    // a later poll during the same cooldown must not re-emit chain_ended
    const later = detect(
      active({ polledAt: 1015, current: 250, max: 250, timeoutS: 0, cooldownS: 3600 }),
      active({ polledAt: 1030, current: 250, max: 250, timeoutS: 0, cooldownS: 3585 }),
      cfg,
    );
    expect(later).toEqual([]);
  });

  test("emits chain_ended (dropped) for a non-milestone count even though cooldown follows", () => {
    // Torn cools down after EVERY chain end (6s/hit), so cooldown presence
    // must not imply completion — only ending exactly on a milestone does.
    const events = detect(
      active({ polledAt: 1000, current: 137, max: 250, timeoutS: 2 }),
      obs({ polledAt: 1015, cooldownS: 822 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "chain_ended", chainId: 777, finalCount: 137, reason: "dropped" },
    ]);
  });

  test("emits chain_ended (completed) on a milestone count even without observed cooldown", () => {
    const events = detect(
      active({ polledAt: 1000, current: 100, max: 250, timeoutS: 2 }),
      obs({ polledAt: 1015 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "chain_ended", chainId: 777, finalCount: 100, reason: "completed" },
    ]);
  });

  test("handles one chain replaced by another within a single window", () => {
    const events = detect(
      active({ polledAt: 1000, current: 9 }),
      obs({ polledAt: 1015, chainId: 888, current: 1, timeoutS: 295, max: 10 }),
      cfg,
    );
    expect(events).toContainEqual({
      type: "chain_ended",
      chainId: 777,
      finalCount: 9,
      reason: "unknown",
    });
    expect(events).toContainEqual({ type: "chain_started", chainId: 888, at: 1015 });
    expect(events).toContainEqual({
      type: "hits_observed",
      chainId: 888,
      fromCount: 0,
      toCount: 1,
    });
  });
});

describe("detect: save candidates", () => {
  test("emits hits_observed without save_candidate when the timer was high", () => {
    const events = detect(
      active({ polledAt: 1000, current: 5, timeoutS: 290 }),
      active({ polledAt: 1015, current: 6, timeoutS: 295 }),
      cfg,
    );
    expect(events).toEqual([
      { type: "hits_observed", chainId: 777, fromCount: 5, toCount: 6 },
    ]);
  });

  test("emits save_candidate for the hit when the window's expected timeout dips below threshold", () => {
    const events = detect(
      active({ polledAt: 1000, current: 41, timeoutS: 60 }),
      active({ polledAt: 1020, current: 42, timeoutS: 290 }),
      cfg,
    );
    expect(events).toContainEqual({
      type: "save_candidate",
      chainId: 777,
      chainCount: 42,
      windowStart: 1000,
      windowEnd: 1020,
      timeoutAtWindowStart: 60,
    });
  });

  test("emits a save_candidate only for the first hit of a multi-hit window", () => {
    const events = detect(
      active({ polledAt: 1000, current: 41, timeoutS: 60 }),
      active({ polledAt: 1020, current: 45, timeoutS: 280 }),
      cfg,
    );
    const candidates = events.filter((e) => e.type === "save_candidate");
    expect(candidates).toEqual([
      {
        type: "save_candidate",
        chainId: 777,
        chainCount: 42,
        windowStart: 1000,
        windowEnd: 1020,
        timeoutAtWindowStart: 60,
      },
    ]);
    expect(events).toContainEqual({
      type: "hits_observed",
      chainId: 777,
      fromCount: 41,
      toCount: 45,
    });
  });

  test("emits save_candidate across a long poller outage (expected timeout negative)", () => {
    const events = detect(
      active({ polledAt: 1000, current: 41, timeoutS: 100 }),
      active({ polledAt: 1400, current: 42, timeoutS: 250 }),
      cfg,
    );
    expect(events).toContainEqual({
      type: "save_candidate",
      chainId: 777,
      chainCount: 42,
      windowStart: 1000,
      windowEnd: 1400,
      timeoutAtWindowStart: 100,
    });
  });

  test("does not emit save_candidate when a hit lands with time comfortably left", () => {
    const events = detect(
      active({ polledAt: 1000, current: 41, timeoutS: 200 }),
      active({ polledAt: 1015, current: 42, timeoutS: 295 }),
      cfg,
    );
    expect(events.filter((e) => e.type === "save_candidate")).toHaveLength(0);
  });
});

describe("detect: timer_low alerts", () => {
  test("emits timer_low with a per-hit episode key at or below the alert threshold", () => {
    const events = detect(
      active({ polledAt: 1000, current: 12, timeoutS: 103 }),
      active({ polledAt: 1015, current: 12, timeoutS: 88 }),
      cfg,
    );
    expect(events).toEqual([
      {
        type: "timer_low",
        chainId: 777,
        current: 12,
        timeoutS: 88,
        episodeKey: "timer_low:777:12",
      },
    ]);
  });

  test("does not emit timer_low when a hit reset the timer above the threshold", () => {
    const events = detect(
      active({ polledAt: 1000, current: 12, timeoutS: 88 }),
      active({ polledAt: 1015, current: 13, timeoutS: 290 }),
      cfg,
    );
    expect(events.filter((e) => e.type === "timer_low")).toHaveLength(0);
    // the low-timer hit itself is still a save candidate
    expect(events.filter((e) => e.type === "save_candidate")).toHaveLength(1);
  });

  test("does not emit timer_low while idle or in cooldown", () => {
    expect(
      detect(obs({ polledAt: 1000 }), obs({ polledAt: 1015, cooldownS: 500 }), cfg),
    ).toEqual([]);
  });
});
