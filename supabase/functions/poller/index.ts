// Poller entry point. pg_cron → pg_net POSTs here every 10s. pg_net's request
// timeout is shorter than a full poll cycle, so we ACK with 202 immediately
// and do the real work in a background task.
//
// One invocation serves every faction with an active subscription: each gets
// its own cycle (which returns early when that faction isn't due yet), a few
// at a time, then the billing sweep runs.

import { runPollCycle, sb, type FactionTarget } from "./cycle.ts";
import { runBillingSweep } from "./billing.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

/** Factions polled in parallel. Each uses its own members' keys, so Torn's
 * per-user rate limit isn't shared; this only bounds our own fan-out. */
const CONCURRENCY = 8;

async function runAll(): Promise<void> {
  const db = sb();
  const { data: factions, error } = await db
    .from("factions")
    .select("faction_id, realtime_topic")
    .eq("suspended", false)
    .gt("subscription_expires_at", new Date().toISOString());
  if (error) {
    console.error("could not list factions:", error);
    return;
  }

  const queue: FactionTarget[] = [...(factions ?? [])];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        await runPollCycle(db, f);
      } catch (e) {
        console.error(`[${f.faction_id}] poll cycle failed:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  await runBillingSweep(db).catch((e) => console.error("billing sweep failed:", e));
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
