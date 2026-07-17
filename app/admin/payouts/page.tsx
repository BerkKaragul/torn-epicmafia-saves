import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { PayoutsPanel } from "./PayoutsPanel";
import { Nav } from "../../Nav";

export default async function PayoutsPage() {
  const member = await sessionMember();
  if (!member) redirect("/login");
  if (!member.is_admin) redirect("/");

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Nav current="payouts" isAdmin name={member.name} />
      <PayoutsPanel />
    </main>
  );
}
