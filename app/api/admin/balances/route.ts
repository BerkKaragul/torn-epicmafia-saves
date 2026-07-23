import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

// GET → every member's current owed balance (duty + saves + adjustments)
export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const { data, error } = await db().rpc("member_balances");
  if (error) {
    console.error("member_balances failed", error);
    return NextResponse.json({ error: "Could not load balances" }, { status: 500 });
  }
  return NextResponse.json({ balances: data ?? [] });
}

// POST → manual adjustment (positive adds, negative removes)
export async function POST(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { member_id?: number; amount?: number; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const memberId = Number(body.member_id);
  const amount = Number(body.amount);
  if (!memberId || !Number.isFinite(amount) || amount === 0) {
    return NextResponse.json(
      { error: "Pick a member and a non-zero amount." },
      { status: 400 },
    );
  }

  const { error } = await db().from("adjustments").insert({
    member_id: memberId,
    amount: Math.round(amount),
    note: body.note?.slice(0, 200) || null,
    created_by: admin.torn_id,
  });
  if (error) {
    console.error("adjustment failed", error);
    return NextResponse.json({ error: "Could not save the adjustment" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// PATCH → settle a balance to zero, either as paid or written off
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { member_id?: number; paid?: boolean; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const memberId = Number(body.member_id);
  if (!memberId || typeof body.paid !== "boolean") {
    return NextResponse.json({ error: "member_id and paid required" }, { status: 400 });
  }

  const { data, error } = await db().rpc("settle_member", {
    p_member: memberId,
    p_by: admin.torn_id,
    p_paid: body.paid,
    p_note: body.note?.slice(0, 200) ?? null,
  });
  if (error) {
    console.error("settle_member failed", error);
    return NextResponse.json({ error: "Could not settle the balance" }, { status: 500 });
  }
  if (data?.error) {
    return NextResponse.json({ error: "That member has nothing owing." }, { status: 409 });
  }
  return NextResponse.json({ settled: data.settled });
}
