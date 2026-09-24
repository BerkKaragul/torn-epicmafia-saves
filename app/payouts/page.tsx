import { navProps, pageContext } from "@/lib/pageGuard";
import { PayoutsArchive } from "./PayoutsArchive";
import { Nav } from "../Nav";

// Open to every signed-in member, not just admins: these are the finalised
// numbers for wars that are already over, and everyone deserves to check their
// own line without asking a leader for a screenshot.
export default async function PayoutsPage() {
  const ctx = await pageContext();
  const { member } = ctx;

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Nav current="payouts" {...navProps(ctx)} />
      <PayoutsArchive meId={member.torn_id} isAdmin={member.is_admin} />
    </main>
  );
}
