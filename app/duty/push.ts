"use client";

// Browser-side web push plumbing for the duty page.

export type PushStatus = "unsupported" | "denied" | "off" | "on";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// A subscription is bound to the server key it was made with; after a key
// change it still looks "on" here but every push to it is rejected.
function madeWithKey(sub: PushSubscription, vapid: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // browser doesn't say — assume it's fine
  const a = new Uint8Array(key);
  const b = urlBase64ToUint8Array(vapid);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function currentPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (sub && vapid && !madeWithKey(sub, vapid) && Notification.permission === "granted") {
    // left over from the old key: renew it quietly (no prompt, permission
    // is already granted) so the member keeps their alerts
    try {
      return await enablePush();
    } catch {
      return "off";
    }
  }
  return sub ? "on" : "off";
}

export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid) throw new Error("Push isn't configured on the server yet.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !madeWithKey(sub, vapid)) {
    await sub.unsubscribe(); // subscribe() refuses while one with another key exists
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapid) as BufferSource,
  });

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) throw new Error("Could not register the subscription.");
  return "on";
}

export async function disablePush(): Promise<PushStatus> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  return "off";
}
