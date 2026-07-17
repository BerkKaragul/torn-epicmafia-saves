// One poll cycle: observe the chain, run the detector, attribute pending
// saves via on-duty members' own attack logs, manage shifts, alert, poke.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { detect, type ChainObservation } from "../_shared/logic/detect.ts";
import { rotationOrder, type ShiftLite } from "../_shared/logic/rotation.ts";
import { decryptApiKey } from "../_shared/lib/crypto.ts";
import {
  isInvalidKeyError,
  isRateLimitError,
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
  rate_limited_until: string | null;
}

interface ActiveShiftRow {
  id: string;
  member_id: number;
  started_at: string;
  planned_minutes: number | null;
  last_save_at: string | null;
  members: MemberKeyRow;
}

const MEMBER_KEY_COLS = "torn_id, name, api_key_ct, api_key_iv, key_valid, rate_limited_until";

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

function usableKey(m: MemberKeyRow, nowS: number): boolean {
  return (
    m.key_valid &&
    !!m.api_key_ct &&
    (!m.rate_limited_until || toS(m.rate_limited_until) <= nowS)
  );
}

/** Torn error 5 = the key OWNER is over 100 req/min (their other tools count too). */
async function backoffMember(db: SupabaseClient, tornId: number): Promise<void> {
  await db
    .from("members")
    .update({ rate_limited_until: new Date(Date.now() + 90_000).toISOString() })
    .eq("torn_id", tornId);
}

/** v2 spec ambiguity: these fields may be "seconds remaining" or an epoch "until". */
function normalizeRemainingS(raw: number, nowS: number): number {
  if (raw > 1_000_000_000) return Math.max(0, raw - nowS);
  return Math.max(0, raw);
}

