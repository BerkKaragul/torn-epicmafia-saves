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

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  const { data: settings } = await db()
    .from("settings")
    .select("saving_enabled, alert_threshold_s")
    .eq("id", 1)
    .single();
  if (!settings) {
    return NextResponse.json({ error: "not ready" }, { status: 503, headers: CORS });
  }

  const [{ data: state }, { data: shifts }] = await Promise.all([
    db()
      .from("poller_state")
      .select("last_chain_id, last_current, last_max, last_timeout_s, last_cooldown_s, last_poll_at")
      .eq("id", 1)
      .maybeSingle(),
    db()
      .from("shifts")
      .select("member_id, started_at, last_save_at, unavailable_state, members!inner(name)")
      .is("ended_at", null),
  ]);

  type Row = {
    member_id: number;
    started_at: string;
    last_save_at: string | null;
    unavailable_state: string | null;
    members: { name: string } | { name: string }[];
  };
  const active = (shifts ?? []) as Row[];
  const nameOf = (id: number) => {
    const s = active.find((x) => x.member_id === id);
    if (!s) return null;
    return Array.isArray(s.members) ? (s.members[0]?.name ?? null) : s.members.name;
  };

  const order = rotationOrder(
    active.map((s) => ({
      memberId: s.member_id,
      startedAt: toS(s.started_at),
      lastSaveAt: s.last_save_at ? toS(s.last_save_at) : null,
      available: !s.unavailable_state,
    })),
  );

  return NextResponse.json(
    {
      ok: true,
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
      next: order[1] ? nameOf(order[1]) : null,
      on_duty: order.length,
      total_on_duty: active.length,
    },
    { headers: CORS },
  );
}
