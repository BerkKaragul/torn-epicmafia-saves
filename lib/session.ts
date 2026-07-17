import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { MemberRow } from "@/lib/types";

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
    const { payload } = await jwtVerify(jwt, secret());
    return payload.sub ? Number(payload.sub) : null;
  } catch {
    return null;
  }
}

/** Loads the logged-in member fresh from the DB (admin revocation is instant). */
export async function sessionMember(): Promise<MemberRow | null> {
  const tornId = await sessionTornId();
  if (!tornId) return null;
  const { data } = await db()
    .from("members")
    .select("*")
    .eq("torn_id", tornId)
    .maybeSingle<MemberRow>();
  return data ?? null;
}

export function unauthorized(msg = "Not logged in") {
  return NextResponse.json({ error: msg }, { status: 401 });
}

export function forbidden(msg = "Admins only") {
  return NextResponse.json({ error: msg }, { status: 403 });
}
