import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";

export async function GET() {
  const auth = await requireMember({ admin: true });
  if (auth.error) return auth.error;
  const { member, fid } = auth.ctx;
  const { data } = await db().from("settings").select("*").eq("faction_id", fid).single();
  return NextResponse.json({
    settings: data,
    widget_token: auth.ctx.faction.widget_token,
    faction: { id: fid, name: auth.ctx.faction.name },
  });
}

const EDITABLE = [
  "hourly_rate",
  "per_save_bonus",
  "save_threshold_s",
  "alert_threshold_s",
  "poll_interval_s",
  "idle_poll_interval_s",
  "poller_member_id",
  "saver_cap",
] as const;

export async function PATCH(req: Request) {
  const auth = await requireMember({ admin: true });
  if (auth.error) return auth.error;
  const { member, fid } = auth.ctx;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const patch: Record<string, number | string | boolean> = {};
  for (const key of EDITABLE) {
    if (body[key] == null) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 });
    }
    patch[key] = n;
  }
  if (typeof body.saving_enabled === "boolean") {
    patch.saving_enabled = body.saving_enabled;
    if (!body.saving_enabled) {
      // switching saving off ends every shift so nothing keeps accruing
      await db()
        .from("shifts")
        .update({ ended_at: new Date().toISOString(), end_reason: "saving_disabled" })
        .eq("faction_id", fid)
        .is("ended_at", null);
    }
  }
  if (typeof body.abroad_only === "boolean") patch.abroad_only = body.abroad_only;
  if (typeof body.save_bonus_mode === "string") {
    if (!["flat", "scaled"].includes(body.save_bonus_mode)) {
      return NextResponse.json({ error: "Invalid save bonus mode" }, { status: 400 });
    }
    patch.save_bonus_mode = body.save_bonus_mode;
  }
  const saveThreshold = patch.save_threshold_s;
  if (typeof saveThreshold === "number" && (saveThreshold < 10 || saveThreshold > 290)) {
    return NextResponse.json({ error: "Save threshold must be 10–290s" }, { status: 400 });
  }
  const pollInterval = patch.poll_interval_s;
  if (typeof pollInterval === "number" && pollInterval < 10) {
    return NextResponse.json({ error: "Poll interval can't go below 10s" }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await db()
    .from("settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("faction_id", fid)
    .select("*")
    .single();
  if (error) {
    console.error("settings update failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ settings: data });
}
