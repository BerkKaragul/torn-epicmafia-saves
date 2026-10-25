import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { buildStatePayload } from "@/lib/state";
import { LiveChain } from "./LiveChain";
import { HowItWorks } from "./HowItWorks";
import { WarStandings } from "./WarStandings";
import { Nav } from "./Nav";
import { EventGate } from "./EventGate";
import { runningEvent } from "@/lib/event";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const member = await sessionMember();
  if (!member) redirect("/login");
  const [initial, event] = await Promise.all([buildStatePayload(), runningEvent()]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="live" isAdmin={member.is_admin} name={member.name} />
      {/* during an event the normal how-to doesn't apply — the event page has its own */}
      {event ? <EventGate /> : <HowItWorks />}
      <LiveChain initial={initial} myId={member.torn_id} />
      <div className="mt-4">
        <WarStandings myId={member.torn_id} />
      </div>
    </main>
  );
}
