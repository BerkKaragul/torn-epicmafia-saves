// Notification dispatch abstraction. The poller emits semantic events; this
// module fans them out to channels. v1 ships Web Push — a Discord webhook
// channel can be added here later without touching detection code.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.5.0";

export interface NotifyEvent {
  type:
    | "your_turn"
    | "timer_low"
    | "scooped"
    | "shift_ending_soon"
    | "shift_end"
    | "save_confirmed";
  title: string;
  body: string;
  url?: string;
  /** identical dedupKey within dedupWindowS is sent at most once per member */
  dedupKey: string;
  dedupWindowS?: number;
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
  const windowS = ev.dedupWindowS ?? 240;
  const since = new Date(Date.now() - windowS * 1000).toISOString();

  const { data: recent } = await sb
    .from("notifications_log")
    .select("member_id")
    .eq("dedup_key", ev.dedupKey)
    .gte("sent_at", since);
  const alreadySent = new Set((recent ?? []).map((r: { member_id: number }) => r.member_id));
  const targets = memberIds.filter((id) => !alreadySent.has(id));
  if (targets.length === 0) return;

  const { data: subs } = await sb
    .from("push_subscriptions")
    .select("id, member_id, endpoint, p256dh, auth, failed_count")
    .in("member_id", targets)
    .eq("disabled", false);

  const server = await getAppServer();
  const payload = JSON.stringify({
    title: ev.title,
    body: ev.body,
    url: ev.url ?? "/",
    type: ev.type,
  });

  const logRows: Record<string, unknown>[] = [];
  for (const memberId of targets) {
    const memberSubs = ((subs ?? []) as PushSubRow[]).filter((s) => s.member_id === memberId);
    let success = memberSubs.length > 0 && server !== null;
    let error: string | null = null;

    for (const sub of memberSubs) {
      if (!server) break;
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
          e instanceof webpush.PushMessageError && (e.response.status === 404 || e.response.status === 410);
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

    logRows.push({
      member_id: memberId,
      channel: "webpush",
      event_type: ev.type,
      dedup_key: ev.dedupKey,
      success,
      error,
    });
  }
  if (logRows.length) await sb.from("notifications_log").insert(logRows);
}
