// Poller entry point. pg_cron → pg_net POSTs here every 15s. pg_net's request
// timeout is shorter than a full poll cycle, so we ACK with 202 immediately
// and do the real work in a background task.

import { runPollCycle } from "./cycle.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((req: Request) => {
  const secret = Deno.env.get("POLLER_SECRET");
  if (!secret || req.headers.get("x-poller-secret") !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  EdgeRuntime.waitUntil(
    runPollCycle().catch((e) => console.error("poll cycle failed:", e)),
  );
  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
});
