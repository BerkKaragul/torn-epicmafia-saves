// ChainWatch server entry point on the VPS. It stands in for three Supabase
// pieces at once:
//   - pg_cron + pg_net + Edge Function: runs the same poll cycle in a loop,
//     one cycle at a time, a fresh one every POLL_MS
//   - Realtime broadcast: the cycle still POSTs its "poke" to
//     /realtime/v1/api/broadcast (Caddy routes that here), and we fan it out
//     to browsers over Server-Sent Events at /realtime/v1/events
// The cycle itself (supabase/functions/poller/cycle.ts) is unchanged and
// talks to PostgREST through SUPABASE_URL, as it did on Supabase.

import { runPollCycle } from "../supabase/functions/poller/cycle.ts";

const POLL_MS = 10_000;
// on the shared "web" machine projects live in their own port range
const PORT = Number(Deno.env.get("PORT") ?? 3100);
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── poke fan-out (SSE) ────────────────────────────────────────────────────
const enc = new TextEncoder();
const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

function send(c: ReadableStreamDefaultController<Uint8Array>, chunk: string) {
  try {
    c.enqueue(enc.encode(chunk));
  } catch {
    listeners.delete(c); // that browser is gone
  }
}

// a comment line every 25s keeps proxies and phones from dropping idle streams
setInterval(() => listeners.forEach((c) => send(c, ": ping\n\n")), 25_000);

const CORS = { "Access-Control-Allow-Origin": "*" };

Deno.serve({ hostname: "127.0.0.1", port: PORT }, (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/realtime/v1/api/broadcast" && req.method === "POST") {
    // only the poller may poke; the event carries no data either way
    if (req.headers.get("authorization") !== `Bearer ${SERVICE_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    listeners.forEach((c) => send(c, "event: poke\ndata: {}\n\n"));
    return new Response(null, { status: 202 });
  }

  if (pathname === "/realtime/v1/events" && req.method === "GET") {
    let me: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        me = c;
        listeners.add(c);
        send(c, "retry: 3000\n\n");
      },
      cancel() {
        listeners.delete(me);
      },
    });
    return new Response(body, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  return new Response("not found", { status: 404 });
});

// ── poll loop ──────────────────────────────────────────────────────────────
// Sequential, unlike pg_cron's fire-and-forget: a slow cycle delays the next
// one instead of overlapping it.
async function loop() {
  for (;;) {
    const started = Date.now();
    try {
      await runPollCycle();
    } catch (e) {
      console.error("poll cycle failed:", e);
    }
    const wait = POLL_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

if (Deno.env.get("POLL_DISABLED") !== "1") loop();
