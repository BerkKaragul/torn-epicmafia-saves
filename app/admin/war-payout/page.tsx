import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { WarPayoutPanel } from "./WarPayoutPanel";
import { Nav } from "../../Nav";

export default async function WarPayoutPage() {
  const member = await sessionMember();
  if (!member) redirect("/login");
  if (!member.is_admin) redirect("/");

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Nav current="war-payout" isAdmin name={member.name} />
      <WarPayoutPanel />
    </main>
  );
}
