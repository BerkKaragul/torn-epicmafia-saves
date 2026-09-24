import { navProps, pageContext } from "@/lib/pageGuard";
import { buildStatePayload } from "@/lib/state";
import { LiveChain } from "./LiveChain";
import { HowItWorks } from "./HowItWorks";
import { WarStandings } from "./WarStandings";
import { Nav } from "./Nav";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const ctx = await pageContext();
  const { member } = ctx;
  const initial = await buildStatePayload(ctx.faction);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="live" {...navProps(ctx)} />
      <HowItWorks />
      <LiveChain initial={initial} myId={member.torn_id} />
      <div className="mt-4">
        <WarStandings myId={member.torn_id} />
      </div>
    </main>
  );
}
