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
    { data: unpaidDuty },
    { data: mySaves },
    { count: missedTurns },
    { count: activeSavers },
    { data: pollerState },
  ] = await Promise.all([
      db()
        .from("shifts")
        .select("*")
        .eq("member_id", member.torn_id)
        .is("ended_at", null)
        .maybeSingle<ShiftRow>(),
      db().from("settings").select("*").eq("id", 1).single<SettingsRow>(),
      // billable = only time a chain was live during the member's unpaid shifts
      db().rpc("member_unpaid_duty", { p_member: member.torn_id }),
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
      db()
        .from("poller_state")
        .select("last_chain_id, last_current, last_cooldown_s")
        .eq("id", 1)
        .maybeSingle(),
    ]);

  const duty = (unpaidDuty ?? { duty_seconds: 0, hours_amount: 0 }) as {
    duty_seconds: number;
    hours_amount: number;
  };
  const savesAmount = (mySaves ?? []).reduce((sum, s) => sum + Number(s.bonus_snapshot ?? 0), 0);
  const chainActive =
    (pollerState?.last_chain_id ?? 0) > 0 &&
    (pollerState?.last_current ?? 0) > 0 &&
    (pollerState?.last_cooldown_s ?? 0) === 0;

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
      ? {
          hourly_rate: settings.hourly_rate,
          per_save_bonus: settings.per_save_bonus,
          save_bonus_mode: settings.save_bonus_mode,
        }
      : null,
    unpaid: {
      duty_seconds: Number(duty.duty_seconds),
      hours_amount: Number(duty.hours_amount),
      save_count: (mySaves ?? []).length,
      saves_amount: Math.round(savesAmount),
    },
    chain_active: chainActive,
    missed_turns: missedTurns ?? 0,
    slots: { cap: settings?.saver_cap ?? 0, active: activeSavers ?? 0 },
  });
}
