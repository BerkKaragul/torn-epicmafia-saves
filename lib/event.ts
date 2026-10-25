import { db } from "@/lib/db";
import type { ChainEventRow } from "@/lib/types";

// Event mode (see migration 0042): a time-boxed stretch where saves are paid
// without a ranked war. An event is "running" between started_at and its end —
// ends_at, or ended_at when an admin stopped it early.

export const EVENT_COLS =
  "id, name, theme, started_at, ends_at, ended_at, save_bonus, payout_totals, payout_saved_at";

export type EventSummary = Pick<
  ChainEventRow,
  | "id"
  | "name"
  | "theme"
  | "started_at"
  | "ends_at"
  | "ended_at"
  | "save_bonus"
  | "payout_totals"
  | "payout_saved_at"
>;

/** When the event stops (or stopped) counting. */
export function eventEnd(e: Pick<ChainEventRow, "ends_at" | "ended_at">): string {
  return e.ended_at ?? e.ends_at;
}

export function isEventRunning(
  e: Pick<ChainEventRow, "started_at" | "ends_at" | "ended_at">,
  nowMs = Date.now(),
): boolean {
  return Date.parse(e.started_at) <= nowMs && Date.parse(eventEnd(e)) > nowMs;
}

/**
 * The newest event — running or finished. Errors (e.g. the migration isn't
 * applied yet) read as "no event", so the rest of the site keeps working.
 */
export async function latestEvent(): Promise<EventSummary | null> {
  try {
    const { data, error } = await db()
      .from("chain_events")
      .select(EVENT_COLS)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle<EventSummary>();
    if (error) return null;
    return data ?? null;
  } catch {
    return null;
  }
}

// The layout asks on every page render; a few seconds of staleness is fine
// there and spares the database a query per navigation.
let cached: { at: number; value: EventSummary | null } | null = null;
const CACHE_MS = 15_000;

/** The running event, or null. */
export async function runningEvent(opts: { fresh?: boolean } = {}): Promise<EventSummary | null> {
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < CACHE_MS) {
    return cached.value && isEventRunning(cached.value, now) ? cached.value : null;
  }
  const latest = await latestEvent();
  cached = { at: now, value: latest };
  return latest && isEventRunning(latest, now) ? latest : null;
}

/** Drop the cached answer after an admin starts, edits or ends an event. */
export function forgetEventCache(): void {
  cached = null;
}
