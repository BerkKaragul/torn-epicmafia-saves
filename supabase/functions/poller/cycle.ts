// One poll cycle: observe the chain, run the detector, attribute pending
// saves via on-duty members' own attack logs, manage shifts, alert, poke.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { detect, type ChainEvent, type ChainObservation } from "../_shared/logic/detect.ts";
import { rotationOrder, type ShiftLite } from "../_shared/logic/rotation.ts";
import { saveBonus, type SaveBonusMode } from "../_shared/logic/pay.ts";
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
  unavailable_state: string | null;
  members: MemberKeyRow;
}

// Torn states in which a member simply cannot land a save. "Abroad" is fine —
// you can attack others in the same country.
const BLOCKING_STATES = new Set(["Traveling", "Hospital", "Jail", "Federal"]);

const MEMBER_KEY_COLS = "torn_id, name, api_key_ct, api_key_iv, key_valid, rate_limited_until";

interface PollerSettings {
  faction_id: number;
  poll_interval_s: number;
  idle_poll_interval_s: number;
  poller_member_id: number | null;
  save_threshold_s: number;
  alert_threshold_s: number;
  per_save_bonus: number;
  save_bonus_mode: SaveBonusMode;
  milestone_warn_hits: number;
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

  const [{ data: settingsRow }, { data: state0 }] = await Promise.all([
    db.from("settings").select("*").eq("id", 1).single(),
    db.from("poller_state").select("*").eq("id", 1).single(),
  ]);
  if (!settingsRow || !state0) return;
  const settings = settingsRow as PollerSettings;

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
      .select(
        `id, member_id, started_at, planned_minutes, last_save_at, unavailable_state, members!inner(${MEMBER_KEY_COLS})`,
      )
      .is("ended_at", null)
      .returns<ActiveShiftRow[]>();
    let activeShifts = activeShiftsRaw ?? [];

    // ── resolve a key and observe the chain ──────────────────────────────
    const pollerMember = await pickPollerMember(db, settings.poller_member_id, activeShifts, nowS);
    if (!pollerMember) {
      console.warn("no usable API key to poll with — nobody has logged in yet?");
      return;
    }

    let pollerTorn: TornClient;
    try {
      pollerTorn = await tornFor(pollerMember);
    } catch (e) {
      console.error("could not build poller client:", e);
      return;
    }

