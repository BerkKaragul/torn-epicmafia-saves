import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireMember } from "@/lib/session";

// POST { faction_id, action: "grant", days, note? } → add (or remove, with
//      negative days) subscription time by hand
// POST { faction_id, action: "suspend" | "unsuspend" }
export async function POST(req: Request) {
  const auth = await requireMember({ owner: true });
  if (auth.error) return auth.error;
  const owner = auth.ctx.member;

  let body: { faction_id?: unknown; action?: unknown; days?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const fid = Number(body.faction_id);
  if (!Number.isInteger(fid) || fid <= 0) {
    return NextResponse.json({ error: "Invalid faction id" }, { status: 400 });
  }

  if (body.action === "grant") {
    const days = Number(body.days);
    if (!Number.isFinite(days) || days === 0 || Math.abs(days) > 3650) {
      return NextResponse.json({ error: "Days must be non-zero (±3650 max)" }, { status: 400 });
    }
    const note =
      (typeof body.note === "string" && body.note.trim().slice(0, 200)) ||
      `manual ${days > 0 ? "+" : ""}${days}d by ${owner.name} [${owner.torn_id}]`;
    const { data, error } = await db().rpc("grant_time", {
      p_faction: fid,
      p_seconds: Math.round(days * 86400),
      p_note: note,
    });
    if (error) {
      console.error("grant_time failed", error);
      return NextResponse.json({ error: "Could not update the subscription" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, expires_at: data });
  }

  if (body.action === "suspend" || body.action === "unsuspend") {
    const { error } = await db()
      .from("factions")
      .update({ suspended: body.action === "suspend" })
      .eq("faction_id", fid);
    if (error) return NextResponse.json({ error: "Update failed" }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
