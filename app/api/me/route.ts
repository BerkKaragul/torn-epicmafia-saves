import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import { perSaverHourlyRate } from "@/supabase/functions/_shared/logic/pay";
import type { SaveRow, SettingsRow, ShiftRow } from "@/lib/types";

interface WarTally {
  torn_war_id: number;
  opponent_name: string | null;
  started_at: string;
  duty_seconds: number;
  hours_amount: number;
  save_count: number;
  saves_amount: number;
  missed_turns: number;
}

/**
 * The member's running tally for the war in progress — the same window and
 * overlap rules war_report uses, so it previews that war's chain_pay and saves.
 * Once the war ends it's paid from the war payout, so there's nothing to show
 * until the next one starts.
 */
async function currentWarTally(memberId: number): Promise<WarTally | null> {
  const { data: war } = await db()
    .from("wars")
    .select("torn_war_id, opponent_name, started_at")
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!war) return null;

  const from = war.started_at as string;
  const to = new Date().toISOString();
  const [{ data: shifts }, { data: saves }, { count: missed }] = await Promise.all([
    db()
      .from("shifts")
      .select("billable_seconds, earned_amount")
      .eq("member_id", memberId)
      .lt("started_at", to)
      .or(`ended_at.is.null,ended_at.gt.${from}`),
    db()
      .from("saves")
      .select("bonus_snapshot")
      .eq("member_id", memberId)
      .eq("status", "confirmed")
      .gte("detected_at", from)
      .lte("detected_at", to)
      .returns<Pick<SaveRow, "bonus_snapshot">[]>(),
    db()
      .from("missed_turns")
      .select("id", { count: "exact", head: true })
      .eq("member_id", memberId)
      .gte("occurred_at", from),
  ]);

  return {
    torn_war_id: Number(war.torn_war_id),
    opponent_name: war.opponent_name ?? null,
    started_at: from,
    duty_seconds: (shifts ?? []).reduce((sum, s) => sum + Number(s.billable_seconds ?? 0), 0),
    hours_amount: Math.round(
      (shifts ?? []).reduce((sum, s) => sum + Number(s.earned_amount ?? 0), 0),
    ),
    save_count: (saves ?? []).length,
    saves_amount: Math.round(
      (saves ?? []).reduce((sum, s) => sum + Number(s.bonus_snapshot ?? 0), 0),
    ),
    missed_turns: missed ?? 0,
  };
}

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const [
    { data: activeShift },
    { data: settings },
    war,
    { count: activeSavers },
    { count: eligibleSavers },
    { data: pollerState },
  ] = await Promise.all([
      db()
        .from("shifts")
        .select("*")
        .eq("member_id", member.torn_id)
        .is("ended_at", null)
        .maybeSingle<ShiftRow>(),
      db().from("settings").select("*").eq("id", 1).single<SettingsRow>(),
      currentWarTally(member.torn_id),
      db().from("shifts").select("id", { count: "exact", head: true }).is("ended_at", null),
      // savers actually earning right now: on duty, not blocked, and abroad
      // (home-city time doesn't earn) — this drives the live per-saver split
      db()
        .from("shifts")
        .select("id", { count: "exact", head: true })
        .is("ended_at", null)
        .is("unavailable_state", null)
        .eq("abroad", true),
      db()
        .from("poller_state")
        .select("last_chain_id, last_current, last_max, last_timeout_s, last_cooldown_s, last_poll_at")
        .eq("id", 1)
        .maybeSingle(),
    ]);

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
    war,
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
    unavailable_state: activeShift?.unavailable_state ?? null,
    abroad: activeShift?.abroad ?? false,
    slots: { cap: settings?.saver_cap ?? 0, active: activeSavers ?? 0 },
  });
}
