import { navProps, pageContext } from "@/lib/pageGuard";
import { WarPayoutPanel } from "./WarPayoutPanel";
import { Nav } from "../../Nav";

export default async function WarPayoutPage() {
  const ctx = await pageContext({ admin: true });

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <Nav current="war-payout" {...navProps(ctx)} />
      <WarPayoutPanel />
    </main>
  );
}
