import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sessionMember, unauthorized } from "@/lib/session";

export async function POST(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();

  let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    sub = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }

  const { error } = await db()
    .from("push_subscriptions")
    .upsert(
      {
        member_id: member.torn_id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: req.headers.get("user-agent"),
        disabled: false,
        failed_count: 0,
      },
      { onConflict: "endpoint" },
    );
  if (error) {
    console.error("push subscribe failed", error);
    return NextResponse.json({ error: "Could not save subscription" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const member = await sessionMember();
  if (!member) return unauthorized();
  let endpoint: string | undefined;
  try {
    ({ endpoint } = await req.json());
  } catch {
    /* fall through */
  }
  if (!endpoint) return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  await db()
    .from("push_subscriptions")
    .delete()
    .eq("member_id", member.torn_id)
    .eq("endpoint", endpoint);
  return NextResponse.json({ ok: true });
}
