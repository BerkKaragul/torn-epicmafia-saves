import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";

const DAY = 24 * 60 * 60 * 1000;

// GET → all slots in the visible window (2 days back … 31 days ahead)
export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();

  const from = new Date(Date.now() - 2 * DAY).toISOString();
  const to = new Date(Date.now() + 31 * DAY).toISOString();

  const { data, error } = await db()
    .from("availability_slots")
    .select("id, member_id, start_at, end_at, members!inner(name)")
    .gte("end_at", from)
    .lte("start_at", to)
    .order("start_at");
  if (error) {
    console.error("availability list failed", error);
    return NextResponse.json({ error: "Could not load the schedule" }, { status: 500 });
  }

  type Row = {
    id: string;
    member_id: number;
    start_at: string;
    end_at: string;
    members: { name: string } | { name: string }[];
  };
  const slots = ((data ?? []) as Row[]).map((s) => ({
    id: s.id,
    member_id: s.member_id,
    name: Array.isArray(s.members) ? s.members[0]?.name : s.members.name,
    start_at: s.start_at,
    end_at: s.end_at,
    mine: s.member_id === member.torn_id,
  }));
  return NextResponse.json({ slots, my_id: member.torn_id });
}

// POST { start_at, end_at } (ISO) → add one of my availability slots
export async function POST(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();

  let body: { start_at?: string; end_at?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const start = body.start_at ? new Date(body.start_at) : null;
  const end = body.end_at ? new Date(body.end_at) : null;
  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
    return NextResponse.json({ error: "Invalid times" }, { status: 400 });
  }
  if (end <= start) {
    return NextResponse.json({ error: "End time must be after the start." }, { status: 400 });
  }
  if (end.getTime() - start.getTime() > DAY) {
    return NextResponse.json({ error: "A single slot can't be longer than 24h." }, { status: 400 });
  }
  if (start.getTime() > Date.now() + 40 * DAY || end.getTime() < Date.now() - 3 * DAY) {
    return NextResponse.json({ error: "Pick a time within the next month." }, { status: 400 });
  }

  const { error } = await db().from("availability_slots").insert({
    member_id: member.torn_id,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
  });
  if (error) {
    console.error("availability insert failed", error);
    return NextResponse.json({ error: "Could not save that slot" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

// DELETE { id } → remove one of my own slots
export async function DELETE(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  let id: string | undefined;
  try {
    ({ id } = await req.json());
  } catch {
    /* fall through */
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  await db()
    .from("availability_slots")
    .delete()
    .eq("id", id)
    .eq("member_id", member.torn_id);
  return NextResponse.json({ ok: true });
}
