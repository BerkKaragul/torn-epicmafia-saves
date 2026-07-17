import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();
  const { data } = await db().from("settings").select("*").eq("id", 1).single();
  return NextResponse.json({ settings: data });
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
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const patch: Record<string, number | string> = {};
  for (const key of EDITABLE) {
    if (body[key] == null) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 });
    }
    patch[key] = n;
  }
  if (typeof body.save_bonus_mode === "string") {
    if (!["flat", "scaled"].includes(body.save_bonus_mode)) {
      return NextResponse.json({ error: "Invalid save bonus mode" }, { status: 400 });
    }
    patch.save_bonus_mode = body.save_bonus_mode;
  }
  if (patch.save_threshold_s != null && (patch.save_threshold_s < 10 || patch.save_threshold_s > 290)) {
    return NextResponse.json({ error: "Save threshold must be 10–290s" }, { status: 400 });
  }
  if (patch.poll_interval_s != null && patch.poll_interval_s < 15) {
    return NextResponse.json({ error: "Poll interval can't go below 15s" }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await db()
    .from("settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("*")
    .single();
  if (error) {
    console.error("settings update failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ settings: data });
}
