import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";
import { saveBonus, type SaveBonusMode } from "@/supabase/functions/_shared/logic/pay";

// GET: recent saves needing attention (unattributed / pending), plus recent confirmed
export async function GET() {
  const auth = await requireMember({ admin: true });
  if (auth.error) return auth.error;
  const { member, fid } = auth.ctx;

  const { data: saves } = await db()
    .from("saves")
    .select("*, members:members!saves_member_id_fkey(name)")
    .eq("faction_id", fid)
    .order("detected_at", { ascending: false })
    .limit(40);
  return NextResponse.json({ saves: saves ?? [] });
}

// PATCH: manually attribute an unattributed save to a member
export async function PATCH(req: Request) {
  const auth = await requireMember({ admin: true });
  if (auth.error) return auth.error;
  const { member: admin, fid } = auth.ctx;

  let body: { save_id?: string; member_id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.save_id || !body.member_id) {
    return NextResponse.json({ error: "save_id and member_id required" }, { status: 400 });
  }

  const [{ data: settings }, { data: save }, { data: target }] = await Promise.all([
    db().from("settings").select("per_save_bonus, save_bonus_mode").eq("faction_id", fid).single(),
    db()
      .from("saves")
      .select("chain_count")
      .eq("faction_id", fid)
      .eq("id", body.save_id)
      .maybeSingle(),
    // only credit someone who is in THIS faction
    db()
      .from("members")
      .select("torn_id")
      .eq("faction_id", fid)
      .eq("torn_id", Number(body.member_id))
      .maybeSingle(),
  ]);
  if (!save) return NextResponse.json({ error: "Save not found." }, { status: 404 });
  if (!target) {
    return NextResponse.json({ error: "That member isn't registered in your faction." }, { status: 400 });
  }

  const { data: updated, error } = await db()
    .from("saves")
    .update({
      status: "confirmed",
      member_id: Number(body.member_id),
      bonus_snapshot: saveBonus(
        (settings?.save_bonus_mode ?? "flat") as SaveBonusMode,
        Number(settings?.per_save_bonus ?? 0),
        save.chain_count,
      ),
      note: `manually attributed by ${admin.name} [${admin.torn_id}]`,
    })
    .eq("id", body.save_id)
    .eq("faction_id", fid)
    .in("status", ["unattributed", "pending"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("manual attribution failed", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "Save not found or already confirmed." },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
