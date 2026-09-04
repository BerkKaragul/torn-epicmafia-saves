import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";

export const dynamic = "force-dynamic";

// Read-only, visible to any logged-in member: save earnings for the currently
// LIVE war, so savers can see who's putting in the hours. Pulls exactly what the
// admin War Pay page pulls (the war_report RPC), narrowed to save hourly pay
// (chain_pay) + save count. No pay config, no totals math — just the standings.
interface WarReportRow {
  member_id: number;
  name: string;
  saves: number;
  chain_pay: number;
}

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  // the live war = the one that hasn't ended yet (most recent if several)
  const { data: war } = await db()
    .from("wars")
    .select("torn_war_id, opponent_name, started_at")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!war) return NextResponse.json({ war: null, rows: [] });

  const { data, error } = await db().rpc("war_report", { p_war: war.torn_war_id });
  if (error) {
    console.error("war-standings war_report failed", error);
    return NextResponse.json({ error: "Could not load standings" }, { status: 500 });
  }

  const rows = ((data ?? []) as WarReportRow[])
    .map((r) => ({
      member_id: r.member_id,
      name: r.name,
      saves: Number(r.saves) || 0,
      save_pay: Math.round(Number(r.chain_pay) || 0),
    }))
    .filter((r) => r.save_pay > 0 || r.saves > 0)
    .sort((a, b) => b.save_pay - a.save_pay || b.saves - a.saves);

  return NextResponse.json({
    war: { opponent_name: war.opponent_name, started_at: war.started_at },
    rows,
  });
}
