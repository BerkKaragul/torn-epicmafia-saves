import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscriptionActive } from "@/supabase/functions/_shared/logic/billing";
import type { FactionRow, MemberRow } from "@/lib/types";

const COOKIE_NAME = "cw_session";
const SESSION_DAYS = 30;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function createSessionCookie(tornId: number): Promise<void> {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(tornId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  (await cookies()).set(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

export async function sessionTornId(): Promise<number | null> {
  const jwt = (await cookies()).get(COOKIE_NAME)?.value;
  if (!jwt) return null;
  try {
    const { payload } = await jwtVerify(jwt, secret(), { algorithms: ["HS256"] });
    return payload.sub ? Number(payload.sub) : null;
  } catch {
    return null;
  }
}

/**
 * The deployment operator(s): Torn ids in PLATFORM_OWNER_IDS (comma separated).
 * They see the /platform page (factions, payments, pricing, vendor key).
 */
export function isPlatformOwner(tornId: number): boolean {
  return (process.env.PLATFORM_OWNER_IDS ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .some((id) => id > 0 && id === tornId);
}

export interface SessionContext {
  member: MemberRow;
  faction: FactionRow;
  /** shorthand for member.faction_id — the tenant every query is scoped to */
  fid: number;
  /** the faction's subscription is paid up (and it isn't suspended) */
  active: boolean;
  owner: boolean;
}

/** Loads the logged-in member and their faction fresh from the DB. */
export async function sessionContext(): Promise<SessionContext | null> {
  const tornId = await sessionTornId();
  if (!tornId) return null;
  const { data } = await db()
    .from("members")
    .select("*, factions!inner(*)")
    .eq("torn_id", tornId)
    .maybeSingle<MemberRow & { factions: FactionRow }>();
  if (!data) return null;
  const { factions: faction, ...member } = data;
  return {
    member: member as MemberRow,
    faction,
    fid: member.faction_id,
    active: subscriptionActive(faction),
    owner: isPlatformOwner(member.torn_id),
  };
}

/** Just the member (null when logged out). */
export async function sessionMember(): Promise<MemberRow | null> {
  return (await sessionContext())?.member ?? null;
}

export function unauthorized(msg = "Not logged in") {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export function forbidden(msg = "Admins only") {
  return NextResponse.json({ error: msg }, { status: 403 });
}

export function paymentRequired() {
  return NextResponse.json(
    { error: "Your faction's ChainWatch subscription is not active.", subscription: "inactive" },
    { status: 402 },
  );
}

/**
 * Guard for API routes. By default the member's faction must have an active
 * subscription; `admin` additionally requires faction admin rights, `owner`
 * requires the platform operator (and skips the subscription check).
 */
export async function requireMember(
  opts: { admin?: boolean; owner?: boolean; allowInactive?: boolean } = {},
): Promise<{ ctx: SessionContext; error?: undefined } | { ctx?: undefined; error: NextResponse }> {
  const ctx = await sessionContext();
  if (!ctx) return { error: unauthorized() };
  if (opts.owner) {
    return ctx.owner ? { ctx } : { error: forbidden("Platform owner only") };
  }
  if (!ctx.active && !opts.allowInactive) return { error: paymentRequired() };
  if (opts.admin && !ctx.member.is_admin) return { error: forbidden() };
  return { ctx };
}
