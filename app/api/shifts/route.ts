import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";
import type { ShiftRow } from "@/lib/types";

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

  // start_shift enforces the saver cap atomically under an advisory lock
  const { data, error } = await db().rpc("start_shift", {
    p_member_id: member.torn_id,
    p_planned_minutes: plannedMinutes,
  });
  if (error) {
    console.error("shift start failed", error);
    return NextResponse.json({ error: "Could not start shift." }, { status: 500 });
  }
  if (data?.error === "full") {
    return NextResponse.json(
      {
        error: `All ${data.cap} saver slots are taken right now — try again when someone stops.`,
      },
      { status: 409 },
    );
  }
  if (data?.error === "already_on_duty") {
    return NextResponse.json({ error: "You're already on duty." }, { status: 409 });
  }
  return NextResponse.json({ shift: data.shift as ShiftRow });
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
