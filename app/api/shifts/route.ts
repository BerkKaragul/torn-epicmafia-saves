import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import type { SettingsRow, ShiftRow } from "@/lib/types";

// POST = start a duty shift, PATCH = stop the active one
export async function POST(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  if (!member.key_valid) {
    return NextResponse.json(
      { error: "Your stored API key stopped working — log in again first." },
      { status: 400 },
    );
  }

  let plannedMinutes: number | null = null;
  try {
    const body = await req.json();
    if (body.plannedMinutes != null) {
      plannedMinutes = Math.floor(Number(body.plannedMinutes));
      if (!Number.isFinite(plannedMinutes) || plannedMinutes < 5 || plannedMinutes > 24 * 60) {
        return NextResponse.json(
          { error: "Planned duration must be between 5 minutes and 24 hours." },
          { status: 400 },
        );
      }
    }
  } catch {
    // empty body = open-ended shift
  }

  const { data: settings } = await db()
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single<SettingsRow>();

  const { data: shift, error } = await db()
    .from("shifts")
    .insert({
      member_id: member.torn_id,
      planned_minutes: plannedMinutes,
      hourly_rate_snapshot: settings?.hourly_rate ?? 0,
    })
    .select("*")
    .single<ShiftRow>();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "You're already on duty." }, { status: 409 });
    }
    console.error("shift start failed", error);
    return NextResponse.json({ error: "Could not start shift." }, { status: 500 });
  }
  return NextResponse.json({ shift });
}

export async function PATCH() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const { data: shift, error } = await db()
    .from("shifts")
    .update({ ended_at: new Date().toISOString(), end_reason: "manual" })
    .eq("member_id", member.torn_id)
    .is("ended_at", null)
    .select("*")
    .maybeSingle<ShiftRow>();

  if (error) {
    console.error("shift stop failed", error);
    return NextResponse.json({ error: "Could not stop shift." }, { status: 500 });
  }
  if (!shift) return NextResponse.json({ error: "You're not on duty." }, { status: 409 });
  return NextResponse.json({ shift });
}
