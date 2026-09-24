import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";
import { perSaverHourlyRate } from "@/supabase/functions/_shared/logic/pay";
import type { SaveRow, SettingsRow, ShiftRow } from "@/lib/types";

export async function GET() {
  const auth = await requireMember();
  if (auth.error) return auth.error;
  const { member, fid } = auth.ctx;

  const [
    { data: activeShift },
    { data: settings },
    { data: unpaidDuty },
    { data: mySaves },
    { count: missedTurns },
    { data: activeRows },
    { data: pollerState },
  ] = await Promise.all([
      db()
        .from("shifts")
        .select("*")
        .eq("faction_id", fid)
        .eq("member_id", member.torn_id)
        .is("ended_at", null)
        .maybeSingle<ShiftRow>(),
      db().from("settings").select("*").eq("faction_id", fid).single<SettingsRow>(),
      // accrued = only time a chain was live and the saver could actually save
      db().rpc("member_duty_totals", { p_faction: fid, p_member: member.torn_id }),
      db()
        .from("saves")
        .select("*")
        .eq("faction_id", fid)
        .eq("member_id", member.torn_id)
        .eq("status", "confirmed")
        .returns<SaveRow[]>(),
      db()
        .from("missed_turns")
        .select("id", { count: "exact", head: true })
        .eq("faction_id", fid)
        .eq("member_id", member.torn_id),
      db()
        .from("shifts")
        .select("unavailable_state, abroad")
        .eq("faction_id", fid)
        .is("ended_at", null)
        .returns<{ unavailable_state: string | null; abroad: boolean }[]>(),
      db()
        .from("poller_state")
        .select("last_chain_id, last_current, last_max, last_timeout_s, last_cooldown_s, last_poll_at")
        .eq("faction_id", fid)
        .maybeSingle(),
    ]);

  // savers actually earning right now: on duty, not blocked, and — if the
  // faction saves from abroad — abroad. Drives the live per-saver split.
  const activeSavers = (activeRows ?? []).length;
  const eligibleSavers = (activeRows ?? []).filter(
    (s) => !s.unavailable_state && (!settings?.abroad_only || s.abroad),
  ).length;

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
          // what each active saver actually earns per hour at the moment
          current_hourly_rate: perSaverHourlyRate(
            Number(settings.hourly_rate),
            eligibleSavers ?? 0,
          ),
          eligible_savers: eligibleSavers ?? 0,
        }
      : null,
    saving_enabled: settings?.saving_enabled ?? true,
    unpaid: {
      duty_seconds: Number(duty.duty_seconds),
      hours_amount: Number(duty.hours_amount),
      save_count: (mySaves ?? []).length,
      saves_amount: Math.round(savesAmount),
    },
    chain_active: chainActive,
    chain: {
      id: pollerState?.last_chain_id ?? 0,
      current: pollerState?.last_current ?? 0,
      max: pollerState?.last_max ?? 0,
      timeout_s: pollerState?.last_timeout_s ?? 0,
      cooldown_s: pollerState?.last_cooldown_s ?? 0,
      observed_at: pollerState?.last_poll_at
        ? Math.floor(Date.parse(pollerState.last_poll_at) / 1000)
        : 0,
    },
    alert_threshold_s: settings?.alert_threshold_s ?? 90,
    realtime_topic: auth.ctx.faction.realtime_topic,
    unavailable_state: activeShift?.unavailable_state ?? null,
    abroad: activeShift?.abroad ?? false,
    abroad_only: settings?.abroad_only ?? false,
    missed_turns: missedTurns ?? 0,
    slots: { cap: settings?.saver_cap ?? 0, active: activeSavers ?? 0 },
  });
}
