"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser client with the anon key — used ONLY for the public Realtime
// channel. RLS blocks the anon role from reading any table.
let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!client) client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}
