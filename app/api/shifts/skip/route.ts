import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import type { ShiftRow } from "@/lib/types";

// POST = "skip my turn": stamp deprioritized_at=now on the caller's active
// shift, which sends them to the back of the rotation (the sort key is
// greatest(started_at, last_save_at, deprioritized_at)) WITHOUT recording a
// save — no pay or stat credit, and they keep their shift. Repeated taps just
// refresh the timestamp.
export async function POST() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const { data: shift, error } = await db()
    .from("shifts")
    .update({ deprioritized_at: new Date().toISOString() })
    .eq("member_id", member.torn_id)
    .is("ended_at", null)
    .select("*")
    .maybeSingle<ShiftRow>();

  if (error) {
    console.error("skip turn failed", error);
    return NextResponse.json({ error: "Could not skip your turn." }, { status: 500 });
  }
  if (!shift) return NextResponse.json({ error: "You're not on duty." }, { status: 409 });
  return NextResponse.json({ shift });
}
