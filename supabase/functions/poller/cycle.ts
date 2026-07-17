// One poll cycle: observe the chain, run the detector, attribute pending
// saves via on-duty members' own attack logs, manage shifts, alert, broadcast.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { detect, type ChainObservation } from "../_shared/logic/detect.ts";
import { rotationOrder, type ShiftLite } from "../_shared/logic/rotation.ts";
import { decryptApiKey } from "../_shared/lib/crypto.ts";
import {
  isInvalidKeyError,
  makeTornClient,
  type TornClient,
} from "../_shared/lib/torn.ts";
import { dispatch } from "./notify.ts";

const toIso = (s: number) => new Date(s * 1000).toISOString();
const toS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

interface MemberKeyRow {
  torn_id: number;
  name: string;
  api_key_ct: string | null;
  api_key_iv: string | null;
  key_valid: boolean;
}

interface ActiveShiftRow {
  id: string;
  member_id: number;
  started_at: string;
  planned_minutes: number | null;
  last_save_at: string | null;
  members: MemberKeyRow;
}

function sb(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

async function tornFor(member: MemberKeyRow): Promise<TornClient> {
  const key = await decryptApiKey(
    member.api_key_ct!,
    member.api_key_iv!,
    Deno.env.get("API_KEY_ENC_KEY")!,
  );
  return makeTornClient({ apiKey: key, baseUrl: Deno.env.get("TORN_API_BASE") || undefined });
}

/** v2 spec says cooldown may be a "timestamp until"; v1 tooling saw seconds. */
function normalizeCooldownS(raw: number, nowS: number): number {
  if (raw > 1_000_000_000) return Math.max(0, raw - nowS);
  return Math.max(0, raw);
}

export async function runPollCycle(): Promise<void> {
  const db = sb();
  const nowS = Math.floor(Date.now() / 1000);

  const { data: settings } = await db.from("settings").select("*").eq("id", 1).single();
  if (!settings) return;

  // Overlap guard: claim the singleton row unless a cycle claimed it <55s ago.
  const staleCutoff = new Date(Date.now() - 55_000).toISOString();
  const { data: lockRows } = await db
    .from("poller_state")
    .update({ running_since: new Date().toISOString() })
    .eq("id", 1)
    .or(`running_since.is.null,running_since.lt.${staleCutoff}`)
    .select("*");
  const state = lockRows?.[0];
  if (!state) return; // another cycle is live

  try {
    const { data: activeShiftsRaw } = await db
      .from("shifts")
      .select(
        "id, member_id, started_at, planned_minutes, last_save_at, members!inner(torn_id, name, api_key_ct, api_key_iv, key_valid)",
      )
      .is("ended_at", null)
      .returns<ActiveShiftRow[]>();
    let activeShifts = activeShiftsRaw ?? [];

    const prevObs: ChainObservation | null = state.last_poll_at
      ? {
          polledAt: toS(state.last_poll_at),
          chainId: state.last_chain_id ?? 0,
          current: state.last_current ?? 0,
          max: 0,
          timeoutS: state.last_timeout_s ?? 0,
          cooldownS: state.last_cooldown_s ?? 0,
        }
      : null;

    // Adaptive cadence: with no chain, nobody on duty and nothing pending,
    // only actually hit Torn every idle_poll_interval_s.
    const { count: pendingCount } = await db
      .from("saves")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const prevActive = prevObs !== null && prevObs.chainId > 0 && prevObs.current > 0;
    const idle = !prevActive && activeShifts.length === 0 && (pendingCount ?? 0) === 0;
    if (idle && prevObs && nowS - prevObs.polledAt < settings.idle_poll_interval_s) {
      return;
    }

    // ── resolve a key to poll the faction chain with ──────────────────────
    const pollerMember = await pickPollerMember(db, settings.poller_member_id, activeShifts);
    if (!pollerMember) {
      console.warn("no usable API key to poll with — nobody has logged in yet?");
      return;
    }

    let chain;
    try {
      const torn = await tornFor(pollerMember);
      chain = await torn.factionChain();
    } catch (e) {
      await db
        .from("poller_state")
        .update({ consecutive_errors: (state.consecutive_errors ?? 0) + 1 })
        .eq("id", 1);
      if (isInvalidKeyError(e)) {
        await db.from("members").update({ key_valid: false }).eq("torn_id", pollerMember.torn_id);
      }
      console.error("chain poll failed:", e);
      return;
    }

    const obs: ChainObservation = {
      polledAt: nowS,
      chainId: chain.id ?? 0,
      current: chain.current ?? 0,
      max: chain.max ?? 0,
      timeoutS: chain.timeout ?? 0,
      cooldownS: normalizeCooldownS(chain.cooldown ?? 0, nowS),
    };

    await db.from("chain_polls").insert({
      polled_at: toIso(nowS),
      torn_chain_id: obs.chainId || null,
      current: obs.current,
      timeout_s: obs.timeoutS,
      cooldown_s: obs.cooldownS,
      raw: chain,
    });

    // ── run the detector and persist its events ──────────────────────────
    const events = detect(prevObs, obs, {
      saveThresholdS: settings.save_threshold_s,
      alertThresholdS: settings.alert_threshold_s,
      slackS: 5,
    });

    if (obs.chainId > 0 && obs.current > 0) {
      await db.from("chains").upsert(
        {
          torn_chain_id: obs.chainId,
          started_at: chain.start ? toIso(chain.start) : toIso(nowS),
        },
        { onConflict: "torn_chain_id", ignoreDuplicates: true },
      );
      await db
        .from("chains")
        .update({ max_current: obs.current })
        .eq("torn_chain_id", obs.chainId)
        .lt("max_current", obs.current);
    }

    let dangerEpisodeKey: string | null = state.danger_episode_key;
    for (const ev of events) {
      if (ev.type === "chain_ended") {
        await db
          .from("chains")
          .update({ ended_at: toIso(nowS), end_reason: ev.reason })
          .eq("torn_chain_id", ev.chainId)
          .is("ended_at", null);
      } else if (ev.type === "save_candidate") {
        await db.from("saves").upsert(
          {
            torn_chain_id: ev.chainId,
            chain_count: ev.chainCount,
            window_start: toIso(ev.windowStart),
            window_end: toIso(ev.windowEnd),
            timeout_at_window_start: ev.timeoutAtWindowStart,
            status: "pending",
          },
          { onConflict: "torn_chain_id,chain_count", ignoreDuplicates: true },
        );
      } else if (ev.type === "timer_low" && ev.episodeKey !== dangerEpisodeKey) {
        dangerEpisodeKey = ev.episodeKey;
        await alertDanger(db, activeShifts, ev.timeoutS, ev.episodeKey);
      }
    }

    // ── attribute pending saves via on-duty members' own attack logs ─────
    activeShifts = await attributePendingSaves(db, activeShifts, settings);

    // ── shift housekeeping (planned durations) ───────────────────────────
    activeShifts = await housekeepShifts(db, activeShifts, nowS);

    // ── periodic roster / leadership refresh ─────────────────────────────
    const rosterAge = state.roster_refreshed_at ? nowS - toS(state.roster_refreshed_at) : Infinity;
    let rosterRefreshedAt = state.roster_refreshed_at;
    if (rosterAge > 600) {
      await refreshRoster(db, pollerMember, settings);
      rosterRefreshedAt = toIso(nowS);
    }

    // ── persist state & broadcast ────────────────────────────────────────
    await db
      .from("poller_state")
      .update({
        last_poll_at: toIso(nowS),
        last_chain_id: obs.chainId || null,
        last_current: obs.current,
        last_timeout_s: obs.timeoutS,
        last_cooldown_s: obs.cooldownS,
        consecutive_errors: 0,
        danger_episode_key: dangerEpisodeKey,
        roster_refreshed_at: rosterRefreshedAt,
      })
      .eq("id", 1);

    await broadcastState(db, obs, activeShifts, settings);
  } finally {
    await db.from("poller_state").update({ running_since: null }).eq("id", 1);
  }
}

async function pickPollerMember(
  db: SupabaseClient,
  preferredId: number | null,
  activeShifts: ActiveShiftRow[],
): Promise<MemberKeyRow | null> {
  if (preferredId) {
    const { data } = await db
      .from("members")
      .select("torn_id, name, api_key_ct, api_key_iv, key_valid")
      .eq("torn_id", preferredId)
      .eq("key_valid", true)
      .not("api_key_ct", "is", null)
      .maybeSingle<MemberKeyRow>();
    if (data) return data;
  }
  const onDuty = activeShifts.find((s) => s.members.key_valid && s.members.api_key_ct);
  if (onDuty) return onDuty.members;
  const { data: anyMember } = await db
    .from("members")
    .select("torn_id, name, api_key_ct, api_key_iv, key_valid")
    .eq("key_valid", true)
    .not("api_key_ct", "is", null)
    .order("last_login_at", { ascending: false })
    .limit(1)
    .maybeSingle<MemberKeyRow>();
  return anyMember ?? null;
}

async function attributePendingSaves(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  settings: Record<string, number>,
): Promise<ActiveShiftRow[]> {
  const { data: pending } = await db
    .from("saves")
    .select("*")
    .eq("status", "pending")
    .order("window_start", { ascending: true });
  if (!pending?.length) return activeShifts;

  const sweepFromS = Math.min(...pending.map((s) => toS(s.window_start))) - 120;
  const sweepers = activeShifts.filter((s) => s.members.key_valid && s.members.api_key_ct);

  // one attacks call per on-duty member per cycle, covering every pending save
  const attacksByMember = new Map<number, Awaited<ReturnType<TornClient["userAttacks"]>>>();
  for (const shift of sweepers) {
    try {
      const torn = await tornFor(shift.members);
      attacksByMember.set(
        shift.member_id,
        await torn.userAttacks({ from: sweepFromS, sort: "asc", limit: 100 }),
      );
    } catch (e) {
      if (isInvalidKeyError(e)) {
        await db.from("members").update({ key_valid: false }).eq("torn_id", shift.member_id);
        await db
          .from("shifts")
          .update({ ended_at: new Date().toISOString(), end_reason: "key_invalid" })
          .eq("id", shift.id);
        activeShifts = activeShifts.filter((s) => s.id !== shift.id);
      } else {
        console.error(`attack sweep failed for ${shift.member_id}:`, e);
      }
    }
  }

  for (const save of pending) {
    const windowStartS = toS(save.window_start);
    const windowEndS = toS(save.window_end);
    let matched = false;

    for (const shift of activeShifts) {
      const attacks = attacksByMember.get(shift.member_id) ?? [];
      const hit = attacks.find(
        (a) =>
          a.attacker?.id === shift.member_id &&
          a.chain === save.chain_count &&
          a.chain > 0 &&
          !a.is_interrupted &&
          a.ended >= windowStartS - 5 &&
          a.ended <= windowEndS + 90,
      );
      if (!hit) continue;

      const remaining = save.timeout_at_window_start - (hit.ended - windowStartS);
      if (remaining > settings.save_threshold_s + 5) {
        // the resetting hit actually landed with plenty of time left
        await db
          .from("saves")
          .update({
            status: "not_a_save",
            member_id: shift.member_id,
            attack_id: hit.id,
            attack_code: hit.code,
            hit_registered_at: toIso(hit.ended),
            remaining_at_hit_s: remaining,
          })
          .eq("id", save.id);
      } else {
        await db
          .from("saves")
          .update({
            status: "confirmed",
            member_id: shift.member_id,
            attack_id: hit.id,
            attack_code: hit.code,
            hit_registered_at: toIso(hit.ended),
            remaining_at_hit_s: remaining,
            bonus_snapshot: settings.per_save_bonus,
          })
          .eq("id", save.id);
        await db
          .from("shifts")
          .update({ last_save_at: toIso(hit.ended) })
          .eq("id", shift.id);
        shift.last_save_at = toIso(hit.ended);
        const shown = Math.max(0, Math.round(remaining));
        await dispatch(db, [shift.member_id], {
          type: "save_confirmed",
          title: "Save confirmed ✅",
          body: `Chain hit #${save.chain_count} with ${shown}s left — bonus $${Number(settings.per_save_bonus).toLocaleString()}`,
          url: "/duty",
          dedupKey: `save_confirmed:${save.id}`,
          dedupWindowS: 3600,
        });
      }
      matched = true;
      break;
    }

    if (!matched) {
      const attempts = (save.attempts ?? 0) + 1;
      if (attempts >= 12) {
        // ~3 minutes of sweeps: someone outside the saver roster made the hit
        await db.from("saves").update({ status: "unattributed", attempts }).eq("id", save.id);
        const head = rotationOrder(toShiftLites(activeShifts))[0];
        if (head) {
          await dispatch(db, [head], {
            type: "scooped",
            title: "Save done by someone else",
            body: `Chain hit #${save.chain_count} was saved by a non-enlisted member. Your turn continues.`,
            url: "/",
            dedupKey: `scooped:${save.id}`,
            dedupWindowS: 3600,
          });
        }
      } else {
        await db.from("saves").update({ attempts }).eq("id", save.id);
      }
    }
  }
  return activeShifts;
}

async function housekeepShifts(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  nowS: number,
): Promise<ActiveShiftRow[]> {
  const remaining: ActiveShiftRow[] = [];
  for (const shift of activeShifts) {
    if (!shift.planned_minutes) {
      remaining.push(shift);
      continue;
    }
    const endS = toS(shift.started_at) + shift.planned_minutes * 60;
    if (nowS >= endS) {
      await db
        .from("shifts")
        .update({ ended_at: toIso(endS), end_reason: "planned_elapsed" })
        .eq("id", shift.id)
        .is("ended_at", null);
      await dispatch(db, [shift.member_id], {
        type: "shift_end",
        title: "Duty shift ended",
        body: "Your planned saver shift is over. Thanks! Start a new one any time.",
        url: "/duty",
        dedupKey: `shift_ended:${shift.id}`,
        dedupWindowS: 3600,
      });
    } else {
      if (endS - nowS <= 600) {
        await dispatch(db, [shift.member_id], {
          type: "shift_ending_soon",
          title: "Shift ends in 10 minutes",
          body: "Your saver shift ends soon — open the duty page to extend it.",
          url: "/duty",
          dedupKey: `shift_warn:${shift.id}`,
          dedupWindowS: 3600,
        });
      }
      remaining.push(shift);
    }
  }
  return remaining;
}

async function alertDanger(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  timeoutS: number,
  episodeKey: string,
): Promise<void> {
  const lites = toShiftLites(activeShifts);
  const order = rotationOrder(lites);
  const head = order[0];
  if (!head) return;
  const mmss = `${Math.floor(timeoutS / 60)}:${String(timeoutS % 60).padStart(2, "0")}`;
  const headName = activeShifts.find((s) => s.member_id === head)?.members.name ?? "?";

  await dispatch(db, [head], {
    type: "your_turn",
    title: "🚨 YOUR TURN — SAVE NOW",
    body: `Chain timer at ${mmss}. Hit anyone and HOLD the result page.`,
    url: "https://www.torn.com/loader.php?sid=attack",
    dedupKey: `${episodeKey}:head`,
  });
  const others = order.slice(1);
  if (others.length) {
    await dispatch(db, others, {
      type: "timer_low",
      title: `Chain timer low — ${headName}'s turn`,
      body: `Timer at ${mmss}. ${headName} is up; be ready to back them up.`,
      url: "/",
      dedupKey: `${episodeKey}:others`,
    });
  }
}

async function refreshRoster(
  db: SupabaseClient,
  pollerMember: MemberKeyRow,
  settings: Record<string, number | null>,
): Promise<void> {
  try {
    const torn = await tornFor(pollerMember);
    const [basic, roster] = await Promise.all([torn.factionBasic(), torn.factionMembers()]);

    await db
      .from("settings")
      .update({ leader_id: basic.leader_id, co_leader_id: basic.co_leader_id })
      .eq("id", 1);

    const leaderIds = [basic.leader_id, basic.co_leader_id].filter(Boolean) as number[];
    if (leaderIds.length) {
      await db
        .from("members")
        .update({ is_admin: true, admin_source: "auto" })
        .in("torn_id", leaderIds);
      await db
        .from("members")
        .update({ is_admin: false, admin_source: null })
        .eq("admin_source", "auto")
        .not("torn_id", "in", `(${leaderIds.join(",")})`);
    }

    // members who left the faction lose their active shift
    const rosterIds = new Set(roster.map((m) => m.id));
    const { data: registered } = await db.from("members").select("torn_id, name");
    for (const m of registered ?? []) {
      const fresh = roster.find((r) => r.id === m.torn_id);
      if (fresh && fresh.name !== m.name) {
        await db.from("members").update({ name: fresh.name }).eq("torn_id", m.torn_id);
      }
      if (!rosterIds.has(m.torn_id)) {
        await db
          .from("shifts")
          .update({ ended_at: new Date().toISOString(), end_reason: "admin" })
          .eq("member_id", m.torn_id)
          .is("ended_at", null);
      }
    }
  } catch (e) {
    console.error("roster refresh failed:", e);
  }
}

function toShiftLites(shifts: ActiveShiftRow[]): ShiftLite[] {
  return shifts.map((s) => ({
    memberId: s.member_id,
    startedAt: toS(s.started_at),
    lastSaveAt: s.last_save_at ? toS(s.last_save_at) : null,
  }));
}

async function broadcastState(
  db: SupabaseClient,
  obs: ChainObservation,
  activeShifts: ActiveShiftRow[],
  settings: Record<string, number>,
): Promise<void> {
  const lites = toShiftLites(activeShifts);
  const order = rotationOrder(lites);
  const { data: lastSave } = await db
    .from("saves")
    .select("chain_count, member_id, remaining_at_hit_s, hit_registered_at, status")
    .in("status", ["confirmed", "unattributed"])
    .order("detected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const names = new Map(activeShifts.map((s) => [s.member_id, s.members.name]));
  const payload = {
    chain: {
      id: obs.chainId,
      current: obs.current,
      max: obs.max,
      timeout_s: obs.timeoutS,
      cooldown_s: obs.cooldownS,
      observed_at: obs.polledAt,
    },
    on_duty: order.map((id) => {
      const s = activeShifts.find((x) => x.member_id === id)!;
      return {
        id,
        name: names.get(id) ?? "?",
        started_at: toS(s.started_at),
        last_save_at: s.last_save_at ? toS(s.last_save_at) : null,
      };
    }),
    turn_member_id: order[0] ?? null,
    last_save: lastSave ?? null,
    danger: obs.chainId > 0 && obs.current > 0 && obs.timeoutS <= settings.alert_threshold_s,
    alert_threshold_s: settings.alert_threshold_s,
    poller_at: Math.floor(Date.now() / 1000),
  };

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ topic: "chain", event: "state", payload, private: false }],
      }),
    });
  } catch (e) {
    console.error("broadcast failed:", e);
  }
}
