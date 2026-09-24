"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtDuration } from "@/lib/format";
import type { PaymentRow, PlatformConfigRow } from "@/lib/types";

interface FactionItem {
  faction_id: number;
  name: string;
  tag: string | null;
  created_at: string;
  subscription_expires_at: string | null;
  trial_granted_at: string | null;
  suspended: boolean;
  members: number;
  last_poll_at: string | null;
  poll_errors: number;
}

interface Preview {
  receive_log_type_ids: number[];
  receipts: {
    logId: string;
    receivedAt: number;
    senderId: number | null;
    quantity: number;
    message: string | null;
    targetFactionId: number | null;
  }[];
  raw: unknown[];
}

const fmtDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" })
    : "—";

const input =
  "w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 outline-none focus:border-emerald-500";
const button =
  "rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40";
const card = "rounded-xl border border-neutral-800 bg-neutral-900 p-5";

export function PlatformPanel() {
  const [cfg, setCfg] = useState<PlatformConfigRow | null>(null);
  const [factions, setFactions] = useState<FactionItem[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [vendorKey, setVendorKey] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState({ faction_id: "", days: "" });
  const [assign, setAssign] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/platform");
    const j = await res.json();
    if (!res.ok) return setMsg(j.error ?? "Could not load");
    setCfg(j.config);
    setFactions(j.factions);
    setPayments(j.payments);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) {
        setMsg(j.error ?? "Failed");
        return null;
      }
      await load();
      return j;
    } finally {
      setBusy(false);
    }
  }

  async function savePricing(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    const j = await call("/api/platform", "PATCH", {
      xanax_per_period: cfg.xanax_per_period ?? null,
      period_days: cfg.period_days,
      trial_days: cfg.trial_days,
      xanax_item_id: cfg.xanax_item_id,
    });
    if (j) setMsg("Pricing saved.");
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    const j = await call("/api/platform/vendor-key", "POST", { apiKey: vendorKey });
    if (j) {
      setVendorKey("");
      setPreview(j.preview);
      setMsg(`Vendor key saved for ${j.vendor.name} [${j.vendor.id}].`);
    }
  }

  async function testKey() {
    const j = await call("/api/platform/vendor-key", "GET");
    if (j) setPreview(j.preview);
  }

  const now = Date.now();
  const activeCount = factions.filter(
    (f) => !f.suspended && f.subscription_expires_at && Date.parse(f.subscription_expires_at) > now,
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {msg && (
        <p className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm">{msg}</p>
      )}

      <section className={card}>
        <h2 className="font-bold">Overview</h2>
        <p className="mt-1 text-sm text-neutral-400">
          {factions.length} faction(s) registered · {activeCount} active · last billing sweep{" "}
          {fmtDate(cfg?.last_billing_sweep_at ?? null)} TCT
          {cfg?.last_billing_error && (
            <span className="text-red-400"> · last error: {cfg.last_billing_error}</span>
          )}
        </p>
      </section>

      <section className={card}>
        <h2 className="font-bold">Pricing</h2>
        {cfg && (
          <form onSubmit={savePricing} className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Xanax per period</span>
              <input
                className={input}
                type="number"
                min={1}
                value={cfg.xanax_per_period ?? ""}
                placeholder="off"
                onChange={(e) =>
                  setCfg({ ...cfg, xanax_per_period: e.target.value ? Number(e.target.value) : null })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Period (days)</span>
              <input
                className={input}
                type="number"
                min={1}
                value={cfg.period_days}
                onChange={(e) => setCfg({ ...cfg, period_days: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Free trial (days)</span>
              <input
                className={input}
                type="number"
                min={0}
                value={cfg.trial_days}
                onChange={(e) => setCfg({ ...cfg, trial_days: Number(e.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-400">Item id (Xanax = 206)</span>
              <input
                className={input}
                type="number"
                min={1}
                value={cfg.xanax_item_id}
                onChange={(e) => setCfg({ ...cfg, xanax_item_id: Number(e.target.value) })}
              />
            </label>
            <div className="col-span-full">
              <button className={button} disabled={busy}>
                Save pricing
              </button>
              <span className="ml-3 text-xs text-neutral-500">
                Leaving the price empty pauses automatic crediting.
              </span>
            </div>
          </form>
        )}
      </section>

      <section className={card}>
        <h2 className="font-bold">Vendor account</h2>
        <p className="mt-1 text-sm text-neutral-400">
          {cfg?.vendor_torn_id ? (
            <>
              Payments go to{" "}
              <span className="font-semibold text-neutral-200">
                {cfg.vendor_name} [{cfg.vendor_torn_id}]
              </span>{" "}
              · key {cfg.vendor_key_valid ? "OK" : <span className="text-red-400">INVALID</span>} · log
              types {cfg.receive_log_type_ids?.join(", ") || "not resolved yet"}
            </>
          ) : (
            "No vendor key yet — factions can't pay until you add one."
          )}
        </p>
        <form onSubmit={saveKey} className="mt-3 flex gap-2">
          <input
            className={input}
            type="password"
            placeholder="Full Access API key of the account that receives Xanax"
            value={vendorKey}
            onChange={(e) => setVendorKey(e.target.value)}
            autoComplete="off"
          />
          <button className={button} disabled={busy || vendorKey.trim().length !== 16}>
            Save
          </button>
          {cfg?.vendor_torn_id && (
            <button type="button" onClick={testKey} className={button} disabled={busy}>
              Test
            </button>
          )}
        </form>
        {preview && (
          <div className="mt-3 text-sm">
            <p className="text-neutral-400">
              Recent Xanax receipts as the billing sweep would read them (nothing recorded):
            </p>
            {preview.receipts.length === 0 ? (
              <p className="mt-1 text-neutral-500">
                None in the latest item-receive logs. Send yourself a Xanax from an alt to check, then
                press Test.
              </p>
            ) : (
              <ul className="mt-1 list-disc pl-5">
                {preview.receipts.map((r) => (
                  <li key={r.logId}>
                    {new Date(r.receivedAt * 1000).toISOString().slice(0, 16)} · {r.quantity} from [
                    {r.senderId ?? "?"}]
                    {r.targetFactionId ? ` → faction ${r.targetFactionId}` : ""}
                    {r.message ? ` · “${r.message}”` : ""}
                  </li>
                ))}
              </ul>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-neutral-500">Raw log entries</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-neutral-950 p-2 text-xs">
                {JSON.stringify(preview.raw, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </section>

      <section className={card}>
        <h2 className="font-bold">Factions</h2>
        <form
          className="mt-3 flex flex-wrap items-end gap-2 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            const j = await call("/api/platform/factions", "POST", {
              faction_id: Number(grant.faction_id),
              action: "grant",
              days: Number(grant.days),
            });
            if (j) setMsg(`Faction ${grant.faction_id} now runs until ${fmtDate(j.expires_at)} TCT.`);
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Faction id</span>
            <input
              className={input}
              value={grant.faction_id}
              onChange={(e) => setGrant({ ...grant, faction_id: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-400">Days (negative removes)</span>
            <input
              className={input}
              type="number"
              value={grant.days}
              onChange={(e) => setGrant({ ...grant, days: e.target.value })}
            />
          </label>
          <button className={button} disabled={busy || !grant.faction_id || !Number(grant.days)}>
            Grant time
          </button>
        </form>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 font-medium">Faction</th>
                <th className="py-1 font-medium">Members</th>
                <th className="py-1 font-medium">Paid until (TCT)</th>
                <th className="py-1 font-medium">Last poll</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {factions.map((f) => {
                const left = f.subscription_expires_at
                  ? (Date.parse(f.subscription_expires_at) - now) / 1000
                  : 0;
                return (
                  <tr key={f.faction_id} className="border-t border-neutral-800">
                    <td className="py-1.5">
                      {f.name || "?"} <span className="text-neutral-500">[{f.faction_id}]</span>
                      {f.suspended && <span className="ml-1 text-red-400">suspended</span>}
                    </td>
                    <td className="py-1.5 tabular-nums">{f.members}</td>
                    <td className={`py-1.5 ${left > 0 ? "text-emerald-400" : "text-neutral-500"}`}>
                      {fmtDate(f.subscription_expires_at)}
                      {left > 0 && <span className="text-neutral-500"> ({fmtDuration(left)})</span>}
                    </td>
                    <td className="py-1.5 text-neutral-400">
                      {fmtDate(f.last_poll_at)}
                      {f.poll_errors > 0 && <span className="text-red-400"> · {f.poll_errors} err</span>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        className="text-xs underline text-neutral-400 hover:text-neutral-200"
                        disabled={busy}
                        onClick={() =>
                          call("/api/platform/factions", "POST", {
                            faction_id: f.faction_id,
                            action: f.suspended ? "unsuspend" : "suspend",
                          })
                        }
                      >
                        {f.suspended ? "unsuspend" : "suspend"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className={card}>
        <h2 className="font-bold">Payments</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1 font-medium">When (TCT)</th>
                <th className="py-1 font-medium">Sender</th>
                <th className="py-1 font-medium">Faction</th>
                <th className="py-1 text-right font-medium">Xanax</th>
                <th className="py-1 text-right font-medium">Credited</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-neutral-800 align-top">
                  <td className="py-1.5">{fmtDate(p.received_at)}</td>
                  <td className="py-1.5">{p.sender_id ? `[${p.sender_id}]` : p.source}</td>
                  <td className="py-1.5">{p.faction_id ?? "—"}</td>
                  <td className="py-1.5 text-right tabular-nums">{p.quantity}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {p.seconds_credited ? fmtDuration(Math.abs(p.seconds_credited)) : "—"}
                    {p.seconds_credited < 0 ? " removed" : ""}
                  </td>
                  <td className="py-1.5">
                    {p.status}
                    {p.note && <div className="text-xs text-neutral-500">{p.note}</div>}
                    {p.status !== "applied" && (
                      <div className="mt-1 flex gap-1">
                        <input
                          className={`${input} w-28 text-xs`}
                          placeholder="faction id"
                          value={assign[p.id] ?? ""}
                          onChange={(e) => setAssign({ ...assign, [p.id]: e.target.value })}
                        />
                        <button
                          className="text-xs underline"
                          disabled={busy || !assign[p.id]}
                          onClick={() =>
                            call("/api/platform/payments", "POST", {
                              payment_id: p.id,
                              faction_id: Number(assign[p.id]),
                            })
                          }
                        >
                          credit
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
