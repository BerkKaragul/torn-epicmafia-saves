import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { sessionContext } from "@/lib/session";
import { fmtDuration } from "@/lib/format";
import type { PaymentRow, PlatformConfigRow } from "@/lib/types";
import { Nav } from "../Nav";
import { ThemeToggle } from "../ThemeToggle";

export const dynamic = "force-dynamic";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) +
  " TCT";

// Reachable whether or not the faction has paid: this is where an expired
// faction lands, and where admins extend an active one.
export default async function SubscribePage() {
  const ctx = await sessionContext();
  if (!ctx) redirect("/login");
  const { member, faction, fid, active } = ctx;

  const [{ data: cfg }, { data: payments }] = await Promise.all([
    db()
      .from("platform_config")
      .select("xanax_per_period, period_days, trial_days, vendor_torn_id, vendor_name")
      .eq("id", 1)
      .single<Pick<PlatformConfigRow, "xanax_per_period" | "period_days" | "trial_days" | "vendor_torn_id" | "vendor_name">>(),
    member.is_admin
      ? db()
          .from("payments")
          .select("id, quantity, seconds_credited, status, received_at, sender_id")
          .eq("faction_id", fid)
          .order("received_at", { ascending: false })
          .limit(20)
          .returns<PaymentRow[]>()
      : Promise.resolve({ data: [] as PaymentRow[] }),
  ]);

  const expires = faction.subscription_expires_at;
  const leftS = expires ? Math.max(0, (Date.parse(expires) - Date.now()) / 1000) : 0;
  const billingReady = !!cfg?.xanax_per_period && !!cfg?.vendor_torn_id;

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      {active ? (
        <Nav
          current="subscribe"
          isAdmin={member.is_admin}
          isOwner={ctx.owner}
          name={member.name}
          factionName={faction.name}
          widgetToken={faction.widget_token}
        />
      ) : (
        <div className="mb-6 flex items-center justify-between border-b border-neutral-800 pb-3">
          <h1 className="text-xl font-bold">ChainWatch</h1>
          <div className="flex items-center gap-3 text-sm text-neutral-500">
            <ThemeToggle />
            {ctx.owner && (
              <Link href="/platform" className="underline">
                Platform
              </Link>
            )}
            <span>{member.name}</span>
            <form action="/api/auth/logout" method="post">
              <button className="underline hover:text-neutral-300">log out</button>
            </form>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <p className="text-sm text-neutral-500">Faction</p>
        <h2 className="text-2xl font-bold">
          {faction.name || "Your faction"}{" "}
          <span className="text-base font-normal text-neutral-500">[{fid}]</span>
        </h2>
        {faction.suspended ? (
          <p className="mt-3 font-semibold text-red-400">
            This faction&apos;s access has been suspended by the operator.
          </p>
        ) : active ? (
          <p className="mt-3 text-emerald-400">
            Active — {fmtDuration(leftS)} left (until {fmtDate(expires!)}).
          </p>
        ) : (
          <p className="mt-3 font-semibold text-amber-400">
            {expires ? `Subscription ended ${fmtDate(expires)}.` : "Not activated yet."}
          </p>
        )}
        {active && (
          <p className="mt-2 text-sm">
            <Link href="/" className="text-emerald-400 underline">
              Go to the live chain →
            </Link>
          </p>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-lg font-bold">How to {active ? "extend" : "activate"}</h2>
        {!billingReady ? (
          <p className="mt-2 text-sm text-neutral-400">
            Payments aren&apos;t open yet — contact the operator of this site.
          </p>
        ) : (
          <>
            <p className="mt-2 text-neutral-300">
              Send{" "}
              <span className="font-bold text-neutral-100">
                {cfg!.xanax_per_period} Xanax
              </span>{" "}
              to{" "}
              <a
                href={`https://www.torn.com/profiles.php?XID=${cfg!.vendor_torn_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-emerald-400 underline"
              >
                {cfg!.vendor_name ?? "the operator"} [{cfg!.vendor_torn_id}]
              </a>{" "}
              for <span className="font-bold text-neutral-100">{cfg!.period_days} days</span>.
            </p>
            <ul className="mt-3 list-disc pl-5 text-sm text-neutral-400">
              <li>
                Any member of the faction can send it; it credits the <em>sender&apos;s</em> faction
                automatically, usually within a couple of minutes.
              </li>
              <li>
                Paying for a faction you&apos;re not in (e.g. from an alt)? Put{" "}
                <code className="rounded bg-neutral-800 px-1">CW {fid}</code> in the item message.
              </li>
              <li>
                Partial amounts count proportionally, and time stacks on top of any time you
                still have left.
              </li>
            </ul>
          </>
        )}
        {!member.is_admin && !active && (
          <p className="mt-3 text-xs text-neutral-500">
            Let your faction leadership know — once the faction is active, this page will take you
            straight to the app.
          </p>
        )}
      </section>

      {member.is_admin && (payments ?? []).length > 0 && (
        <section className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h2 className="text-lg font-bold">Payments received</h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 font-medium">When</th>
                <th className="py-1 font-medium">From</th>
                <th className="py-1 text-right font-medium">Xanax</th>
                <th className="py-1 text-right font-medium">Credited</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((p) => (
                <tr key={p.id} className="border-t border-neutral-800">
                  <td className="py-1.5">{fmtDate(p.received_at)}</td>
                  <td className="py-1.5">{p.sender_id ? `[${p.sender_id}]` : "operator"}</td>
                  <td className="py-1.5 text-right tabular-nums">{p.quantity}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {p.seconds_credited > 0 ? fmtDuration(p.seconds_credited) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
