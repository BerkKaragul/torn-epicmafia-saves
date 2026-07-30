"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtMoney } from "@/lib/format";

interface Settings {
  saving_enabled: boolean;
  widget_token: string;
  hourly_rate: number;
  per_save_bonus: number;
  save_bonus_mode: "flat" | "scaled";
  save_threshold_s: number;
  alert_threshold_s: number;
  saver_cap: number;
  poller_member_id: number | null;
}

interface AdminMember {
  torn_id: number;
  name: string;
  key_access_level: string | null;
  key_valid: boolean;
  is_admin: boolean;
  admin_source: "auto" | "granted" | null;
  last_login_at: string | null;
  on_duty: boolean;
  missed_turns: number;
}

interface AdminSave {
  id: string;
  chain_count: number;
  status: string;
  remaining_at_hit_s: number | null;
  detected_at: string;
  note: string | null;
  members: { name: string } | null;
}

interface Balance {
  member_id: number;
  name: string;
  duty_seconds: number;
  duty_amount: number;
  save_count: number;
  saves_amount: number;
  adjustments_amount: number;
  total_amount: number;
}

export function AdminPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [saves, setSaves] = useState<AdminSave[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [attrTarget, setAttrTarget] = useState<Record<string, string>>({});
  const [adjFor, setAdjFor] = useState<number | null>(null);
  const [adjAmount, setAdjAmount] = useState("");
  const [adjNote, setAdjNote] = useState("");
  // in-app confirmation — native confirm() gets silently disabled once a
  // browser shows its "prevent this page from prompting" checkbox, which dead-
  // ended the wipe / mark-paid buttons for an admin
  const [confirmBox, setConfirmBox] = useState<{
    title: string;
    body: string;
    danger: boolean;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const load = useCallback(async () => {
    const [s, m, sv, b] = await Promise.all([
      fetch("/api/admin/settings").then((r) => r.json()),
      fetch("/api/admin/members").then((r) => r.json()),
      fetch("/api/admin/saves").then((r) => r.json()),
      fetch("/api/admin/balances").then((r) => r.json()),
    ]);
    if (s.settings) setSettings(s.settings);
    if (m.members) setMembers(m.members);
    if (sv.saves) setSaves(sv.saves);
    if (b.balances) setBalances(b.balances);
  }, []);

  function settle(memberId: number, name: string, paid: boolean, total: number) {
    setConfirmBox({
      title: paid ? `Mark ${name} paid?` : `Wipe ${name}'s balance?`,
      body: paid
        ? `This zeroes ${name}'s ${fmtMoney(total)} balance and records it as paid. Only do this after you've actually sent the money in Torn.`
        : `This clears ${name}'s ${fmtMoney(total)} balance WITHOUT paying it. This can't be undone.`,
      danger: !paid,
      confirmLabel: paid ? "Yes, mark paid" : "Yes, wipe it",
      onConfirm: async () => {
        setMsg(null);
        const res = await fetch("/api/admin/balances", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ member_id: memberId, paid }),
        });
        const body = await res.json();
        setMsg(
          res.ok
            ? `${name}: ${fmtMoney(body.settled)} ${paid ? "marked paid" : "written off"}.`
            : body.error,
        );
        await load();
      },
    });
  }

  async function submitAdjustment(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await fetch("/api/admin/balances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member_id: adjFor,
        amount: Number(adjAmount),
        note: adjNote,
      }),
    });
    const body = await res.json();
    if (!res.ok) setMsg(body.error);
    setAdjFor(null);
    setAdjAmount("");
    setAdjNote("");
    await load();
  }

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setMsg(null);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    const body = await res.json();
    setMsg(res.ok ? "Settings saved ✔" : body.error);
    if (res.ok) setSettings(body.settings);
  }

  async function memberAction(tornId: number, action: { is_admin?: boolean; end_shift?: boolean }) {
    setMsg(null);
    const res = await fetch("/api/admin/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ torn_id: tornId, ...action }),
    });
    if (!res.ok) setMsg((await res.json()).error);
    await load();
  }

  async function attribute(saveId: string) {
    const memberId = Number(attrTarget[saveId]);
    if (!memberId) return;
    const res = await fetch("/api/admin/saves", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ save_id: saveId, member_id: memberId }),
    });
    if (!res.ok) setMsg((await res.json()).error);
    await load();
  }

  if (!settings) return <p className="text-neutral-500">Loading…</p>;

  const num = (v: string) => (v === "" ? 0 : Number(v));
  const needsAttention = saves.filter((s) => s.status === "unattributed" || s.status === "pending");

  return (
    <div className="flex flex-col gap-6">
      {confirmBox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setConfirmBox(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={`text-lg font-bold ${confirmBox.danger ? "text-red-300" : ""}`}>
              {confirmBox.title}
            </h3>
            <p className="mt-2 text-sm text-neutral-400">{confirmBox.body}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmBox(null)}
                className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const action = confirmBox.onConfirm;
                  setConfirmBox(null);
                  await action();
                }}
                className={`rounded-md px-4 py-2 text-sm font-bold text-white ${
                  confirmBox.danger
                    ? "bg-red-700 hover:bg-red-600"
                    : "bg-emerald-600 hover:bg-emerald-500"
                }`}
              >
                {confirmBox.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && <p className="text-sm text-amber-300">{msg}</p>}

      <section
        className={`rounded-xl border p-5 ${
          settings.saving_enabled
            ? "border-emerald-800 bg-emerald-950/30"
            : "border-red-800 bg-red-950/40"
        }`}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <h2 className="font-bold">
              {settings.saving_enabled ? "Saving is ON" : "Saving is OFF"}
            </h2>
            <p className="mt-1 text-xs text-neutral-400">
              {settings.saving_enabled
                ? "Members can enlist as savers and availability pay is accruing."
                : "Nobody can enlist and no pay accrues. Turn it on when you're chaining again."}
            </p>
          </div>
          <button
            onClick={() => {
              const next = !settings.saving_enabled;
              const apply = async () => {
                setMsg(null);
                const res = await fetch("/api/admin/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ saving_enabled: next }),
                });
                const body = await res.json();
                if (!res.ok) setMsg(body.error);
                await load();
              };
              if (next) return apply(); // turning ON needs no confirmation
              setConfirmBox({
                title: "Turn saving OFF?",
                body: "This ends everyone's active shift immediately and stops all pay until you turn it back on.",
                danger: true,
                confirmLabel: "Yes, turn it off",
                onConfirm: apply,
              });
            }}
            className={`ml-auto rounded-md px-5 py-2.5 font-bold text-white transition ${
              settings.saving_enabled
                ? "bg-red-700 hover:bg-red-600"
                : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {settings.saving_enabled ? "Turn saving OFF" : "Turn saving ON"}
          </button>
        </div>
      </section>

      <form
        onSubmit={saveSettings}
        className="rounded-xl border border-neutral-800 bg-neutral-900 p-5"
      >
        <h2 className="font-bold">Pay & detection settings</h2>
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <label className="text-sm">
            <span className="text-neutral-400">$/hour on duty</span>
            <input
              type="number"
              min={0}
              value={settings.hourly_rate}
              onChange={(e) => setSettings({ ...settings, hourly_rate: num(e.target.value) })}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">$ per save</span>
            <input
              type="number"
              min={0}
              value={settings.per_save_bonus}
              onChange={(e) => setSettings({ ...settings, per_save_bonus: num(e.target.value) })}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Save if ≤ (s left)</span>
            <input
              type="number"
              min={10}
              max={290}
              value={settings.save_threshold_s}
              onChange={(e) => setSettings({ ...settings, save_threshold_s: num(e.target.value) })}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Alert below (s)</span>
            <input
              type="number"
              min={15}
              max={290}
              value={settings.alert_threshold_s}
              onChange={(e) => setSettings({ ...settings, alert_threshold_s: num(e.target.value) })}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Saver cap (0 = no limit)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={settings.saver_cap}
              onChange={(e) => setSettings({ ...settings, saver_cap: num(e.target.value) })}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            />
          </label>
          <label className="text-sm">
            <span className="text-neutral-400">Save bonus mode</span>
            <select
              value={settings.save_bonus_mode}
              onChange={(e) =>
                setSettings({ ...settings, save_bonus_mode: e.target.value as "flat" | "scaled" })
              }
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5"
            >
              <option value="flat">Flat — every save pays the base</option>
              <option value="scaled">Scaled — base × (chain ÷ 100)</option>
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Scaled mode: saving a 1,200-chain pays 12× the base; anything at or below 100 pays the
          base. Applies to saves confirmed from now on — already-earned bonuses never change.
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          The cap limits how many savers can be on duty at once. Lowering it never kicks anyone
          already enlisted — it only blocks new starts (use &ldquo;end shift&rdquo; below to
          remove someone).
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Rates are snapshotted when shifts start / saves confirm — changing them never rewrites
          history. Poller key:{" "}
          {settings.poller_member_id
            ? (members.find((m) => m.torn_id === settings.poller_member_id)?.name ??
              settings.poller_member_id)
            : "first login"}
        </p>
        <button
          type="submit"
          className="mt-3 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          Save settings
        </button>
      </form>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-bold">Balances owed</h2>
          <span className="text-sm text-neutral-500">
            {fmtMoney(balances.reduce((sum, b) => sum + Number(b.total_amount), 0))} outstanding
            across {balances.filter((b) => Number(b.total_amount) !== 0).length} member(s)
          </span>
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Live totals — duty pay accrues every 15s while a chain is live. Pay people in Torn
          first, then hit “paid” to zero their balance here. Balances keep counting even while
          someone is still on duty.
        </p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1.5 pr-3">Member</th>
                <th className="py-1.5 pr-3">Duty</th>
                <th className="py-1.5 pr-3">Saves</th>
                <th className="py-1.5 pr-3">Adjust</th>
                <th className="py-1.5 pr-3">Owed</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {balances
                .filter((b) => Number(b.total_amount) !== 0 || b.save_count > 0)
                .map((b) => (
                  <tr key={b.member_id} className="border-t border-neutral-800">
                    <td className="py-2 pr-3 font-medium">{b.name}</td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">
                      {fmtMoney(b.duty_amount)}
                      <span className="ml-1 text-xs text-neutral-600">
                        ({(b.duty_seconds / 3600).toFixed(1)}h)
                      </span>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-neutral-400">
                      {fmtMoney(b.saves_amount)}
                      <span className="ml-1 text-xs text-neutral-600">({b.save_count})</span>
                    </td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${
                        Number(b.adjustments_amount) < 0
                          ? "text-red-400"
                          : Number(b.adjustments_amount) > 0
                            ? "text-emerald-400"
                            : "text-neutral-600"
                      }`}
                    >
                      {Number(b.adjustments_amount) !== 0
                        ? fmtMoney(b.adjustments_amount)
                        : "—"}
                    </td>
                    <td className="py-2 pr-3 font-bold tabular-nums">
                      {fmtMoney(b.total_amount)}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          onClick={() => setAdjFor(adjFor === b.member_id ? null : b.member_id)}
                          className="rounded bg-neutral-800 px-2 py-0.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-700"
                        >
                          ± adjust
                        </button>
                        <button
                          onClick={() =>
                            settle(b.member_id, b.name, true, Number(b.total_amount))
                          }
                          className="rounded bg-emerald-800 px-2 py-0.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-700"
                        >
                          mark paid
                        </button>
                        <button
                          onClick={() =>
                            settle(b.member_id, b.name, false, Number(b.total_amount))
                          }
                          className="rounded bg-red-900/70 px-2 py-0.5 text-xs font-semibold text-red-300 hover:bg-red-900"
                        >
                          wipe
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {adjFor !== null && (
          <form
            onSubmit={submitAdjustment}
            className="mt-4 rounded-lg border border-neutral-700 bg-neutral-950 p-3"
          >
            <p className="text-sm font-medium">
              Adjust balance for{" "}
              {balances.find((b) => b.member_id === adjFor)?.name ??
                members.find((m) => m.torn_id === adjFor)?.name}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="number"
                value={adjAmount}
                onChange={(e) => setAdjAmount(e.target.value)}
                placeholder="e.g. 5000000 or -2000000"
                className="w-56 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
              />
              <input
                value={adjNote}
                onChange={(e) => setAdjNote(e.target.value)}
                maxLength={200}
                placeholder="reason (shown in the payout record)"
                className="min-w-[16rem] flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={!adjAmount || Number(adjAmount) === 0}
                className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => setAdjFor(null)}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800"
              >
                Cancel
              </button>
            </div>
            <p className="mt-1.5 text-xs text-neutral-500">
              Positive adds money to what they&apos;re owed, negative takes it away.
            </p>
          </form>
        )}
      </section>

      {needsAttention.length > 0 && (
        <section className="rounded-xl border border-amber-800 bg-amber-950/30 p-5">
          <h2 className="font-bold text-amber-300">Saves needing attention</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Detected low-timer resets that no on-duty saver's attack log matched. If you know who
            saved, attribute it manually (pays the current bonus).
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {needsAttention.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
              >
                <span>
                  Hit #{s.chain_count.toLocaleString()} · {s.status} ·{" "}
                  {new Date(s.detected_at).toLocaleString()}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <select
                    value={attrTarget[s.id] ?? ""}
                    onChange={(e) => setAttrTarget({ ...attrTarget, [s.id]: e.target.value })}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1"
                  >
                    <option value="">attribute to…</option>
                    {members.map((m) => (
                      <option key={m.torn_id} value={m.torn_id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => attribute(s.id)}
                    className="rounded-md bg-amber-700 px-2.5 py-1 font-semibold text-white hover:bg-amber-600"
                  >
                    Confirm
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">Registered members ({members.length})</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Faction leaders are admins automatically and can&apos;t be revoked. A &ldquo;grant
          admin&rdquo; button appears next to every regular member once they&apos;ve logged in.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1.5 pr-3">Member</th>
                <th className="py-1.5 pr-3">Key</th>
                <th className="py-1.5 pr-3">Status</th>
                <th className="py-1.5 pr-3">Missed</th>
                <th className="py-1.5 pr-3">Admin</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.torn_id} className="border-t border-neutral-800">
                  <td className="py-2 pr-3 font-medium">
                    {m.name} <span className="text-neutral-600">[{m.torn_id}]</span>
                  </td>
                  <td className="py-2 pr-3">
                    {m.key_valid ? (
                      <span className="text-emerald-400">{m.key_access_level ?? "ok"}</span>
                    ) : (
                      <span className="text-red-400">invalid</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {m.on_duty ? (
                      <span className="text-emerald-400">on duty</span>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                  <td
                    className={`py-2 pr-3 tabular-nums ${m.missed_turns > 0 ? "font-semibold text-red-400" : "text-neutral-600"}`}
                    title="chains lost while it was their turn"
                  >
                    {m.missed_turns}
                  </td>
                  <td className="py-2 pr-3">
                    {m.admin_source === "auto" ? (
                      <span className="text-sky-400">leader — auto admin</span>
                    ) : (
                      <button
                        onClick={() => memberAction(m.torn_id, { is_admin: !m.is_admin })}
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          m.is_admin
                            ? "bg-sky-900 text-sky-300 hover:bg-sky-800"
                            : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                        }`}
                      >
                        {m.is_admin ? "admin ✔ (revoke)" : "grant admin"}
                      </button>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {m.on_duty && (
                      <button
                        onClick={() => memberAction(m.torn_id, { end_shift: true })}
                        className="rounded bg-red-900/60 px-2 py-0.5 text-xs font-semibold text-red-300 hover:bg-red-900"
                      >
                        end shift
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
        <h2 className="font-bold">Torn browser widget (Tampermonkey)</h2>
        <p className="mt-1 text-xs text-neutral-500">
          A small script that shows the current &amp; next saver right inside torn.com. Share the
          steps below with the faction. Everyone uses the same token.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-neutral-400">Token:</span>
          <code className="rounded bg-neutral-950 px-2 py-1 font-mono text-sm text-emerald-300">
            {settings.widget_token}
          </code>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(settings.widget_token);
              setMsg("Token copied.");
            }}
            className="rounded bg-neutral-800 px-2 py-1 text-xs font-semibold text-neutral-300 hover:bg-neutral-700"
          >
            copy
          </button>
        </div>

        <ol className="mt-3 flex list-decimal flex-col gap-1 pl-5 text-sm text-neutral-300">
          <li>
            Install the free{" "}
            <a
              href="https://www.tampermonkey.net/"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 underline"
            >
              Tampermonkey
            </a>{" "}
            browser extension.
          </li>
          <li>
            Click{" "}
            <a
              href="/chainwatch.user.js"
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 underline"
            >
              install the ChainWatch widget
            </a>{" "}
            — Tampermonkey opens an install page; hit <span className="font-medium">Install</span>.
          </li>
          <li>Open torn.com. It asks for the token once — paste the one above.</li>
          <li>Drag the little box under your chain timer. Done.</li>
        </ol>
        <p className="mt-2 text-xs text-neutral-600">
          To change the token later: Tampermonkey menu → “Set ChainWatch token”.
        </p>
      </section>
    </div>
  );
}