export async function runPollCycle(): Promise<void> {
  const db = sb();
  const nowS = Math.floor(Date.now() / 1000);

  const [{ data: settings }, { data: state0 }] = await Promise.all([
    db.from("settings").select("*").eq("id", 1).single(),
    db.from("poller_state").select("*").eq("id", 1).single(),
  ]);
  if (!settings || !state0) return;

  const prevObs: ChainObservation | null = state0.last_poll_at
    ? {
        polledAt: toS(state0.last_poll_at),
        chainId: state0.last_chain_id ?? 0,
        current: state0.last_current ?? 0,
        max: state0.last_max ?? 0,
        timeoutS: state0.last_timeout_s ?? 0,
        cooldownS: state0.last_cooldown_s ?? 0,
      }
    : null;
  const prevActive =
    prevObs !== null && prevObs.chainId > 0 && prevObs.current > 0 && prevObs.cooldownS === 0;

  // ── cadence pre-check: cheap reads only, no lock claim, no writes ──────
  const [{ count: activeShiftCount }, { count: pendingCount }] = await Promise.all([
    db.from("shifts").select("id", { count: "exact", head: true }).is("ended_at", null),
    db
      .from("saves")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);
  const busy = prevActive || (activeShiftCount ?? 0) > 0 || (pendingCount ?? 0) > 0;
  const interval = busy
    ? Math.max(15, settings.poll_interval_s)
    : Math.max(15, settings.idle_poll_interval_s);
  const sinceLast = prevObs ? nowS - prevObs.polledAt : Infinity;
  if (sinceLast < interval - 3) return; // -3 absorbs cron jitter

  // ── overlap lock with ownership token (release only what we claimed) ──
  const token = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - 55_000).toISOString();
  const { data: lockRows } = await db
    .from("poller_state")
    .update({ running_since: token })
    .eq("id", 1)
    .or(`running_since.is.null,running_since.lt.${staleCutoff}`)
    .select("*");
  const state = lockRows?.[0];
  if (!state) return; // another cycle is live

  try {
    const { data: activeShiftsRaw } = await db
      .from("shifts")
      .select(`id, member_id, started_at, planned_minutes, last_save_at, members!inner(${MEMBER_KEY_COLS})`)
      .is("ended_at", null)
      .returns<ActiveShiftRow[]>();
    let activeShifts = activeShiftsRaw ?? [];

    // ── resolve a key and observe the chain ──────────────────────────────
    const pollerMember = await pickPollerMember(db, settings.poller_member_id, activeShifts, nowS);
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
      } else if (isRateLimitError(e)) {
        await backoffMember(db, pollerMember.torn_id);
      }
      console.error("chain poll failed:", e);
      return;
    }

    const obs: ChainObservation = {
      polledAt: nowS,
      chainId: chain.id ?? 0,
      current: chain.current ?? 0,
      max: chain.max ?? 0,
      timeoutS: normalizeRemainingS(chain.timeout ?? 0, nowS),
      cooldownS: normalizeRemainingS(chain.cooldown ?? 0, nowS),
    };
    const obsActive = obs.chainId > 0 && obs.current > 0 && obs.cooldownS === 0;

    // observation log: skip pure idle→idle rows; keep raw only while a chain exists
    if (obs.chainId > 0 || obs.cooldownS > 0 || prevActive) {
      await db.from("chain_polls").insert({
        polled_at: toIso(nowS),
        torn_chain_id: obs.chainId || null,
        current: obs.current,
        timeout_s: obs.timeoutS,
        cooldown_s: obs.cooldownS,
        raw: obs.chainId > 0 ? chain : null,
      });
    }

    // ── run the detector and persist its events ──────────────────────────
    const events = detect(prevObs, obs, {
      saveThresholdS: settings.save_threshold_s,
      alertThresholdS: settings.alert_threshold_s,
      slackS: 5,
    });

    if (obsActive) {
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
          .update({ ended_at: toIso(nowS), end_reason: ev.reason, max_current: ev.finalCount })
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
      } else if (ev.type === "timer_low") {
        // two alert tiers per hit-episode: first crossing the threshold, and
        // a last-chance escalation at ≤45s if nobody has hit yet
        const tier = ev.timeoutS <= 45 ? "critical" : "low";
        const fullKey = `${ev.episodeKey}:${tier}`;
        if (fullKey !== dangerEpisodeKey) {
          dangerEpisodeKey = fullKey;
          await alertDanger(db, activeShifts, ev.timeoutS, fullKey, tier === "critical");
        }
      }
    }

    // ── attribute pending saves via on-duty members' own attack logs ─────
    activeShifts = await attributePendingSaves(db, activeShifts, settings, nowS);

    // ── shift housekeeping (planned durations) ───────────────────────────
    activeShifts = await housekeepShifts(db, activeShifts, nowS);

    // ── periodic roster / leadership refresh ─────────────────────────────
    const rosterAge = state.roster_refreshed_at ? nowS - toS(state.roster_refreshed_at) : Infinity;
    let rosterRefreshedAt = state.roster_refreshed_at;
    if (rosterAge > 600) {
      await refreshRoster(db, pollerMember, settings);
      rosterRefreshedAt = toIso(nowS);
    }

    // ── poke clients when something changed (they re-fetch /api/state) ───
    const order = rotationOrder(toShiftLites(activeShifts));
    const danger = obsActive && obs.timeoutS <= settings.alert_threshold_s;
    const fingerprint = `${obs.chainId}:${obs.current}:${obs.cooldownS > 0}:${danger}:${order.join(",")}`;
    const lastBroadcastS = state.last_broadcast_at ? toS(state.last_broadcast_at) : 0;
    const shouldPoke = fingerprint !== state.last_broadcast_fingerprint || nowS - lastBroadcastS >= 60;
    if (shouldPoke) await pokeClients();

    // ── persist state ────────────────────────────────────────────────────
    await db
      .from("poller_state")
      .update({
        last_poll_at: toIso(nowS),
        last_chain_id: obs.chainId || null,
        last_current: obs.current,
        last_max: obs.max,
        last_timeout_s: obs.timeoutS,
        last_cooldown_s: obs.cooldownS,
        consecutive_errors: 0,
        danger_episode_key: dangerEpisodeKey,
        roster_refreshed_at: rosterRefreshedAt,
        ...(shouldPoke
          ? { last_broadcast_fingerprint: fingerprint, last_broadcast_at: toIso(nowS) }
          : {}),
      })
      .eq("id", 1);
  } finally {
    // release only if we still own the lease — a slow cycle must not clear
    // a newer cycle's claim
    await db
      .from("poller_state")
      .update({ running_since: null })
      .eq("id", 1)
      .eq("running_since", token);
  }
}

