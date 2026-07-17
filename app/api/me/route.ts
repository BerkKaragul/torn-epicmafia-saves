import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import type { SaveRow, SettingsRow, ShiftRow } from "@/lib/types";

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const [
    { data: activeShift },
    { data: settings },
    { data: myShifts },
    { data: mySaves },
    { count: missedTurns },
    { count: activeSavers },
  ] = await Promise.all([
      db()
        .from("shifts")
        .select("*")
        .eq("member_id", member.torn_id)
        .is("ended_at", null)
        .maybeSingle<ShiftRow>(),
      db().from("settings").select("*").eq("id", 1).single<SettingsRow>(),
      db()
        .from("shifts")
        .select("*")
        .eq("member_id", member.torn_id)
        .is("payout_line_id", null)
        .not("ended_at", "is", null)
        .order("started_at", { ascending: false })
        .limit(50)
        .returns<ShiftRow[]>(),
      db()
        .from("saves")
        .select("*")
        .eq("member_id", member.torn_id)
        .eq("status", "confirmed")
        .is("payout_line_id", null)
        .returns<SaveRow[]>(),
      db()
        .from("missed_turns")
        .select("id", { count: "exact", head: true })
        .eq("member_id", member.torn_id),
      db().from("shifts").select("id", { count: "exact", head: true }).is("ended_at", null),
    ]);

  // unpaid totals: closed shifts + the live one, valued at their snapshotted rates
  const now = Date.now();
  let dutySeconds = 0;
  let hoursAmount = 0;
  for (const s of myShifts ?? []) {
    const secs = (new Date(s.ended_at!).getTime() - new Date(s.started_at).getTime()) / 1000;
    dutySeconds += secs;
    hoursAmount += (secs / 3600) * Number(s.hourly_rate_snapshot);
  }
  if (activeShift) {
    const secs = (now - new Date(activeShift.started_at).getTime()) / 1000;
    dutySeconds += secs;
    hoursAmount += (secs / 3600) * Number(activeShift.hourly_rate_snapshot);
  }
  const savesAmount = (mySaves ?? []).reduce((sum, s) => sum + Number(s.bonus_snapshot ?? 0), 0);

  return NextResponse.json({
    member: {
      torn_id: member.torn_id,
      name: member.name,
      is_admin: member.is_admin,
      key_valid: member.key_valid,
      key_last4: member.api_key_ct ? "····" : null,
    },
    activeShift,
    rates: settings
      ? { hourly_rate: settings.hourly_rate, per_save_bonus: settings.per_save_bonus }
      : null,
    unpaid: {
      duty_seconds: Math.round(dutySeconds),
      hours_amount: Math.round(hoursAmount),
      save_count: (mySaves ?? []).length,
      saves_amount: Math.round(savesAmount),
    },
    missed_turns: missedTurns ?? 0,
    slots: { cap: settings?.saver_cap ?? 0, active: activeSavers ?? 0 },
  });
}
