"use client";

// The poller's content-free "something changed" nudge, as Server-Sent Events
// from the ChainWatch server (server/vps.ts; it replaced Supabase Realtime).
// Clients react by re-fetching the authenticated /api/state, so a forged event
// can waste a fetch but can never spoof chain state, and the stream leaks
// nothing. NEXT_PUBLIC_SUPABASE_URL now points at that server.
export function subscribePoke(
  onPoke: () => void,
  onStatus?: (up: boolean) => void,
): () => void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url || typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`${url}/realtime/v1/events`);
  es.addEventListener("poke", onPoke);
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false); // EventSource reconnects by itself
  return () => es.close();
}