    let chain;
    try {
      chain = await pollerTorn.factionChain();
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

    // who physically can't save right now (flying, hospital, jail) — must run
    // before rotation is used for alerts / save ownership
    activeShifts = await syncAvailability(db, activeShifts, pollerTorn);

    // ── run the detector and persist its events ──────────────────────────
    const events = detect(prevObs, obs, {
      saveThresholdS: settings.save_threshold_s,
      alertThresholdS: settings.alert_threshold_s,
      milestoneWarnHits: settings.milestone_warn_hits,
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
        // whoever is up right now owns this save opportunity
        const headAtDanger = rotationOrder(toShiftLites(activeShifts))[0] ?? null;
        await db.from("saves").upsert(
          {
            torn_chain_id: ev.chainId,
            chain_count: ev.chainCount,
            window_start: toIso(ev.windowStart),
            window_end: toIso(ev.windowEnd),
            timeout_at_window_start: ev.timeoutAtWindowStart,
            expected_member_id: headAtDanger,
            status: "pending",
          },
          { onConflict: "torn_chain_id,chain_count", ignoreDuplicates: true },
        );
      } else if (ev.type === "milestone_near") {
        // one heads-up per milestone per chain, then a final shout when the
        // very next hit is the bonus
        const finalHit = ev.hitsAway <= 1;
        await dispatch(db, activeShifts.map((s) => s.member_id), {
          type: "milestone_near",
          title: finalHit
            ? `💎 NEXT HIT IS THE ${ev.milestone.toLocaleString()} BONUS`
            : `💎 ${ev.hitsAway} hits to the ${ev.milestone.toLocaleString()} bonus`,
          body: finalHit
            ? `Do NOT let this chain drop — the ${ev.milestone.toLocaleString()} bonus is one hit away.`
            : `Chain is at ${ev.current.toLocaleString()}. Losing it now costs the ${ev.milestone.toLocaleString()} bonus — stay sharp.`,
          url: "/",
          dedupKey: `milestone:${ev.chainId}:${ev.milestone}:${finalHit ? "final" : "near"}`,
        });
      } else if (ev.type === "timer_low") {
        // two alert tiers per hit-episode: first crossing the threshold, and
        // a last-chance escalation at ≤45s if nobody has hit yet
        const tier = ev.timeoutS <= 45 ? "critical" : "low";
        const fullKey = `${ev.episodeKey}:${tier}`;
        if (fullKey !== dangerEpisodeKey) {
          dangerEpisodeKey = fullKey;
          await alertDanger(
            db,
            activeShifts,
            ev.timeoutS,
            fullKey,
            tier === "critical",
            settings.faction_id,
          );
        }
      }
    }

    // ── attribute pending saves via on-duty members' own attack logs ─────
    activeShifts = await attributePendingSaves(db, activeShifts, settings, nowS);

    // ── shift housekeeping (planned durations) ───────────────────────────
    activeShifts = await housekeepShifts(db, activeShifts, nowS);

    // ── an established chain died: blame the turn-holder, stop the pay ───
    const droppedChain = events.find(
      (e): e is Extract<ChainEvent, { type: "chain_ended" }> =>
        e.type === "chain_ended" && e.reason === "dropped" && e.finalCount >= 10,
    );
    if (droppedChain && activeShifts.length > 0) {
      activeShifts = await handleChainDropped(db, activeShifts, droppedChain);
    }

    // ── broadcast urgent leave notes from savers who just stopped ────────
    const { data: pendingNotes } = await db
      .from("announcements")
      .select("*, members(name)")
      .is("processed_at", null)
      .order("created_at");
    for (const note of pendingNotes ?? []) {
      const others = activeShifts.map((s) => s.member_id).filter((id) => id !== note.member_id);
      const who = note.members?.name ?? `[${note.member_id}]`;
      if (others.length) {
        await dispatch(db, others, {
          type: "saver_left",
          title: note.was_head ? `🚨 ${who} bailed on their TURN` : `⚠️ Saver left: ${who}`,
          body: note.message ?? "They can no longer save — adjust accordingly.",
          url: "/",
          dedupKey: `saver_left:${note.id}`,
        });
      }
      await db
        .from("announcements")
        .update({ processed_at: toIso(nowS) })
        .eq("id", note.id);
    }
    // if the head bailed while the timer is already low, the promoted head
    // must get their your-turn push immediately (dedup targets only them)
    const headBailed = (pendingNotes ?? []).some((n) => n.was_head);
    const nowDangerous =
      obsActive && obs.timeoutS <= settings.alert_threshold_s && activeShifts.length > 0;
    if (headBailed && nowDangerous) {
      const tier = obs.timeoutS <= 45 ? "critical" : "low";
      await alertDanger(
        db,
        activeShifts,
        obs.timeoutS,
        `timer_low:${obs.chainId}:${obs.current}:${tier}`,
        tier === "critical",
        settings.faction_id,
      );
    }

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
  settings: PollerSettings,
  nowS: number,
): Promise<ActiveShiftRow[]> {
  const { data: pending } = await db
    .from("saves")
    .select("*")
    .eq("status", "pending")
    .order("window_start", { ascending: true });
  if (!pending?.length) return activeShifts;

  const sweepFromS = Math.min(...pending.map((s) => toS(s.window_start))) - 120;
  // only the turn-holders responsible for a pending save need verifying
  const expectedHeads = new Set(
    pending.map((s) => s.expected_member_id).filter((id): id is number => id != null),
  );
  const sweepers = activeShifts.filter(
    (s) => usableKey(s.members, nowS) && expectedHeads.has(s.member_id),
  );

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

  const threshold = settings.save_threshold_s;
  for (const save of pending) {
    const windowStartS = toS(save.window_start);
    const windowEndS = toS(save.window_end);
    const headId: number | null = save.expected_member_id ?? null;
    const headShift = headId ? activeShifts.find((s) => s.member_id === headId) : undefined;
    const headSwept = headId != null && attacksByMember.has(headId);

    // Only the turn-holder can claim this save, and only by LANDING a
    // successful hit (chain > 0) they COMMITTED while the timer was low. We
    // judge by `started` (energy-commit time), so a teammate's war hit
    // resetting the timer mid-attack doesn't rob them of the credit.
    const hit = headShift
      ? (attacksByMember.get(headId!) ?? []).find((a) => {
          if (a.defender?.id === headId) return false; // incoming, not ours
          if (a.chain <= 0 || a.is_interrupted) return false; // must be a successful chain hit
          const shiftStartS = toS(headShift.started_at);
          if (a.ended < shiftStartS - 5) return false; // before they enlisted
          if (a.ended < windowStartS - 5 || a.ended > windowEndS + 150) return false;
          const remainingAtCommit = save.timeout_at_window_start - (a.started - windowStartS);
          // they either made the resetting hit, or committed under the threshold
          return a.chain === save.chain_count || remainingAtCommit <= threshold + 5;
        })
      : undefined;

    if (hit) {
      const remaining = Math.max(0, save.timeout_at_window_start - (hit.started - windowStartS));
      const bonus = saveBonus(
        settings.save_bonus_mode,
        Number(settings.per_save_bonus),
        save.chain_count,
      );
      const { data: confirmedRow } = await db
        .from("saves")
        .update({
          status: "confirmed",
          member_id: headId,
          attack_id: hit.id,
          attack_code: hit.code,
          hit_registered_at: toIso(hit.ended),
          remaining_at_hit_s: remaining,
          bonus_snapshot: bonus,
        })
        .eq("id", save.id)
        .eq("status", "pending") // never clobber an admin's manual call
        .is("payout_line_id", null)
        .select("id")
        .maybeSingle();
      if (confirmedRow && headShift) {
        await db.from("shifts").update({ last_save_at: toIso(hit.ended) }).eq("id", headShift.id);
        headShift.last_save_at = toIso(hit.ended);
        await dispatch(db, [headId!], {
          type: "save_confirmed",
          title: "Save confirmed ✅",
          body: `Chain hit #${save.chain_count} with ${Math.round(remaining)}s left — bonus $${bonus.toLocaleString()}`,
          url: "/duty",
          dedupKey: `save_confirmed:${save.id}`,
        });
      }
      continue;
    }

    // No qualifying hit yet. If the turn-holder is on duty but we haven't
    // fetched their log this cycle (rate-limited), wait rather than penalize.
    if (headShift && !headSwept) continue;

    // The turn-holder didn't save it (a teammate's hit / war hit reset the
    // timer, or they only made a losing attack). Retry a while — they may be
    // mid-attack or holding — then rule it a bystander bail: NOBODY is
    // credited and the turn-holder KEEPS their turn (rotation not advanced).
    const attempts = (save.attempts ?? 0) + 1;
    if (attempts >= 20) {
      await db
        .from("saves")
        .update({ status: "unattributed", attempts })
        .eq("id", save.id)
        .eq("status", "pending");
      if (headId) {
        await dispatch(db, [headId], {
          type: "scooped",
          title: "Chain bailed by someone else",
          body: `Hit #${save.chain_count} was reset by another member / a war hit — you didn't land a save, so it's still your turn.`,
          url: "/",
          dedupKey: `scooped:${save.id}`,
        });
      }
    } else {
      await db.from("saves").update({ attempts }).eq("id", save.id).eq("status", "pending");
    }
  }
  return activeShifts;
}

/**
 * A 10+ chain dropped with savers on duty. The rotation head "missed their
 * turn" (tallied in missed_turns), and availability pay stops for everyone:
 * all active shifts end now with reason chain_dropped — paid up to this
 * moment, nothing after. Members re-enlist when the next chain starts.
 */
async function handleChainDropped(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  ev: { chainId: number; finalCount: number },
): Promise<ActiveShiftRow[]> {
  const head = rotationOrder(toShiftLites(activeShifts))[0] ?? null;
  if (head) {
    await db.from("missed_turns").insert({
      torn_chain_id: ev.chainId,
      chain_count_at_drop: ev.finalCount,
      member_id: head,
    });
  }
  await db
    .from("shifts")
    .update({ ended_at: new Date().toISOString(), end_reason: "chain_dropped" })
    .is("ended_at", null);

  if (head) {
    await dispatch(db, [head], {
      type: "missed_turn",
      title: "💀 Chain lost on your turn",
      body: `The ${ev.finalCount.toLocaleString()}-chain died while you were up. It's on your record. All saver shifts have ended.`,
      url: "/duty",
      dedupKey: `missed_turn:${ev.chainId}`,
    });
  }
  const others = activeShifts.map((s) => s.member_id).filter((id) => id !== head);
  if (others.length) {
    await dispatch(db, others, {
      type: "chain_dropped",
      title: "Chain dropped — shifts ended",
      body: `The ${ev.finalCount.toLocaleString()}-chain died. Availability pay stopped; re-enlist when the next chain starts.`,
      url: "/duty",
      dedupKey: `chain_dropped:${ev.chainId}`,
    });
  }
  return [];
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
  factionId: number,
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
    url: `https://www.torn.com/factions.php?step=profile&ID=${factionId}`,
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
    available: !s.unavailable_state,
  }));
}

