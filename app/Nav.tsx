"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";
import { useActiveEvent } from "./EventContext";

export function Nav({
  current,
  isAdmin,
  name,
}: {
  current: "live" | "duty" | "event" | "admin" | "war-payout" | "payouts";
  isAdmin: boolean;
  name: string;
}) {
  const router = useRouter();
  // during an event, saving happens on the event page — it replaces "My duty"
  const event = useActiveEvent();
  const tab = (key: string, href: string, label: string, accent = false) => (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        current === key
          ? accent
            ? "bg-orange-600 text-white"
            : "bg-neutral-800 text-neutral-50"
          : accent
            ? "text-orange-300 hover:bg-orange-950/60 hover:text-orange-200"
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
      {event ? tab("event", "/event", "🎃 Event", true) : tab("duty", "/duty", "My duty")}
      {isAdmin && tab("admin", "/admin", "Admin")}
      {isAdmin && tab("war-payout", "/admin/war-payout", "War pay")}
      {tab("payouts", "/payouts", "Payouts")}
      <div className="ml-auto flex items-center gap-3 text-sm text-neutral-500">
        <ThemeToggle />
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
