"use client";

import { useCallback, useEffect, useState } from "react";

interface Settings {
  hourly_rate: number;
  per_save_bonus: number;
  save_threshold_s: number;
  alert_threshold_s: number;
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

export function AdminPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [saves, setSaves] = useState<AdminSave[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [attrTarget, setAttrTarget] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [s, m, sv] = await Promise.all([
      fetch("/api/admin/settings").then((r) => r.json()),
      fetch("/api/admin/members").then((r) => r.json()),
      fetch("/api/admin/saves").then((r) => r.json()),
    ]);
    if (s.settings) setSettings(s.settings);
    if (m.members) setMembers(m.members);
    if (sv.saves) setSaves(sv.saves);
  }, []);

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
      {msg && <p className="text-sm text-amber-300">{msg}</p>}

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
        </div>
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
    </div>
  );
}
