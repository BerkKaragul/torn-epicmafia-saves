import { navProps, pageContext } from "@/lib/pageGuard";
import { AdminPanel } from "./AdminPanel";
import { Nav } from "../Nav";

export default async function AdminPage() {
  const ctx = await pageContext({ admin: true });

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Nav current="admin" {...navProps(ctx)} />
      <AdminPanel />
    </main>
  );
}
