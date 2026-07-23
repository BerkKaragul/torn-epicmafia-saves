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
  /** start warning this many hits before a chain bonus milestone */
  milestoneWarnHits: number;
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
      type: "milestone_near";
      chainId: number;
      current: number;
      /** the upcoming bonus hit (25, 50, 100, 250, …) */
      milestone: number;
      hitsAway: number;
    }
  | {
      type: "chain_ended";
      chainId: number;
      finalCount: number;
      reason: "completed" | "dropped" | "unknown";
    };

// Chain bonus milestones. Torn cools down after EVERY chain end (6s/hit),
// so "did it complete?" cannot be read from the cooldown field — a chain
// completed iff its final count sits exactly on a milestone.
const MILESTONE_LIST = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
];
const MILESTONES = new Set(MILESTONE_LIST);

/**
 * Milestones worth interrupting people for. 10 is just chain establishment
 * with a token bonus — warning about it would nag on every chain start.
 */
function nextBigMilestone(current: number): number | null {
  return MILESTONE_LIST.find((m) => m > current && m >= 25) ?? null;
}

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
  const sameChain = next.chainId === prev.chainId;

  // Hits on the same chain id are visible even when the chain just completed
  // into cooldown — the final hit (e.g. a milestone finisher) may itself be
  // the save, so this must run before/independently of the ended branch.
  const hitsVisible = prevActive && sameChain && next.current > prev.current;
  if (hitsVisible) {
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

  if (prevActive && (!nextActive || !sameChain)) {
    const finalCount = hitsVisible ? next.current : prev.current;
    events.push({
      type: "chain_ended",
      chainId: prev.chainId,
      finalCount,
      reason: nextActive ? "unknown" : MILESTONES.has(finalCount) ? "completed" : "dropped",
    });
  }

  if (nextActive && (!prevActive || !sameChain)) {
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

  if (nextActive) {
    // Bonus hits (25, 50, 100, 250 …) pay a huge fixed respect chunk. Losing
    // the chain just short of one is the worst outcome, so warn as it nears.
    const milestone = nextBigMilestone(next.current);
    if (milestone !== null && milestone - next.current <= cfg.milestoneWarnHits) {
      events.push({
        type: "milestone_near",
        chainId: next.chainId,
        current: next.current,
        milestone,
        hitsAway: milestone - next.current,
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
