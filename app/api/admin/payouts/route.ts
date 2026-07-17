import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import type { PayoutLineRow, SaveRow, ShiftRow } from "@/lib/types";

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

  const { data: period, error: pErr } = await db()
    .from("payout_periods")
    .insert({
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      created_by: admin.torn_id,
    })
    .select("*")
    .single();
  if (pErr || !period) {
    console.error("period create failed", pErr);
    return NextResponse.json({ error: "Could not create period" }, { status: 500 });
  }

  // candidate members: anyone with an unpaid ended shift or confirmed save in range
  const [{ data: shiftMembers }, { data: saveMembers }] = await Promise.all([
    db()
      .from("shifts")
      .select("member_id")
      .is("payout_line_id", null)
      .not("ended_at", "is", null)
      .gte("ended_at", period.period_start)
      .lte("ended_at", period.period_end),
    db()
      .from("saves")
      .select("member_id")
      .eq("status", "confirmed")
      .is("payout_line_id", null)
      .not("member_id", "is", null)
      .gte("detected_at", period.period_start)
      .lte("detected_at", period.period_end),
  ]);
  const memberIds = [
    ...new Set([
      ...(shiftMembers ?? []).map((r: { member_id: number }) => r.member_id),
      ...(saveMembers ?? []).map((r: { member_id: number | null }) => r.member_id!),
    ]),
  ];

  let created = 0;
  for (const memberId of memberIds) {
    const { data: line } = await db()
      .from("payout_lines")
      .insert({
        period_id: period.id,
        member_id: memberId,
        duty_seconds: 0,
        save_count: 0,
        hours_amount: 0,
        saves_amount: 0,
        total_amount: 0,
      })
      .select("id")
      .single();
    if (!line) continue;

    // claim rows atomically (payout_line_id IS NULL guard prevents double-pay)
    const { data: claimedShifts } = await db()
      .from("shifts")
      .update({ payout_line_id: line.id })
      .eq("member_id", memberId)
      .is("payout_line_id", null)
      .not("ended_at", "is", null)
      .gte("ended_at", period.period_start)
      .lte("ended_at", period.period_end)
      .select("*")
      .returns<ShiftRow[]>();
    const { data: claimedSaves } = await db()
      .from("saves")
      .update({ payout_line_id: line.id })
      .eq("member_id", memberId)
      .eq("status", "confirmed")
      .is("payout_line_id", null)
      .gte("detected_at", period.period_start)
      .lte("detected_at", period.period_end)
      .select("*")
      .returns<SaveRow[]>();

    let dutySeconds = 0;
    let hoursAmount = 0;
    for (const s of claimedShifts ?? []) {
      const secs = (Date.parse(s.ended_at!) - Date.parse(s.started_at)) / 1000;
      dutySeconds += secs;
      hoursAmount += (secs / 3600) * Number(s.hourly_rate_snapshot);
    }
    const savesAmount = (claimedSaves ?? []).reduce(
      (sum, s) => sum + Number(s.bonus_snapshot ?? 0),
      0,
    );
    const saveCount = claimedSaves?.length ?? 0;

    if (dutySeconds === 0 && saveCount === 0) {
      await db().from("payout_lines").delete().eq("id", line.id);
      continue;
    }
    await db()
      .from("payout_lines")
      .update({
        duty_seconds: Math.round(dutySeconds),
        save_count: saveCount,
        hours_amount: Math.round(hoursAmount),
        saves_amount: Math.round(savesAmount),
        total_amount: Math.round(hoursAmount + savesAmount),
      })
      .eq("id", line.id);
    created++;
  }

  if (created === 0) {
    await db().from("payout_periods").delete().eq("id", period.id);
    return NextResponse.json(
      { error: "No unpaid shifts or saves in that range." },
      { status: 409 },
    );
  }
  return NextResponse.json({ period_id: period.id, lines: created });
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
