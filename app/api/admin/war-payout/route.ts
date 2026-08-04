import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";

// non-negative numeric knobs; pool + retalFixed are whole dollars, the rest
// are ratios for the respect-pool / hit-pool split.
const NUM_KEYS = [
  "pool",
  "retalFixed",
  "respectPct",
  "saveAsHits",
  "assistAsHits",
  "saveScore",
  "assistScore",
  "outsideAsHits",
] as const;

// GET → { config, wars }  (+ report when ?war_id= is set)
export async function GET(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const warParam = new URL(req.url).searchParams.get("war_id");

  const [{ data: settings }, { data: wars }] = await Promise.all([
    db().from("settings").select("war_payout_config").eq("id", 1).single(),
    db()
      .from("wars")
      .select("torn_war_id, opponent_name, started_at, ended_at, our_score, their_score, target")
      .order("started_at", { ascending: false })
      .limit(25),
  ]);

  let report = null;
  if (warParam) {
    const { data, error } = await db().rpc("war_report", {
      p_war: warParam === "all" ? null : Number(warParam),
    });
    if (error) {
      console.error("war_report failed", error);
      return NextResponse.json({ error: "Could not build the report" }, { status: 500 });
    }
    report = data ?? [];
  }

  return NextResponse.json({
    config: settings?.war_payout_config ?? {},
    wars: wars ?? [],
    report,
  });
}

// PATCH → save the weight config as the new defaults
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const config: Record<string, number | boolean> = {};

  for (const k of NUM_KEYS) {
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: `Invalid value for ${k}` }, { status: 400 });
    }
    // pool and the fixed retal amount are whole dollars; the rest keep decimals
    config[k] = k === "pool" || k === "retalFixed" ? Math.round(n) : n;
  }
  config.includeOutside = Boolean(body.includeOutside);

  const { error } = await db()
    .from("settings")
    .update({ war_payout_config: config, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) {
    console.error("save war payout config failed", error);
    return NextResponse.json({ error: "Could not save defaults" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, config });
}
