import { db } from "@/lib/db";
import { rotationOrder } from "@/supabase/functions/_shared/logic/rotation";
import type { SettingsRow, ShiftRow } from "@/lib/types";

const toS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export interface StatePayload {
  chain: {
    id: number;
    current: number;
    max: number;
    timeout_s: number;
    cooldown_s: number;
    observed_at: number;
  };
  on_duty: { id: number; name: string; started_at: number; last_save_at: number | null }[];
  turn_member_id: number | null;
  last_save: {
    chain_count: number;
    member_id: number | null;
    remaining_at_hit_s: number | null;
    hit_registered_at: string | null;
    status: string;
  } | null;
  danger: boolean;
  alert_threshold_s: number;
  poller_at: number | null;
}

/** Same shape the poller broadcasts — used for SSR and as polling fallback. */
export async function buildStatePayload(): Promise<StatePayload> {
  const [{ data: state }, { data: settings }, { data: shifts }, { data: lastSave }] =
    await Promise.all([
      db().from("poller_state").select("*").eq("id", 1).maybeSingle(),
      db().from("settings").select("*").eq("id", 1).single<SettingsRow>(),
      db()
        .from("shifts")
        .select("*, members!inner(name)")
        .is("ended_at", null)
        .returns<(ShiftRow & { members: { name: string } })[]>(),
      db()
        .from("saves")
        .select("chain_count, member_id, remaining_at_hit_s, hit_registered_at, status")
        .in("status", ["confirmed", "unattributed"])
        .order("detected_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const active = shifts ?? [];
  const lites = active.map((s) => ({
    memberId: s.member_id,
    startedAt: toS(s.started_at),
    lastSaveAt: s.last_save_at ? toS(s.last_save_at) : null,
  }));
  const order = rotationOrder(lites);
  const observedAt = state?.last_poll_at ? toS(state.last_poll_at) : 0;
  const chainActive = (state?.last_chain_id ?? 0) > 0 && (state?.last_current ?? 0) > 0;

  return {
    chain: {
      id: state?.last_chain_id ?? 0,
      current: state?.last_current ?? 0,
      max: 0,
      timeout_s: state?.last_timeout_s ?? 0,
      cooldown_s: state?.last_cooldown_s ?? 0,
      observed_at: observedAt,
    },
    on_duty: order.map((id) => {
      const s = active.find((x) => x.member_id === id)!;
      return {
        id,
        name: s.members.name,
        started_at: toS(s.started_at),
        last_save_at: s.last_save_at ? toS(s.last_save_at) : null,
      };
    }),
    turn_member_id: order[0] ?? null,
    last_save: (lastSave as StatePayload["last_save"]) ?? null,
    danger:
      chainActive && (state?.last_timeout_s ?? Infinity) <= (settings?.alert_threshold_s ?? 90),
    alert_threshold_s: settings?.alert_threshold_s ?? 90,
    poller_at: state?.last_poll_at ? toS(state.last_poll_at) : null,
  };
}