/**
 * Flying / hospitalised / jailed savers can't land a hit, so they're skipped
 * for the turn and their pay clock stops (unavailable_periods drive billing).
 * One faction/members call covers everyone on duty.
 */
async function syncAvailability(
  db: SupabaseClient,
  activeShifts: ActiveShiftRow[],
  torn: TornClient,
): Promise<ActiveShiftRow[]> {
  if (activeShifts.length === 0) return activeShifts;
  let roster;
  try {
    roster = await torn.factionMembers();
  } catch (e) {
    console.error("availability check failed:", e);
    return activeShifts; // keep last known state rather than guessing
  }
  const stateById = new Map(roster.map((m) => [m.id, m.status?.state ?? "Okay"]));
  const nowIso = new Date().toISOString();

  for (const shift of activeShifts) {
    const state = stateById.get(shift.member_id) ?? "Okay";
    const blocked = BLOCKING_STATES.has(state) ? state : null;
    if (blocked === shift.unavailable_state) continue;

    // close any open period first so intervals stay disjoint (also covers
    // Hospital → Traveling style transitions)
    await db
      .from("unavailable_periods")
      .update({ ended_at: nowIso })
      .eq("member_id", shift.member_id)
      .is("ended_at", null);
    if (blocked) {
      await db
        .from("unavailable_periods")
        .insert({ member_id: shift.member_id, state: blocked });
    }
    await db.from("shifts").update({ unavailable_state: blocked }).eq("id", shift.id);
    shift.unavailable_state = blocked;
  }
  return activeShifts;
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
