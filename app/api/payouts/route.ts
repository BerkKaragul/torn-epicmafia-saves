import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";

// GET → every war whose payout an admin has frozen, newest war first.
//
// Deliberately NOT admin-gated: once the numbers are final the whole faction
// should be able to check what they earned. Nothing here is live — it's the
// snapshot the admin committed to, so reading it can't leak an in-progress war.
export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const { data, error } = await db()
    .from("war_payouts")
    .select(
      "torn_war_id, config, totals, lines, saved_at, saved_by, " +
        "wars(opponent_name, started_at, ended_at, our_score, their_score), " +
        "members:saved_by(name)",
    )
    .order("saved_at", { ascending: false });

  if (error) {
    console.error("load war payouts failed", error);
    return NextResponse.json({ error: "Could not load payouts" }, { status: 500 });
  }

  return NextResponse.json({ payouts: data ?? [], me: member.torn_id });
}
