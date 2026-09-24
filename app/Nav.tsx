"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

export function Nav({
  current,
  isAdmin,
  isOwner = false,
  name,
  factionName,
  widgetToken,
}: {
  current: "live" | "duty" | "admin" | "war-payout" | "payouts" | "subscribe" | "platform";
  isAdmin: boolean;
  isOwner?: boolean;
  name: string;
  factionName?: string;
  widgetToken?: string;
}) {
  const router = useRouter();
  const tab = (key: string, href: string, label: string) => (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
        current === key
          ? "bg-neutral-800 text-neutral-50"
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
    <nav className="mb-6 flex flex-wrap items-center gap-1 border-b border-neutral-800 pb-3">
      {tab("live", "/", "Live chain")}
      {tab("duty", "/duty", "My duty")}
      {isAdmin && tab("admin", "/admin", "Admin")}
      {isAdmin && tab("war-payout", "/admin/war-payout", "War pay")}
      {tab("payouts", "/payouts", "Payouts")}
      {isAdmin && tab("subscribe", "/subscribe", "Subscription")}
      {isOwner && tab("platform", "/platform", "Platform")}
      <div className="ml-auto flex items-center gap-3 text-sm text-neutral-500">
        <ThemeToggle />
        {widgetToken && (
          <a
            href={`/widget/${widgetToken}/chainwatch.user.js`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
            title="Show the saver inside Torn (needs Tampermonkey) — this copy is set up for your faction"
          >
            🧩 Widget
          </a>
        )}
        <span title={factionName}>{name}</span>
        <button onClick={logout} className="text-neutral-500 underline hover:text-neutral-300">
          log out
        </button>
      </div>
    </nav>
  );
}
