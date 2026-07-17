import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const [{ data: members }, { data: activeShifts }] = await Promise.all([
    db()
      .from("members")
      .select("torn_id, name, key_access_level, key_valid, is_admin, admin_source, last_login_at")
      .order("name"),
    db().from("shifts").select("member_id").is("ended_at", null),
  ]);
  const onDuty = new Set((activeShifts ?? []).map((s: { member_id: number }) => s.member_id));
  return NextResponse.json({
    members: (members ?? []).map((m) => ({ ...m, on_duty: onDuty.has(m.torn_id) })),
  });
}

// PATCH: grant/revoke admin, or force-end someone's shift
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { torn_id?: number; is_admin?: boolean; end_shift?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const tornId = Number(body.torn_id);
  if (!tornId) return NextResponse.json({ error: "Missing torn_id" }, { status: 400 });

  if (body.end_shift) {
    await db()
      .from("shifts")
      .update({ ended_at: new Date().toISOString(), end_reason: "admin" })
      .eq("member_id", tornId)
      .is("ended_at", null);
    return NextResponse.json({ ok: true });
  }

  if (typeof body.is_admin === "boolean") {
    const { data: target } = await db()
      .from("members")
      .select("admin_source")
      .eq("torn_id", tornId)
      .maybeSingle();
    if (!target) return NextResponse.json({ error: "Unknown member" }, { status: 404 });
    if (target.admin_source === "auto") {
      return NextResponse.json(
        { error: "Faction leaders are always admins — can't change that here." },
        { status: 400 },
      );
    }
    await db()
      .from("members")
      .update({
        is_admin: body.is_admin,
        admin_source: body.is_admin ? "granted" : null,
      })
      .eq("torn_id", tornId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
}
