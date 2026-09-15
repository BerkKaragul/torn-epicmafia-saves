import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import { computeWarPayout, normalizeConfig, type WarReportRow } from "@/lib/warPayout";

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

// Reject anything that isn't a real, finished-or-running war: "all time" is a
// view, not a war, and can't be frozen into a payout record.
function parseWarId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET → { config, wars }  (+ report and any frozen payout when ?war_id= is set)
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
  // the frozen snapshot for this war, if the admin already locked it in
  let saved = null;
  // chains overlapping this war whose report isn't in yet (still running, or
  // just ended and not synced). While one exists, milestone-bonus respect isn't
  // stripped, so respect — and the split — can be inflated.
  let pendingChains = 0;
  if (warParam) {
    const { data, error } = await db().rpc("war_report", {
      p_war: warParam === "all" ? null : Number(warParam),
    });
    if (error) {
      console.error("war_report failed", error);
      return NextResponse.json({ error: "Could not build the report" }, { status: 500 });
    }
    report = data ?? [];

    if (warParam !== "all") {
      const war = (wars ?? []).find((w) => String(w.torn_war_id) === warParam);
      if (war) {
        const warEnd = war.ended_at ?? new Date().toISOString();
        const { count } = await db()
          .from("chains")
          .select("torn_chain_id", { count: "exact", head: true })
          .eq("report_synced", false)
          .lt("started_at", warEnd)
          .or(`ended_at.is.null,ended_at.gt.${war.started_at}`);
        pendingChains = count ?? 0;
      }

      const { data: snap } = await db()
        .from("war_payouts")
        .select("torn_war_id, config, totals, saved_by, saved_at, members:saved_by(name)")
        .eq("torn_war_id", Number(warParam))
        .maybeSingle();
      saved = snap ?? null;
    }
  }

  return NextResponse.json({
    config: settings?.war_payout_config ?? {},
    wars: wars ?? [],
    report,
    saved,
    pending_chains: pendingChains,
  });
}

// POST {war_id, config} → freeze this war's final payout, published to /payouts
//
// The rows are recomputed here from war_report rather than taken from the
// browser, so the published record is always the maths this codebase does — the
// admin is committing to a war + a set of weights, not to a table they posted.
export async function POST(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { war_id?: unknown; config?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const warId = parseWarId(body.war_id);
  if (!warId) {
    return NextResponse.json(
      { error: "Pick a specific war — “all time” can't be saved as a war payout." },
      { status: 400 },
    );
  }

  const { data: war } = await db()
    .from("wars")
    .select("torn_war_id")
    .eq("torn_war_id", warId)
    .maybeSingle();
  if (!war) return NextResponse.json({ error: "Unknown war." }, { status: 404 });

  const config = normalizeConfig(body.config);
  if (config.pool <= 0) {
    return NextResponse.json(
      { error: "Set a total pool before saving the war's final data." },
      { status: 400 },
    );
  }

  const { data: report, error } = await db().rpc("war_report", { p_war: warId });
  if (error) {
    console.error("war_report failed", error);
    return NextResponse.json({ error: "Could not build the report" }, { status: 500 });
  }

  const payout = computeWarPayout((report ?? []) as WarReportRow[], config);
  if (payout.rows.length === 0) {
    return NextResponse.json({ error: "Nothing to pay for this war." }, { status: 409 });
  }

  const grand = payout.sumChain + payout.sumRetal + payout.distributed;
  const { error: saveError } = await db()
    .from("war_payouts")
    .upsert(
      {
        torn_war_id: warId,
        config,
        totals: {
          prize: payout.prize,
          sumChain: payout.sumChain,
          sumRetal: payout.sumRetal,
          distributed: payout.distributed,
          grand,
          members: payout.rows.length,
          // the rates the split worked out to — frozen alongside the totals so a
          // member can check their own share against them later
          respectPerUnit: Math.round(payout.respectPerUnit),
          hitPerUnit: Math.round(payout.hitPerUnit),
        },
        lines: payout.rows,
        saved_by: admin.torn_id,
        saved_at: new Date().toISOString(),
      },
      { onConflict: "torn_war_id" },
    );
  if (saveError) {
    console.error("save war payout failed", saveError);
    return NextResponse.json({ error: "Could not save the war payout" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, members: payout.rows.length, grand });
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

// DELETE ?war_id= → unpublish a war payout (it was saved by mistake)
export async function DELETE(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  const warId = parseWarId(new URL(req.url).searchParams.get("war_id"));
  if (!warId) return NextResponse.json({ error: "war_id required" }, { status: 400 });

  const { error } = await db().from("war_payouts").delete().eq("torn_war_id", warId);
  if (error) {
    console.error("delete war payout failed", error);
    return NextResponse.json({ error: "Could not remove the war payout" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
