import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { SchedulePanel } from "./SchedulePanel";
import { Nav } from "../Nav";

export default async function SchedulePage() {
  const member = await sessionMember();
  if (!member) redirect("/login");

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Nav current="schedule" isAdmin={member.is_admin} name={member.name} />
      <SchedulePanel myId={member.torn_id} />
    </main>
  );
}
