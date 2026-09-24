import { navProps, pageContext } from "@/lib/pageGuard";
import { DutyPanel } from "./DutyPanel";
import { Nav } from "../Nav";

export default async function DutyPage() {
  const ctx = await pageContext();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <Nav current="duty" {...navProps(ctx)} />
      <DutyPanel />
    </main>
  );
}
