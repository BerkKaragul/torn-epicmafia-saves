import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import type { PayoutLineRow } from "@/lib/types";

// GET ?period_id=&format=csv → CSV export; GET → periods with lines
export async function GET(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.is_admin) return forbidden();

  const url = new URL(req.url);
  const periodId = url.searchParams.get("period_id");
  const format = url.searchParams.get("format");

  if (periodId && format === "csv") {
    const { data: lines } = await db()
      .from("payout_lines")
      .select("*, members(name)")
      .eq("period_id", periodId)
      .order("total_amount", { ascending: false })
      .returns<(PayoutLineRow & { members: { name: string } })[]>();
    const rows = [
      "torn_id,name,duty_hours,saves,availability_amount,saves_amount,total,paid",
      ...(lines ?? []).map((l) =>
        [
          l.member_id,
          `"${l.members.name}"`,
          (l.duty_seconds / 3600).toFixed(2),
          l.save_count,
          Math.round(l.hours_amount),
          Math.round(l.saves_amount),
          Math.round(l.total_amount),
          l.paid_at ? "yes" : "no",
        ].join(","),
      ),
    ];
    return new NextResponse(rows.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename=chainwatch-payout-${periodId.slice(0, 8)}.csv`,
      },
    });
  }

  const { data: periods } = await db()
    .from("payout_periods")
    .select("*, payout_lines(*, members(name))")
    .order("created_at", { ascending: false })
    .limit(12);
  return NextResponse.json({ periods: periods ?? [] });
}

// POST {period_start, period_end} → compute + create a payout period
export async function POST(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { period_start?: string; period_end?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const start = body.period_start ? new Date(body.period_start) : null;
  const end = body.period_end ? new Date(body.period_end) : new Date();
  if (!start || isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    return NextResponse.json({ error: "Invalid period range" }, { status: 400 });
  }

  // One transactional SQL function: creates the period, claims every unpaid
  // ended shift / confirmed save up to period_end (claim-once via the
  // payout_line_id-is-null guard), and values the lines — crash-safe.
  const { data, error } = await db().rpc("generate_payout", {
    p_start: start.toISOString(),
    p_end: end.toISOString(),
    p_created_by: admin.torn_id,
  });
  if (error) {
    console.error("generate_payout failed", error);
    return NextResponse.json({ error: "Could not create period" }, { status: 500 });
  }
  if (data?.error) {
    return NextResponse.json(
      { error: "Nothing unpaid up to that end date." },
      { status: 409 },
    );
  }
  return NextResponse.json({ period_id: data.period_id, lines: data.lines });
}

// PATCH {line_id, paid} → mark a line paid/unpaid
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { line_id?: string; paid?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.line_id || typeof body.paid !== "boolean") {
    return NextResponse.json({ error: "line_id and paid required" }, { status: 400 });
  }
  await db()
    .from("payout_lines")
    .update(
      body.paid
        ? { paid_at: new Date().toISOString(), paid_by: admin.torn_id }
        : { paid_at: null, paid_by: null },
    )
    .eq("id", body.line_id);
  return NextResponse.json({ ok: true });
}
