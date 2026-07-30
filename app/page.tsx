import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { buildStatePayload } from "@/lib/state";
import { LiveChain } from "./LiveChain";
import { HowItWorks } from "./HowItWorks";
import { Nav } from "./Nav";

export const dynamic = "force-dynamic";

export default async function LivePage() {
  const member = await sessionMember();
  if (!member) redirect("/login");
  const initial = await buildStatePayload();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="live" isAdmin={member.is_admin} name={member.name} />
      <HowItWorks />
      <LiveChain initial={initial} myId={member.torn_id} />
    </main>
  );
}
