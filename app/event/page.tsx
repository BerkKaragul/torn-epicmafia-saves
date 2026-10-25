import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { buildStatePayload } from "@/lib/state";
import { eventEnd, isEventRunning, latestEvent } from "@/lib/event";
import { DutyPanel } from "../duty/DutyPanel";
import { LiveChain } from "../LiveChain";
import { Nav } from "../Nav";
import { EventHero } from "./EventHero";
import { EventStandings } from "./EventStandings";

export const dynamic = "force-dynamic";

// The event's own page: where members enlist and save while it runs (normal
// /duty redirects here), and where its standings — then its final payout —
// stay visible once it's over.
export default async function EventPage() {
  const member = await sessionMember();
  if (!member) redirect("/login");
  const event = await latestEvent();
  if (!event) redirect("/");
  const running = isEventRunning(event);
  const initial = running ? await buildStatePayload() : null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="event" isAdmin={member.is_admin} name={member.name} />
      <EventHero
        name={event.name}
        startedAt={event.started_at}
        endsAt={eventEnd(event)}
        saveBonus={Number(event.save_bonus)}
        running={running}
      />
      {running && initial && (
        <>
          <div className="mt-6">
            <DutyPanel mode="event" />
          </div>
          <div className="mt-6">
            <LiveChain initial={initial} myId={member.torn_id} />
          </div>
        </>
      )}
      <div className="mt-6">
        <EventStandings meId={member.torn_id} isAdmin={member.is_admin} />
      </div>
    </main>
  );
}
