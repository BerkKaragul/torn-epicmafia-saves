import { NextResponse } from "next/server";
import { sessionMember, unauthorized } from "@/lib/session";
import { buildStatePayload } from "@/lib/state";

export const dynamic = "force-dynamic";

export async function GET() {
  const member = await sessionMember();
  if (!member) return unauthorized();
  return NextResponse.json(await buildStatePayload());
}
