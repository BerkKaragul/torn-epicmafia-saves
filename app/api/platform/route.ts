import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET → everything the operator's /platform page shows. Never returns the
// vendor key itself.
export async function GET() {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;

  const [{ data: cfg }, { data: factions }, { data: members }, { data: pollers }, { data: payments }] =
    await Promise.all([
      db()
        .from("platform_config")
        .select(
          "xanax_per_period, period_days, trial_days, xanax_item_id, vendor_torn_id, vendor_name, vendor_key_valid, receive_log_type_ids, billing_cursor, last_billing_sweep_at, last_billing_error",
        )
        .eq("id", 1)
        .single(),
      db()
        .from("factions")
        .select("faction_id, name, tag, created_at, subscription_expires_at, trial_granted_at, suspended")
        .order("subscription_expires_at", { ascending: false, nullsFirst: false }),
      db().from("members").select("faction_id"),
      db().from("poller_state").select("faction_id, last_poll_at, consecutive_errors"),
      db()
        .from("payments")
        .select("*")
        .order("received_at", { ascending: false })
        .limit(100),
    ]);

  const memberCount = new Map<number, number>();
  for (const m of (members ?? []) as { faction_id: number }[]) {
    memberCount.set(m.faction_id, (memberCount.get(m.faction_id) ?? 0) + 1);
  }
  const pollerBy = new Map(
    ((pollers ?? []) as { faction_id: number; last_poll_at: string | null; consecutive_errors: number }[]).map(
      (p) => [p.faction_id, p],
    ),
  );

  return NextResponse.json({
    config: cfg,
    factions: (factions ?? []).map((f) => ({
      ...f,
      members: memberCount.get(f.faction_id) ?? 0,
      last_poll_at: pollerBy.get(f.faction_id)?.last_poll_at ?? null,
      poll_errors: pollerBy.get(f.faction_id)?.consecutive_errors ?? 0,
    })),
    payments: payments ?? [],
  });
}

// PATCH → pricing / trial settings
export async function PATCH(req: Request) {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const patch: Record<string, number | null> = {};
  if ("xanax_per_period" in body) {
    if (body.xanax_per_period === null || body.xanax_per_period === "") {
      patch.xanax_per_period = null; // pauses the billing sweep
    } else {
      const n = Math.floor(Number(body.xanax_per_period));
      if (!Number.isFinite(n) || n < 1) {
        return NextResponse.json({ error: "Price must be at least 1 Xanax" }, { status: 400 });
      }
      patch.xanax_per_period = n;
    }
  }
  for (const [k, min] of [
    ["period_days", 1],
    ["trial_days", 0],
    ["xanax_item_id", 1],
  ] as const) {
    if (body[k] == null) continue;
    const n = Math.floor(Number(body[k]));
    if (!Number.isFinite(n) || n < min) {
      return NextResponse.json({ error: `Invalid value for ${k}` }, { status: 400 });
    }
    patch[k] = n;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  const { error } = await db()
    .from("platform_config")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) {
    console.error("platform config update failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
