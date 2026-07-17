// Pure chain state machine: compares two consecutive observations of
// /v2/faction/chain and emits events. No I/O, no clocks — fully unit-testable.
//
// Save detection principle: between polls the chain timer decreases exactly
// 1s/s unless a hit resets it. If the timer, extrapolated from the previous
// observation, would have dipped to or below the save threshold by the end of
// the window, the FIRST hit of the window is a save candidate (its precise
// seconds-remaining is computed later during attribution, from the attack's
// real `ended` timestamp). Hits after the first in the same window happened
// post-reset with a near-full timer and are never candidates.

export interface ChainObservation {
  /** unix seconds at which /faction/chain was observed */
  polledAt: number;
  /** 0 when no chain is running */
  chainId: number;
  current: number;
  max: number;
  /** seconds remaining before the chain drops, at polledAt */
  timeoutS: number;
  /** post-chain cooldown seconds; > 0 means the chain completed a milestone */
  cooldownS: number;
}

export interface DetectorConfig {
  /** a hit landing with <= this many seconds remaining is a save */
  saveThresholdS: number;
  /** emit timer_low when the observed timer is at or below this */
  alertThresholdS: number;
  /** tolerance added to saveThresholdS to absorb API timing jitter */
  slackS: number;
}

export type ChainEvent =
  | { type: "chain_started"; chainId: number; at: number }
  | { type: "hits_observed"; chainId: number; fromCount: number; toCount: number }
  | {
      type: "save_candidate";
      chainId: number;
      /** the `chain` counter value of the saving hit */
      chainCount: number;
      windowStart: number;
      windowEnd: number;
      timeoutAtWindowStart: number;
    }
  | { type: "timer_low"; chainId: number; current: number; timeoutS: number; episodeKey: string }
  | {
      type: "chain_ended";
      chainId: number;
      finalCount: number;
      reason: "completed" | "dropped" | "unknown";
    };

// Chain bonus milestones. Torn cools down after EVERY chain end (6s/hit),
// so "did it complete?" cannot be read from the cooldown field — a chain
// completed iff its final count sits exactly on a milestone.
const MILESTONES = new Set([
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
]);

function isActive(o: ChainObservation): boolean {
  return o.chainId > 0 && o.current > 0 && o.cooldownS === 0;
}

export function detect(
  prev: ChainObservation | null,
  next: ChainObservation,
  cfg: DetectorConfig,
): ChainEvent[] {
  const events: ChainEvent[] = [];
  const nextActive = isActive(next);

  if (prev === null) {
    // Booting mid-world: report an active chain but fabricate no hit window.
    if (nextActive) events.push({ type: "chain_started", chainId: next.chainId, at: next.polledAt });
    return events;
  }

  const prevActive = isActive(prev);

  if (prevActive && (!nextActive || next.chainId !== prev.chainId)) {
    events.push({
      type: "chain_ended",
      chainId: prev.chainId,
      finalCount: prev.current,
      reason: nextActive ? "unknown" : MILESTONES.has(prev.current) ? "completed" : "dropped",
    });
  }

  if (nextActive && (!prevActive || next.chainId !== prev.chainId)) {
    events.push({ type: "chain_started", chainId: next.chainId, at: next.polledAt });
    if (next.current > 0) {
      events.push({
        type: "hits_observed",
        chainId: next.chainId,
        fromCount: 0,
        toCount: next.current,
      });
    }
  }

  if (prevActive && nextActive && next.chainId === prev.chainId && next.current > prev.current) {
    events.push({
      type: "hits_observed",
      chainId: next.chainId,
      fromCount: prev.current,
      toCount: next.current,
    });
    const expectedTimeoutAtWindowEnd = prev.timeoutS - (next.polledAt - prev.polledAt);
    if (expectedTimeoutAtWindowEnd <= cfg.saveThresholdS + cfg.slackS) {
      events.push({
        type: "save_candidate",
        chainId: next.chainId,
        chainCount: prev.current + 1,
        windowStart: prev.polledAt,
        windowEnd: next.polledAt,
        timeoutAtWindowStart: prev.timeoutS,
      });
    }
  }

  if (nextActive && next.timeoutS <= cfg.alertThresholdS) {
    events.push({
      type: "timer_low",
      chainId: next.chainId,
      current: next.current,
      timeoutS: next.timeoutS,
      episodeKey: `timer_low:${next.chainId}:${next.current}`,
    });
  }

  return events;
}
