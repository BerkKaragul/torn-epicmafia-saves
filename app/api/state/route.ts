import { NextResponse } from "next/server";
import { requireMember } from "@/lib/session";
import { buildStatePayload } from "@/lib/state";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireMember();
  if (auth.error) return auth.error;
  return NextResponse.json(await buildStatePayload(auth.ctx.faction));
}
