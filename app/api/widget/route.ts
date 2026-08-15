import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rotationOrder } from "@/supabase/functions/_shared/logic/rotation";

// Public read-only feed for the Torn userscript widget. Returns only
// non-sensitive live state (saver names + chain timer) — no ids, keys or money
// — so it needs no auth: the widget just works, zero setup. Single-faction
// deployment, so there's only ever one faction's data to serve. CORS-open.
// A `token` param is still accepted (and ignored) so older installs that send
// one don't break.

export const dynamic = "force-dynamic";
const CORS = { "Access-Control-Allow-Origin": "*" };
const toS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Version signal for the userscript: it compares its own @version to these.
// `latest` → the widget shows a gentle "update available" nudge. `min` → the
// emergency kill floor; installs below it are asked to update and stop.
// Keep `min` well below any live version so nobody is disabled by accident —
// bump it ONLY to deliberately force-retire an old version.
const LATEST_WIDGET_VERSION = "1.8.0";
const MIN_WIDGET_VERSION = "1.0.0";

// Every faction member's userscript polls this from every open Torn tab (and
// faster while a chain is in danger). The payload is IDENTICAL for everyone
// (single faction, unauthenticated), so without this each poll would recompute
// it from 3 DB reads — the thing that drove Fluid Active CPU up. A short
// in-memory cache collapses a burst of polls to one DB read per window on each
// warm instance (helps EVERY install, even ones that cache-bust the URL). TTL
// is kept to 2s: long enough to absorb load, short enough that a fresh poller
// reading (e.g. a save that just reset the timer) reaches clients quickly — it
// matters in war, where a stale reading keeps the siren wailing after the hit.
const CACHE_MS = 2000;
let cache: { at: number; status: number; body: string } | null = null;

const RESPONSE_HEADERS = {
  ...CORS,
  "Content-Type": "application/json",
  "Cache-Control": "public, s-maxage=2, stale-while-revalidate=10",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_MS) {
    const fresh = await buildFeed();
    cache = { at: now, status: fresh.status, body: fresh.body };
  }
  return new NextResponse(cache.body, { status: cache.status, headers: RESPONSE_HEADERS });
}

async function buildFeed(): Promise<{ status: number; body: string }> {
  const { data: settings } = await db()
    .from("settings")
    .select("saving_enabled, alert_threshold_s")
    .eq("id", 1)
    .single();
  if (!settings) {
    return { status: 503, body: JSON.stringify({ error: "not ready" }) };
  }

  const [{ data: state }, { data: shifts }] = await Promise.all([
    db()
      .from("poller_state")
      .select("last_chain_id, last_current, last_max, last_timeout_s, last_cooldown_s, last_poll_at")
      .eq("id", 1)
      .maybeSingle(),
    db()
      .from("shifts")
      .select(
        "member_id, started_at, last_save_at, unavailable_state, location, deprioritized_at, members!inner(name)",
      )
      .is("ended_at", null),
  ]);

  type Row = {
    member_id: number;
    started_at: string;
    last_save_at: string | null;
    unavailable_state: string | null;
    location: string | null;
    deprioritized_at: string | null;
    members: { name: string } | { name: string }[];
  };
  const active = (shifts ?? []) as Row[];
  const nameOf = (id: number) => {
    const s = active.find((x) => x.member_id === id);
    if (!s) return null;
    return Array.isArray(s.members) ? (s.members[0]?.name ?? null) : s.members.name;
  };
  const locationOf = (id: number) => active.find((x) => x.member_id === id)?.location ?? null;

  const order = rotationOrder(
    active.map((s) => ({
      memberId: s.member_id,
      startedAt: toS(s.started_at),
      lastSaveAt: s.last_save_at ? toS(s.last_save_at) : null,
      available: !s.unavailable_state,
      deprioritizedAt: s.deprioritized_at ? toS(s.deprioritized_at) : null,
    })),
  );

  const body = JSON.stringify({
    ok: true,
    latest_version: LATEST_WIDGET_VERSION,
    min_version: MIN_WIDGET_VERSION,
    saving_enabled: settings.saving_enabled,
    alert_threshold_s: settings.alert_threshold_s,
    chain: {
      id: state?.last_chain_id ?? 0,
      current: state?.last_current ?? 0,
      max: state?.last_max ?? 0,
      timeout_s: state?.last_timeout_s ?? 0,
      cooldown_s: state?.last_cooldown_s ?? 0,
      observed_at: state?.last_poll_at ? toS(state.last_poll_at) : 0,
    },
    turn: order[0] ? nameOf(order[0]) : null,
    turn_location: order[0] ? locationOf(order[0]) : null,
    next: order[1] ? nameOf(order[1]) : null,
    next_location: order[1] ? locationOf(order[1]) : null,
    on_duty: order.length,
    total_on_duty: active.length,
    // all on-duty saver names (already public) so the widget can tell whether
    // the viewer is currently a saver, for the "only alarm when I'm saving" opt
    on_duty_names: active.map((s) => nameOf(s.member_id)).filter(Boolean),
  });
  return { status: 200, body };
}
