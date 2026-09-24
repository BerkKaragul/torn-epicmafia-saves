import { redirect } from "next/navigation";
import { sessionContext, type SessionContext } from "@/lib/session";

/**
 * Server-page guard: logged in, faction subscription active (otherwise the
 * subscribe page), and optionally a faction admin.
 */
export async function pageContext(opts: { admin?: boolean } = {}): Promise<SessionContext> {
  const ctx = await sessionContext();
  if (!ctx) redirect("/login");
  if (!ctx.active) redirect("/subscribe");
  if (opts.admin && !ctx.member.is_admin) redirect("/");
  return ctx;
}

/** Props every page hands to <Nav>. */
export function navProps(ctx: SessionContext) {
  return {
    isAdmin: ctx.member.is_admin,
    isOwner: ctx.owner,
    name: ctx.member.name,
    factionName: ctx.faction.name,
    widgetToken: ctx.faction.widget_token,
  };
}
