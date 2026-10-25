import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import { isEventRunning } from "@/lib/event";
import { buildEventReport } from "@/lib/eventReport";
import type { ChainEventRow } from "@/lib/types";

export const dynamic = "force-dynamic";

// GET → the newest event and its standings, for any signed-in member.
//
// While nothing is frozen the rows are live (event_report); once an admin locks
// the payout, everyone reads that snapshot instead, so the published numbers
// can't drift when a late save is attributed.
export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const { data: event, error } = await db()
    .from("chain_events")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle<ChainEventRow>();
  if (error) {
    console.error("load event failed", error);
    return NextResponse.json({ error: "Could not load the event" }, { status: 500 });
  }
  if (!event) return NextResponse.json({ event: null, me: member.torn_id });

  const frozen = event.payout_lines != null && event.payout_totals != null;
  let lines = event.payout_lines ?? [];
  let totals = event.payout_totals;
  if (!frozen) {
    const report = await buildEventReport(event.id, Number(event.save_bonus));
    if ("error" in report) return NextResponse.json(report, { status: 500 });
    lines = report.lines;
    totals = report.totals;
  }

  return NextResponse.json({
    event: {
      id: event.id,
      name: event.name,
      theme: event.theme,
      started_at: event.started_at,
      ends_at: event.ends_at,
      ended_at: event.ended_at,
      save_bonus: Number(event.save_bonus),
      running: isEventRunning(event),
      payout_saved_at: event.payout_saved_at,
    },
    frozen,
    lines,
    totals,
    me: member.torn_id,
  });
}
