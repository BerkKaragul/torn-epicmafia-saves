import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

// GET: recent saves needing attention (unattributed / pending), plus recent confirmed
export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const { data: saves } = await db()
    .from("saves")
    .select("*, members(name)")
    .order("detected_at", { ascending: false })
    .limit(40);
  return NextResponse.json({ saves: saves ?? [] });
}

// PATCH: manually attribute an unattributed save to a member
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { save_id?: string; member_id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.save_id || !body.member_id) {
    return NextResponse.json({ error: "save_id and member_id required" }, { status: 400 });
  }

  const { data: settings } = await db()
    .from("settings")
    .select("per_save_bonus")
    .eq("id", 1)
    .single();

  const { data: updated, error } = await db()
    .from("saves")
    .update({
      status: "confirmed",
      member_id: Number(body.member_id),
      bonus_snapshot: settings?.per_save_bonus ?? 0,
      note: `manually attributed by ${admin.name} [${admin.torn_id}]`,
    })
    .eq("id", body.save_id)
    .in("status", ["unattributed", "pending"])
    .is("payout_line_id", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("manual attribution failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "Save not found, already confirmed, or already paid out." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
