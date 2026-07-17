import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Hit daily by Vercel cron. The PostgREST read counts as external API activity
// on the Supabase project, which prevents free-tier auto-pausing.
export const dynamic = "force-dynamic";

export async function GET() {
  const { error } = await db().from("settings").select("id").eq("id", 1).single();
  return NextResponse.json({ ok: !error, at: new Date().toISOString() });
}
