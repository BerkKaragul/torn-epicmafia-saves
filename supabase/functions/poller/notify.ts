// Notification dispatch abstraction. The poller emits semantic events; this
// module fans them out to channels. v1 ships Web Push — a Discord webhook
// channel can be added here later without touching detection code.
//
// Dedup is a DATABASE claim: a unique index on notifications_log
// (dedup_key, member_id, channel) and insert-on-conflict-do-nothing decide
// who sends. At-most-once holds even if two poller cycles race. Members with
// no push subscription are not claimed, so subscribing later still works for
// future events.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

export interface NotifyEvent {
  type:
    | "your_turn"
    | "timer_low"
    | "scooped"
    | "shift_ending_soon"
    | "shift_end"
    | "save_confirmed"
    | "missed_turn"
    | "chain_dropped"
    | "saver_left";
  title: string;
  body: string;
  url?: string;
  /** each (dedupKey, member) pair is sent at most once, ever */
  dedupKey: string;
}

interface PushSubRow {
  id: string;
  member_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  failed_count: number;
}

let appServer: webpush.ApplicationServer | null | undefined;

async function getAppServer(): Promise<webpush.ApplicationServer | null> {
  if (appServer !== undefined) return appServer;
  const keysJson = Deno.env.get("VAPID_KEYS");
  if (!keysJson) {
    console.warn("VAPID_KEYS not set — web push disabled");
    appServer = null;
    return null;
  }
  const vapidKeys = await webpush.importVapidKeys(JSON.parse(keysJson), {
    extractable: false,
  });
  appServer = await webpush.ApplicationServer.new({
    contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
    vapidKeys,
  });
  return appServer;
}

export async function dispatch(
  sb: SupabaseClient,
  memberIds: number[],
  ev: NotifyEvent,
): Promise<void> {
  if (memberIds.length === 0) return;
  const server = await getAppServer();
  if (!server) return;

  const { data: subs } = await sb
    .from("push_subscriptions")
    .select("id, member_id, endpoint, p256dh, auth, failed_count")
    .in("member_id", memberIds)
    .eq("disabled", false);
  const subRows = (subs ?? []) as PushSubRow[];
  const withSubs = [...new Set(subRows.map((s) => s.member_id))];
  if (withSubs.length === 0) return;

  // claim: only rows that actually insert are ours to send
  const { data: won } = await sb
    .from("notifications_log")
    .upsert(
      withSubs.map((memberId) => ({
        member_id: memberId,
        channel: "webpush",
        event_type: ev.type,
        dedup_key: ev.dedupKey,
      })),
      { onConflict: "dedup_key,member_id,channel", ignoreDuplicates: true },
    )
    .select("id, member_id");
  if (!won?.length) return;

  const payload = JSON.stringify({
    title: ev.title,
    body: ev.body,
    url: ev.url ?? "/",
    type: ev.type,
  });

  await Promise.all(
    won.map(async (claim: { id: number; member_id: number }) => {
      let success = true;
      let error: string | null = null;
      for (const sub of subRows.filter((s) => s.member_id === claim.member_id)) {
        try {
          const subscriber = server.subscribe({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          });
          await subscriber.pushTextMessage(payload, { urgency: webpush.Urgency.High });
        } catch (e) {
          success = false;
          error = e instanceof Error ? e.message : String(e);
          const gone =
            e instanceof webpush.PushMessageError &&
            (e.response.status === 404 || e.response.status === 410);
          await sb
            .from("push_subscriptions")
            .update(
              gone
                ? { disabled: true, failed_count: sub.failed_count + 1 }
                : { failed_count: sub.failed_count + 1 },
            )
            .eq("id", sub.id);
        }
      }
      await sb.from("notifications_log").update({ success, error }).eq("id", claim.id);
    }),
  );
}
