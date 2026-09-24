// Billing sweep: turns Xanax the vendor received in-game into subscription
// time. Runs at most once a minute (lease on platform_config), after the
// faction cycles.
//
//   1. read the vendor's item-receive logs since the cursor (Full Access key)
//   2. for each Xanax receipt: pick the faction to credit — the one named in
//      the message ("CW 12345"), else the sender's current faction
//   3. record_payment() inserts it (deduped by log id) and extends that
//      faction's subscription_expires_at
//   4. end open saver shifts of factions whose subscription ran out

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findReceiveLogTypes, parseItemReceive } from "../_shared/logic/billing.ts";
import { decryptApiKey } from "../_shared/lib/crypto.ts";
import {
  isInvalidKeyError,
  makeTornClient,
  type TornClient,
  type TornUserLog,
} from "../_shared/lib/torn.ts";

const SWEEP_EVERY_S = 60;
/** How far back the very first sweep looks, so early payments aren't missed. */
const FIRST_LOOKBACK_S = 3 * 86400;

export async function runBillingSweep(db: SupabaseClient): Promise<void> {
  const now = new Date();
  const staleLease = new Date(now.getTime() - 120_000).toISOString();
  const due = new Date(now.getTime() - (SWEEP_EVERY_S - 3) * 1000).toISOString();

  // cheap "is a sweep due?" read first; the lease below settles any race
  const { data: peek } = await db
    .from("platform_config")
    .select("last_billing_sweep_at")
    .eq("id", 1)
    .single();
  if (peek?.last_billing_sweep_at && Date.parse(peek.last_billing_sweep_at) > Date.parse(due)) return;

  // claim the lease only if nobody else holds it
  const token = now.toISOString();
  const { data: claimed } = await db
    .from("platform_config")
    .update({ billing_running_since: token })
    .eq("id", 1)
    .or(`billing_running_since.is.null,billing_running_since.lt.${staleLease}`)
    .select("*");
  const cfg = claimed?.[0];
  if (!cfg) return;

  let error: string | null = null;
  let cursor: number | null = cfg.billing_cursor ?? null;
  try {
    await expireShifts(db);
    if (cfg.xanax_per_period && cfg.vendor_key_ct && cfg.vendor_key_iv && cfg.vendor_key_valid) {
      cursor = await sweepVendorLog(db, cfg);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("billing sweep failed:", e);
  } finally {
    await db
      .from("platform_config")
      .update({
        billing_running_since: null,
        last_billing_sweep_at: now.toISOString(),
        last_billing_error: error,
        billing_cursor: cursor,
      })
      .eq("id", 1)
      .eq("billing_running_since", token);
  }
}

interface PlatformConfigRow {
  xanax_per_period: number | null;
  xanax_item_id: number;
  vendor_key_ct: string;
  vendor_key_iv: string;
  receive_log_type_ids: number[] | null;
  billing_cursor: number | null;
}

/** Returns the new cursor (newest log timestamp seen). */
async function sweepVendorLog(db: SupabaseClient, cfg: PlatformConfigRow): Promise<number | null> {
  const key = await decryptApiKey(cfg.vendor_key_ct, cfg.vendor_key_iv, Deno.env.get("API_KEY_ENC_KEY")!);
  const torn = makeTornClient({ apiKey: key, baseUrl: Deno.env.get("TORN_API_BASE") || undefined });

  let typeIds = cfg.receive_log_type_ids ?? [];
  if (typeIds.length === 0) {
    typeIds = findReceiveLogTypes(await torn.logTypes());
    if (typeIds.length === 0) throw new Error("no 'item receive' log type found in /torn/logtypes");
    await db.from("platform_config").update({ receive_log_type_ids: typeIds }).eq("id", 1);
  }

  const nowS = Math.floor(Date.now() / 1000);
  const from = cfg.billing_cursor ?? nowS - FIRST_LOOKBACK_S;
  let logs;
  try {
    logs = await fetchLogWindow(torn, typeIds, from);
  } catch (e) {
    if (isInvalidKeyError(e)) {
      await db.from("platform_config").update({ vendor_key_valid: false }).eq("id", 1);
    }
    throw e;
  }

  let newest = cfg.billing_cursor ?? from;
  const factionOf = new Map<number, { id: number; name: string } | null>();
  for (const entry of logs) {
    newest = Math.max(newest, entry.timestamp);
    const receipt = parseItemReceive(entry, cfg.xanax_item_id);
    if (!receipt) continue;

    let factionId = receipt.targetFactionId;
    let factionName: string | null = null;
    if (!factionId && receipt.senderId) {
      if (!factionOf.has(receipt.senderId)) {
        try {
          const f = await torn.userFaction(receipt.senderId);
          factionOf.set(receipt.senderId, f ? { id: f.id, name: f.name } : null);
        } catch (e) {
          // can't tell who they fly for right now — try again next sweep by
          // not advancing the cursor past this entry
          console.error(`faction lookup for ${receipt.senderId} failed:`, e);
          return Math.min(newest, receipt.receivedAt - 1);
        }
      }
      const f = factionOf.get(receipt.senderId);
      factionId = f?.id ?? null;
      factionName = f?.name ?? null;
    }

    const { data, error } = await db.rpc("record_payment", {
      p_source: "torn_log",
      p_log_id: receipt.logId,
      p_sender: receipt.senderId,
      p_sender_name: null,
      p_faction: factionId,
      p_faction_name: factionName,
      p_quantity: receipt.quantity,
      p_received_at: new Date(receipt.receivedAt * 1000).toISOString(),
      p_note: receipt.message,
    });
    if (error) throw new Error(`record_payment failed: ${error.message}`);
    if (data?.status === "applied") {
      console.log(`payment ${receipt.logId}: ${receipt.quantity} → faction ${factionId}`);
    }
  }
  return newest;
}

/**
 * Every item-receive log since `from`, following pages when a window holds
 * more than one page (the first sweep looks back days, and a busy vendor
 * receives plenty of items besides Xanax). The API's sort order for logs isn't
 * documented, so the next page is chosen from whichever end the page came in.
 */
async function fetchLogWindow(
  torn: TornClient,
  typeIds: number[],
  from: number,
): Promise<TornUserLog[]> {
  const PAGE = 100;
  const all = new Map<string, TornUserLog>();
  let lo = from;
  let hi: number | undefined;
  for (let page = 0; page < 10; page++) {
    const logs = await torn.userLog({ log: typeIds, from: lo, to: hi, limit: PAGE });
    for (const l of logs) all.set(String(l.id), l);
    if (logs.length < PAGE) break;
    const stamps = logs.map((l) => l.timestamp);
    const newestFirst = stamps[0] >= stamps[stamps.length - 1];
    if (newestFirst) {
      const oldest = Math.min(...stamps);
      if (hi !== undefined && oldest >= hi) break; // no progress
      hi = oldest;
    } else {
      const newest = Math.max(...stamps);
      if (newest <= lo) break; // no progress
      lo = newest;
    }
  }
  // oldest first, so an early return in the caller never skips an older entry
  return [...all.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Subscription ran out (or the faction was suspended): nobody keeps accruing. */
async function expireShifts(db: SupabaseClient): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: lapsed } = await db
    .from("factions")
    .select("faction_id")
    .or(`suspended.eq.true,subscription_expires_at.is.null,subscription_expires_at.lt.${nowIso}`);
  const ids = (lapsed ?? []).map((f: { faction_id: number }) => f.faction_id);
  if (ids.length === 0) return;
  await db
    .from("shifts")
    .update({ ended_at: nowIso, end_reason: "subscription_expired" })
    .in("faction_id", ids)
    .is("ended_at", null);
}
