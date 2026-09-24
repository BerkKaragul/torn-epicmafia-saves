import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session";

// JSON for fetch() callers; a plain HTML form post (the subscribe page, which
// has no client JS) gets sent back to the login page instead.
export async function POST(req: Request) {
  await clearSessionCookie();
  if ((req.headers.get("content-type") ?? "").includes("form")) {
    return NextResponse.redirect(new URL("/login", req.url), 303);
  }
  return NextResponse.json({ ok: true });
}
