import { db } from "@/lib/db";
import { USERSCRIPT_TEMPLATE } from "@/lib/userscript";

// Serves the Tampermonkey widget pre-configured for one faction. The URL ends
// in .user.js so Tampermonkey offers to install it, and the same URL is the
// script's @updateURL, so installs pick up new versions automatically.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{32}$/.test(token)) return new Response("not found", { status: 404 });

  const { data: faction } = await db()
    .from("factions")
    .select("faction_id")
    .eq("widget_token", token)
    .maybeSingle();
  if (!faction) return new Response("not found", { status: 404 });

  const origin = new URL(req.url).origin;
  const script = USERSCRIPT_TEMPLATE.replaceAll("__SITE__", origin)
    .replaceAll("__HOST__", new URL(origin).host)
    .replaceAll("__TOKEN__", token)
    .replaceAll("__INSTALL_URL__", `${origin}/widget/${token}/chainwatch.user.js`);

  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
