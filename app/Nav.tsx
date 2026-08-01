"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function Nav({
  current,
  isAdmin,
  name,
}: {
  current: "live" | "duty" | "schedule" | "admin" | "war-payout" | "payouts";
  isAdmin: boolean;
  name: string;
}) {
  const router = useRouter();
  const tab = (key: string, href: string, label: string) => (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        current === key
          ? "bg-neutral-800 text-white"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      }`}
    >
      {label}
    </Link>
  );

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <nav className="mb-6 flex items-center gap-1 border-b border-neutral-800 pb-3">
      {tab("live", "/", "Live chain")}
      {tab("duty", "/duty", "My duty")}
      {tab("schedule", "/schedule", "Schedule")}
      {isAdmin && tab("admin", "/admin", "Admin")}
      {isAdmin && tab("war-payout", "/admin/war-payout", "War pay")}
      {isAdmin && tab("payouts", "/admin/payouts", "Payouts")}
      <div className="ml-auto flex items-center gap-3 text-sm text-neutral-500">
        <a
          href="https://greasyfork.org/en/scripts/589168-chainwatch-saver-widget"
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
          title="Show the saver inside Torn (needs Tampermonkey)"
        >
          🧩 Widget
        </a>
        <span>{name}</span>
        <button onClick={logout} className="text-neutral-500 underline hover:text-neutral-300">
          log out
        </button>
      </div>
    </nav>
  );
}