async function pickPollerMember(
  db: SupabaseClient,
  preferredId: number | null,
  activeShifts: ActiveShiftRow[],
  nowS: number,
): Promise<MemberKeyRow | null> {
  if (preferredId) {
    const { data } = await db
      .from("members")
      .select(MEMBER_KEY_COLS)
      .eq("torn_id", preferredId)
      .eq("key_valid", true)
      .not("api_key_ct", "is", null)
      .maybeSingle<MemberKeyRow>();
    if (data && usableKey(data, nowS)) return data;
  }
  const onDuty = activeShifts.find((s) => usableKey(s.members, nowS));
  if (onDuty) return onDuty.members;
  const { data: fallback } = await db
    .from("members")
    .select(MEMBER_KEY_COLS)
    .eq("key_valid", true)
    .not("api_key_ct", "is", null)
    .or(`rate_limited_until.is.null,rate_limited_until.lt.${new Date().toISOString()}`)
    .order("last_login_at", { ascending: false })
    .limit(1)
    .maybeSingle<MemberKeyRow>();
  return fallback ?? null;
}

async function attributePendingSaves(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  settings: Record<string, number>,
  nowS: number,
): Promise<ActiveShiftRow[]> {
  const { data: pending } = await db
    .from("saves")
    .select("*")
    .eq("status", "pending")
    .order("window_start", { ascending: true });
  if (!pending?.length) return activeShifts;

  const sweepFromS = Math.min(...pending.map((s) => toS(s.window_start))) - 120;
  const sweepers = activeShifts.filter((s) => usableKey(s.members, nowS));

  // one attacks call per on-duty member per cycle, all in parallel; newest
  // first so a fast chainer's saving hit can't fall off the 100-row page
  const attacksByMember = new Map<number, Awaited<ReturnType<TornClient["userAttacks"]>>>();
  const dropped = new Set<string>();
  await Promise.all(
    sweepers.map(async (shift) => {
      try {
        const torn = await tornFor(shift.members);
        attacksByMember.set(
          shift.member_id,
          await torn.userAttacks({ from: sweepFromS, sort: "desc", limit: 100 }),
        );
      } catch (e) {
        if (isInvalidKeyError(e)) {
          await db.from("members").update({ key_valid: false }).eq("torn_id", shift.member_id);
          await db
            .from("shifts")
            .update({ ended_at: new Date().toISOString(), end_reason: "key_invalid" })
            .eq("id", shift.id)
            .is("ended_at", null);
          dropped.add(shift.id);
        } else if (isRateLimitError(e)) {
          await backoffMember(db, shift.member_id);
        } else {
          console.error(`attack sweep failed for ${shift.member_id}:`, e);
        }
      }
    }),
  );
  activeShifts = activeShifts.filter((s) => !dropped.has(s.id));

  for (const save of pending) {
    const windowStartS = toS(save.window_start);
    const windowEndS = toS(save.window_end);
    let matched = false;

    for (const shift of activeShifts) {
      const attacks = attacksByMember.get(shift.member_id) ?? [];
      const shiftStartS = toS(shift.started_at);
      const hit = attacks.find(
        (a) =>
          // outgoing regardless of stealth: incoming always has us as defender
          a.defender?.id !== shift.member_id &&
          a.chain === save.chain_count &&
          a.chain > 0 &&
          !a.is_interrupted &&
          a.ended >= windowStartS - 5 &&
          a.ended <= windowEndS + 90 &&
          // no bonus for a hit landed before the member enlisted
          a.ended >= shiftStartS - 5,
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
          .eq("id", save.id)
          .eq("status", "pending"); // never clobber an admin's manual call
      } else {
        const { data: confirmedRow } = await db
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
          .eq("id", save.id)
          .eq("status", "pending") // never clobber an admin's manual call
          .is("payout_line_id", null)
          .select("id")
          .maybeSingle();
        if (confirmedRow) {
          await db.from("shifts").update({ last_save_at: toIso(hit.ended) }).eq("id", shift.id);
          shift.last_save_at = toIso(hit.ended);
          const shown = Math.max(0, Math.round(remaining));
          await dispatch(db, [shift.member_id], {
            type: "save_confirmed",
            title: "Save confirmed ✅",
            body: `Chain hit #${save.chain_count} with ${shown}s left — bonus $${Number(settings.per_save_bonus).toLocaleString()}`,
            url: "/duty",
            dedupKey: `save_confirmed:${save.id}`,
          });
        }
      }
      matched = true;
      break;
    }

    if (!matched) {
      // only burn an attempt when at least one sweep actually returned data
      if (attacksByMember.size === 0) continue;
      const attempts = (save.attempts ?? 0) + 1;
      if (attempts >= 20) {
        // ~5 minutes of real sweeps: someone outside the saver roster made the hit
        await db
          .from("saves")
          .update({ status: "unattributed", attempts })
          .eq("id", save.id)
          .eq("status", "pending");
        const head = rotationOrder(toShiftLites(activeShifts))[0];
        if (head) {
          await dispatch(db, [head], {
            type: "scooped",
            title: "Save done by someone else",
            body: `Chain hit #${save.chain_count} was saved by a non-enlisted member. Your turn continues.`,
            url: "/",
            dedupKey: `scooped:${save.id}`,
          });
        }
      } else {
        await db.from("saves").update({ attempts }).eq("id", save.id).eq("status", "pending");
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
      });
    } else {
      if (endS - nowS <= 600) {
        await dispatch(db, [shift.member_id], {
          type: "shift_ending_soon",
          title: "Shift ends in 10 minutes",
          body: "Your saver shift ends soon — open the duty page to extend it.",
          url: "/duty",
          dedupKey: `shift_warn:${shift.id}`,
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
  critical: boolean,
): Promise<void> {
  const order = rotationOrder(toShiftLites(activeShifts));
  const head = order[0];
  if (!head) return;
  const mmss = `${Math.floor(timeoutS / 60)}:${String(Math.floor(timeoutS % 60)).padStart(2, "0")}`;
  const headName = activeShifts.find((s) => s.member_id === head)?.members.name ?? "?";

  await dispatch(db, [head], {
    type: "your_turn",
    title: critical ? `🚨 LAST CHANCE — ${mmss} LEFT` : "🚨 YOUR TURN — SAVE NOW",
    body: `Chain timer at ${mmss}. Hit anyone and HOLD the result page.`,
    url: "https://www.torn.com/loader.php?sid=attack",
    dedupKey: `${episodeKey}:head`,
  });
  const others = order.slice(1);
  if (others.length) {
    await dispatch(db, others, {
      type: "timer_low",
      title: critical
        ? `🚨 Chain about to drop — ${mmss}`
        : `Chain timer low — ${headName}'s turn`,
      body: critical
        ? `Timer at ${mmss} and no hit yet. Anyone save it NOW.`
        : `Timer at ${mmss}. ${headName} is up; be ready to back them up.`,
      url: "/",
      dedupKey: `${episodeKey}:others`,
    });
  }
}

async function refreshRoster(
  db: SupabaseClient,
  pollerMember: MemberKeyRow,
  settings: { faction_id: number },
): Promise<void> {
  try {
    const torn = await tornFor(pollerMember);
    const [basic, roster] = await Promise.all([torn.factionBasic(), torn.factionMembers()]);

    if (basic.id !== settings.faction_id) {
      console.error(
        `poller key belongs to faction ${basic.id}, app tracks ${settings.faction_id} — skipping roster sync`,
      );
      return;
    }

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

/**
 * Content-free nudge on the public Realtime channel. Clients react by
 * re-fetching the authenticated /api/state, so a forged broadcast can waste a
 * fetch but can never spoof chain state, and the channel leaks nothing.
 */
async function pokeClients(): Promise<void> {
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
        messages: [{ topic: "chain", event: "poke", payload: {}, private: false }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    console.error("poke failed:", e);
  }
}
