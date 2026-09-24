import { redirect } from "next/navigation";
import { sessionMember } from "@/lib/session";
import { LoginForm } from "./LoginForm";
import { ThemeToggle } from "../ThemeToggle";

export default async function LoginPage() {
  const member = await sessionMember();
  if (member) redirect("/");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight">ChainWatch</h1>
          <p className="mt-1 text-neutral-400">
            Chain saver duty tracker for Torn factions
          </p>
        </div>
        <ThemeToggle />
      </div>

      <LoginForm />

      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-sm">
        <p className="mb-2 font-semibold text-neutral-200">Your API key — what we do with it</p>
        <table className="w-full text-left text-neutral-400">
          <tbody>
            <tr className="border-t border-neutral-800">
              <th className="py-1.5 pr-3 font-medium text-neutral-300">Access level</th>
              <td>Limited (or a custom key with the “attacks” selection)</td>
            </tr>
            <tr className="border-t border-neutral-800">
              <th className="py-1.5 pr-3 font-medium text-neutral-300">Purpose of use</th>
              <td>Identify you and your faction, read your faction&apos;s chain, and read your own attacks to credit your chain saves</td>
            </tr>
            <tr className="border-t border-neutral-800">
              <th className="py-1.5 pr-3 font-medium text-neutral-300">Key storage</th>
              <td>Stored server-side, encrypted (AES-256-GCM); never shown to anyone, including you, after login</td>
            </tr>
            <tr className="border-t border-neutral-800">
              <th className="py-1.5 pr-3 font-medium text-neutral-300">Data storage</th>
              <td>Persistent — until you log in with a new key or ask the operator to delete your account</td>
            </tr>
            <tr className="border-t border-neutral-800">
              <th className="py-1.5 pr-3 font-medium text-neutral-300">Data sharing</th>
              <td>Duty hours, saves and payouts are visible to your own faction only; nothing is shared with other factions or third parties</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-neutral-500">
          Every request this site makes shows up in your own{" "}
          <a
            className="underline hover:text-neutral-300"
            href="https://www.torn.com/preferences.php#tab=api"
            target="_blank"
            rel="noreferrer"
          >
            key usage log
          </a>{" "}
          with the comment “ChainWatch”, so you can audit it any time.
        </p>
      </div>
    </main>
  );
}
