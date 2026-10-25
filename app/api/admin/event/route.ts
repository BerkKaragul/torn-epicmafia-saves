import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { forbidden, sessionMember, unauthorized } from "@/lib/session";
import { EVENT_COLS, forgetEventCache, isEventRunning, latestEvent } from "@/lib/event";

const MAX_EVENT_DAYS = 31;

function parseEnd(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

function parseBonus(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// GET → the newest event (running or not), for the admin panel
export async function GET() {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();
  const event = await latestEvent();
  return NextResponse.json({ event, running: event ? isEventRunning(event) : false });
}

// POST {name, ends_at, save_bonus} → start an event now.
//
// Every open shift from before ends, so each event shift starts inside the event and
// its accrued pay belongs to the event alone. Saving is switched on, since an
// event with saving off would pay nobody.
export async function POST(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { name?: unknown; ends_at?: unknown; save_bonus?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return NextResponse.json({ error: "Give the event a name." }, { status: 400 });
  const endsAt = parseEnd(body.ends_at);
  const now = Date.now();
  if (!endsAt || endsAt.getTime() <= now + 60_000) {
    return NextResponse.json({ error: "The end time must be in the future." }, { status: 400 });
  }
  if (endsAt.getTime() > now + MAX_EVENT_DAYS * 86_400_000) {
    return NextResponse.json(
      { error: `An event can run at most ${MAX_EVENT_DAYS} days.` },
      { status: 400 },
    );
  }
  const saveBonus = parseBonus(body.save_bonus);
  if (saveBonus === null) {
    return NextResponse.json({ error: "Invalid $ per save." }, { status: 400 });
  }

  const current = await latestEvent();
  if (current && isEventRunning(current)) {
    return NextResponse.json({ error: "An event is already running." }, { status: 409 });
  }

  const nowIso = new Date(now).toISOString();
  const { data: event, error } = await db()
    .from("chain_events")
    .insert({
      name,
      theme: "halloween",
      started_at: nowIso,
      ends_at: endsAt.toISOString(),
      save_bonus: saveBonus,
      created_by: admin.torn_id,
    })
    .select(EVENT_COLS)
    .single();
  if (error) {
    console.error("event insert failed", error);
    return NextResponse.json({ error: "Could not start the event." }, { status: 500 });
  }

  // after the insert, so a shift started in between is caught too (it has no
  // event_id); shifts started from here on carry the event's id
  const { error: endErr } = await db()
    .from("shifts")
    .update({ ended_at: nowIso, end_reason: "event_started" })
    .is("ended_at", null)
    .or(`event_id.is.null,event_id.neq.${event.id}`);
  if (endErr) console.error("ending shifts for event start failed", endErr);

  await db()
    .from("settings")
    .update({ saving_enabled: true, updated_at: nowIso })
    .eq("id", 1);
  forgetEventCache();
  return NextResponse.json({ event });
}

// PATCH {ends_at?, save_bonus?, end_now?} → adjust or end the newest event.
// The end time can only move while it's running; the per-save amount can be
// corrected until the payout is frozen.
export async function PATCH(req: Request) {
  const admin = await sessionMember();
  if (!admin) return unauthorized();
  if (!admin.is_admin) return forbidden();

  let body: { ends_at?: unknown; save_bonus?: unknown; end_now?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const event = await latestEvent();
  if (!event) return NextResponse.json({ error: "No event to change." }, { status: 404 });
  const running = isEventRunning(event);
  const patch: Record<string, string | number> = {};

  if (body.save_bonus != null) {
    if (event.payout_saved_at) {
      return NextResponse.json(
        { error: "The payout is frozen — unpublish it first to change the save amount." },
        { status: 409 },
      );
    }
    const bonus = parseBonus(body.save_bonus);
    if (bonus === null) return NextResponse.json({ error: "Invalid $ per save." }, { status: 400 });
    patch.save_bonus = bonus;
  }

  if (body.ends_at != null) {
    if (!running) {
      return NextResponse.json({ error: "The event is already over." }, { status: 409 });
    }
    const endsAt = parseEnd(body.ends_at);
    if (!endsAt || endsAt.getTime() <= Date.now() + 60_000) {
      return NextResponse.json({ error: "The end time must be in the future." }, { status: 400 });
    }
    if (endsAt.getTime() > Date.parse(event.started_at) + MAX_EVENT_DAYS * 86_400_000) {
      return NextResponse.json(
        { error: `An event can run at most ${MAX_EVENT_DAYS} days.` },
        { status: 400 },
      );
    }
    patch.ends_at = endsAt.toISOString();
  }

  const nowIso = new Date().toISOString();
  if (body.end_now === true) {
    if (!running) {
      return NextResponse.json({ error: "The event is already over." }, { status: 409 });
    }
    patch.ended_at = nowIso;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: updated, error } = await db()
    .from("chain_events")
    .update(patch)
    .eq("id", event.id)
    .select(EVENT_COLS)
    .single();
  if (error) {
    console.error("event update failed", error);
    return NextResponse.json({ error: "Could not update the event." }, { status: 500 });
  }

  if (patch.ended_at) {
    // close the event's shifts now rather than waiting for the poller
    await db()
      .from("shifts")
      .update({ ended_at: nowIso, end_reason: "event_ended" })
      .eq("event_id", event.id)
      .is("ended_at", null);
  }
  forgetEventCache();
  return NextResponse.json({ event: updated });
}
