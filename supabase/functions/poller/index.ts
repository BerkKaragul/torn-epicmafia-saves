// Poller entry point. pg_cron → pg_net POSTs here every 10s. pg_net's request
// timeout is shorter than a full poll cycle, so we ACK with 202 immediately
// and do the real work in a background task.
//
// One invocation serves every faction with an active subscription: each gets
// its own cycle (which returns early when that faction isn't due yet), a few
// at a time and within a time budget, while the billing sweep runs alongside.

import { runPollCycle, sb, type FactionTarget } from "./cycle.ts";
import { runBillingSweep } from "./billing.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

/** Factions polled in parallel. Each uses its own members' keys, so Torn's
 * per-user rate limit isn't shared; this only bounds our own fan-out. */
const CONCURRENCY = 8;
/** Stop starting new cycles after this long, so one invocation never runs
 * into the next tick's; whoever is left goes first next time (stalest first). */
const START_BUDGET_MS = 35_000;

type Row = FactionTarget & {
  poller_state: { last_poll_at: string | null } | { last_poll_at: string | null }[] | null;
};
const lastPollMs = (r: Row) => {
  const ps = Array.isArray(r.poller_state) ? r.poller_state[0] : r.poller_state;
  return ps?.last_poll_at ? Date.parse(ps.last_poll_at) : 0;
};

async function runAll(): Promise<void> {
  const startedAt = Date.now();
  const db = sb();

  // billing runs alongside the faction cycles, never queued behind them
  const billing = runBillingSweep(db).catch((e) => console.error("billing sweep failed:", e));

  const { data: factions, error } = await db
    .from("factions")
    .select("faction_id, realtime_topic, poller_state(last_poll_at)")
    .eq("suspended", false)
    .gt("subscription_expires_at", new Date().toISOString())
    .returns<Row[]>();
  if (error) {
    console.error("could not list factions:", error);
    await billing;
    return;
  }

  // stalest first: if the budget runs out, the ones that waited longest
  // already went, and the rest lead the next invocation
  const queue: FactionTarget[] = (factions ?? [])
    .sort((a, b) => lastPollMs(a) - lastPollMs(b))
    .map((f) => ({ faction_id: f.faction_id, realtime_topic: f.realtime_topic }));
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (Date.now() - startedAt > START_BUDGET_MS) return;
      try {
        await runPollCycle(db, f);
      } catch (e) {
        console.error(`[${f.faction_id}] poll cycle failed:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (queue.length) console.warn(`${queue.length} faction(s) deferred to the next tick`);
  await billing;
}

Deno.serve((req: Request) => {
  const secret = Deno.env.get("POLLER_SECRET");
  if (!secret || req.headers.get("x-poller-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  EdgeRuntime.waitUntil(runAll().catch((e) => console.error("poller run failed:", e)));
  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
});
