import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";

// POST { payment_id, faction_id } → credit an unmatched (or ignored) payment
// to a faction, e.g. a sender who had no faction when they paid.
export async function POST(req: Request) {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;

  let body: { payment_id?: unknown; faction_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const fid = Number(body.faction_id);
  if (typeof body.payment_id !== "string" || !Number.isInteger(fid) || fid <= 0) {
    return NextResponse.json({ error: "payment_id and faction_id required" }, { status: 400 });
  }
  const { data, error } = await db().rpc("assign_payment", {
    p_payment: body.payment_id,
    p_faction: fid,
  });
  if (error) {
    console.error("assign_payment failed", error);
    return NextResponse.json({ error: "Could not assign the payment" }, { status: 500 });
  }
  if (data?.error === "price_not_set") {
    return NextResponse.json({ error: "Set a Xanax price first." }, { status: 409 });
  }
  if (data?.error) {
    return NextResponse.json({ error: "That payment is already applied." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, ...data });
}
