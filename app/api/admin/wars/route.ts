import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

// GET            → list of wars
// GET ?war_id=N  → per-member breakdown for that war ("all" for everything)
export async function GET(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const warParam = new URL(req.url).searchParams.get("war_id");

  const { data: wars } = await db()
    .from("wars")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(25);

  if (!warParam) return NextResponse.json({ wars: wars ?? [] });

  const { data: report, error } = await db().rpc("war_report", {
    p_war: warParam === "all" ? null : Number(warParam),
  });
  if (error) {
    console.error("war_report failed", error);
    return NextResponse.json({ error: "Could not build the war report" }, { status: 500 });
  }
  return NextResponse.json({ wars: wars ?? [], report: report ?? [] });
}
