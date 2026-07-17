import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { DutyPanel } from "./DutyPanel";
import { Nav } from "../Nav";

export default async function DutyPage() {
  const member = await sessionMember();
  if (!member) redirect("/login");

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="duty" isAdmin={member.is_admin} name={member.name} />
      <DutyPanel />
    </main>
  );
}
