import { redirect } from "next/navigation";
import { sessionContext } from "@/lib/session";
import { Nav } from "../Nav";
import { PlatformPanel } from "./PlatformPanel";

export const dynamic = "force-dynamic";

// The operator's page: every faction, every payment, pricing and the vendor
// key. Only Torn ids listed in PLATFORM_OWNER_IDS get here.
export default async function PlatformPage() {
  const ctx = await sessionContext();
  if (!ctx) redirect("/login");
  if (!ctx.owner) redirect("/");

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Nav
        current="platform"
        isAdmin={ctx.active && ctx.member.is_admin}
        isOwner
        name={ctx.member.name}
        factionName={ctx.faction.name}
        widgetToken={ctx.active ? ctx.faction.widget_token : undefined}
      />
      <PlatformPanel />
    </main>
  );
}
