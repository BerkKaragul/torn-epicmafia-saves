import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptKey } from "@/lib/crypto";
import { sessionMember, unauthorized } from "@/lib/session";
import { tornClient } from "@/lib/torn";
import { canEnlistFromStatus } from "@/supabase/functions/_shared/logic/travel";
import { rotationOrder } from "@/supabase/functions/_shared/logic/rotation";
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

  // You can only enlist while you can actually go on to save: already abroad, or
  // flying OUT to another country. Not from Torn (nothing to save at home) and
  // not on the way back (you're done). Checked live against Torn with your key.
  try {
    if (!member.api_key_ct || !member.api_key_iv) throw new Error("no key on file");
    const key = await decryptKey(member.api_key_ct, member.api_key_iv);
    const profile = await tornClient(key).userBasic();
    if (!canEnlistFromStatus(profile.status?.state ?? "Okay", profile.status?.description)) {
      return NextResponse.json(
        {
          error:
            "You can only go on duty while abroad or flying to another country — not from Torn or on the way back.",
        },
        { status: 409 },
      );
    }
  } catch (e) {
    console.error("enlist status check failed", e);
    return NextResponse.json(
      { error: "Couldn't check your travel status just now — try again in a moment." },
      { status: 503 },
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
  if (data?.error === "disabled") {
    return NextResponse.json(
      { error: "Saving is switched off by the admins right now." },
      { status: 409 },
    );
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

export async function PATCH(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();

  let message: string | null = null;
  try {
    const body = await req.json();
    if (typeof body.message === "string") {
      message = body.message.replace(/\s+/g, " ").trim().slice(0, 200) || null;
    }
  } catch {
    /* no body = silent stop */
  }

  // was this member the rotation head at the moment they bailed?
  const { data: active } = await db()
    .from("shifts")
    .select("member_id, started_at, last_save_at, deprioritized_at")
    .is("ended_at", null);
  const order = rotationOrder(
    (active ?? []).map((s) => ({
      memberId: s.member_id,
      startedAt: Math.floor(Date.parse(s.started_at) / 1000),
      lastSaveAt: s.last_save_at ? Math.floor(Date.parse(s.last_save_at) / 1000) : null,
      deprioritizedAt: s.deprioritized_at ? Math.floor(Date.parse(s.deprioritized_at) / 1000) : null,
    })),
  );
  const wasHead = order[0] === member.torn_id;
  const othersRemain = (active ?? []).some((s) => s.member_id !== member.torn_id);

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

  // the poller broadcasts this to the remaining savers within ~15s
  if (othersRemain && (message || wasHead)) {
    await db().from("announcements").insert({
      member_id: member.torn_id,
      message,
      was_head: wasHead,
    });
  }
  return NextResponse.json({ shift });
}
