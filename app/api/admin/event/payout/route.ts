import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import { latestEvent } from "@/lib/event";
import { buildEventReport } from "@/lib/eventReport";

// POST → freeze the newest event's payout and publish it to /payouts.
//
// Recomputed here from event_report, never taken from the browser, so the
// published record is the maths this codebase does. Re-freezing replaces it.
export async function POST() {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  const event = await latestEvent();
  if (!event) return NextResponse.json({ error: "No event to pay." }, { status: 404 });

  const report = await buildEventReport(event.id, Number(event.save_bonus));
  if ("error" in report) return NextResponse.json(report, { status: 500 });
  if (report.lines.length === 0) {
    return NextResponse.json({ error: "Nothing to pay for this event." }, { status: 409 });
  }

  const { error } = await db()
    .from("chain_events")
    .update({
      payout_lines: report.lines,
      payout_totals: report.totals,
      payout_saved_by: admin.torn_id,
      payout_saved_at: new Date().toISOString(),
    })
    .eq("id", event.id);
  if (error) {
    console.error("freeze event payout failed", error);
    return NextResponse.json({ error: "Could not save the event payout." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, members: report.lines.length, grand: report.totals.grand });
}

// DELETE → unpublish the newest event's payout (it was frozen by mistake)
export async function DELETE() {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  const event = await latestEvent();
  if (!event) return NextResponse.json({ error: "No event." }, { status: 404 });

  const { error } = await db()
    .from("chain_events")
    .update({ payout_lines: null, payout_totals: null, payout_saved_by: null, payout_saved_at: null })
    .eq("id", event.id);
  if (error) {
    console.error("unpublish event payout failed", error);
    return NextResponse.json({ error: "Could not remove the event payout." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
