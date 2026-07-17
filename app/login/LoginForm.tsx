"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CREATE_KEY_URL =
  "https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=ChainWatch&type=3";

export function LoginForm() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Login failed");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="text-sm font-medium text-neutral-300" htmlFor="apiKey">
        Torn API key
      </label>
      <input
        id="apiKey"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="16-character key"
        autoComplete="off"
        spellCheck={false}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-neutral-100 outline-none focus:border-emerald-500"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={busy || apiKey.trim().length < 16}
        className="rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Checking with Torn…" : "Log in"}
      </button>
      <p className="text-xs text-neutral-500">
        Don’t have a Limited key?{" "}
        <a className="underline hover:text-neutral-300" href={CREATE_KEY_URL} target="_blank" rel="noreferrer">
          Create one here
        </a>{" "}
        — Torn pre-fills it named “ChainWatch”.
      </p>
    </form>
  );
}
