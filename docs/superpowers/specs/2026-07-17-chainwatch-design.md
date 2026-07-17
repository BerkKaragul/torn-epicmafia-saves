# ChainWatch — Torn Faction Chain-Saver Tracker — Design

**Date:** 2026-07-17 · **Status:** Approved by Berk [4305342] · **Faction:** EPIC Mafia [40959]

## Problem

The faction pays for attacks, assists, retaliations, and chain saves. Saves (a member attacks any target when the chain timer runs low, often "holding" the attack result page for up to 30 extra seconds) are done ad-hoc. The faction wants to additionally pay members for *availability*: enlisting as a saver for a period ("I can save for 3h") should pay, and simultaneous savers should take turns in a fair rotation.

## What we're building

A web app where faction members:

1. **Log in with their personal Torn API key** (Limited access minimum). The app verifies faction membership via the Torn API, stores the key encrypted, and uses it to read the member's own attack log.
2. **Start/stop saver duty shifts** at any moment, optionally with a planned duration. Time on duty pays an hourly rate.
3. **Get saves detected automatically.** A background poller watches `faction/chain`; a hit that lands when the timer is ≤ threshold (default 90s, configurable) is a save. It is attributed to the exact member via the `chain` hit-counter in on-duty savers' own attack logs, with precise seconds-remaining computed (holds that register after visual zero still count).
4. **Rotate turns automatically.** On-duty savers form a derived queue: order by `max(shift_start, last_save_at)` ascending — newcomers join at the back, performing a save sends you to the back, the head of the queue is "up". No stored pointer to corrupt.
5. **Get alerted.** Web Push (VAPID) to the turn-holder ("YOUR TURN — SAVE NOW") and other on-duty savers when the timer drops below the alert threshold. Live chain page with extrapolated countdown, red flash + sound. Discord webhook is a designed-in later add.
6. **Payouts tracked, not sent.** Admins (leader + co-leader auto-detected; grantable to others) set hourly rate + per-save bonus, generate per-member payout reports (hours, saves, total), mark lines paid, export CSV. Rates are snapshotted onto shifts/saves so mid-period changes never corrupt history.

## Stack (user-chosen: free & easy)

- **Vercel Hobby**: Next.js (App Router, TypeScript) — UI + API routes. No polling here (Hobby cron is 1/day).
- **Supabase Free**: Postgres (service-role only, RLS locked), **pg_cron every 15s → pg_net → `poller` Edge Function** (responds 202 immediately, work in `EdgeRuntime.waitUntil`), Realtime broadcast for live chain state, Web Push from the Edge Function via `@negrel/webpush`.
- Browser never touches Postgres; anon key used only for the Realtime channel subscription.

## Verified facts the design rests on

- `/v2/faction/chain`, `/v2/faction/basic`, `/v2/faction/members` work with any plain member key. **`/v2/faction/attacks` is NOT available** (no faction API access) — design does not depend on it.
- `/v2/user/attacks` (Limited key) returns both incoming and outgoing attacks with `started`/`ended`, `result`, `chain` (chain count at that hit), `respect_gain`, pagination via `from`/`sort`/`limit`. Attribution filters `attacker.id === member`.
- Membership check = call `/v2/faction/basic` with *their* key, compare `basic.id` to configured faction id. Also yields `leader_id`/`co_leader_id` for auto-admin.
- Torn rate limit: 100 req/min **per user**. Budget: poller key ≤6/min; each saver's key 1–2/min during active chains only.
- Idle chain state: `{id:0, current:0, timeout:0, cooldown:0, max:10}`; `cooldown>0` = milestone cooldown. Timer values are always *observed* from the API (never assumed), so milestone-dependent timer rules can't break detection.
- Supabase sub-minute cron verified in docs (Postgres 15.1.1.61+); day-1 spike on the real project + fallback (1-min cron, in-function 3×20s loop) planned. Free-tier pause risk mitigated by poller gateway traffic + Vercel daily keepalive cron.

## Key decisions

| Decision | Choice |
|---|---|
| Pay model | Hourly rate + per-save bonus, both admin-configurable, snapshotted at shift-start/save-confirm |
| Saves by non-enlisted members | Recorded as `unattributed`; pay nobody; rotation does **not** advance; turn-holder gets a "scooped" notification; admin can manually attribute |
| Simultaneous savers | Distinct hits have distinct chain counts; only the low-timer hit is the save candidate |
| Key storage | AES-256-GCM at rest, env-held key, never redisplayed (last 4 chars only), auto-quarantine on Torn auth errors (ends shift) |
| Admins | leader/co-leader auto (non-revocable) + grantable; admin checks hit the DB every request |
| Sessions | httpOnly signed JWT cookie (jose), 30d |
| Alerts | Web Push now; `notify.ts` dispatch abstraction so Discord drops in later |
| Testing | Pure-function chain state machine + rotation (Vitest, table-driven); Torn API simulator via `TORN_API_BASE` override; shadow-mode week before money attaches to detection |

## Build phases

0. Scaffold + git; day-1 pg_cron 15s spike when Supabase project exists
1. Auth (login/session/encryption/membership/auto-admin)
2. Shifts + /duty + minimal admin rates → **usable MVP timesheet**
3. Poller: chain polling, state machine, Realtime, live `/` page (watch-only calibration)
4. Save detection + attribution + rotation
5. Web Push + danger UI/sound
6. Payout periods/lines/mark-paid/CSV
7. Hardening: keepalive, pruning, PWA manifest, Discord stub, docs

## Top risks

1. pg_cron sub-minute regression → day-1 spike + in-function loop fallback
2. Free-tier pause → gateway traffic + daily keepalive + unpause runbook
3. Attack-log lag vs. detection windows → +60s slack, ~5min retries, `unattributed` escape hatch, raw poll history kept 7d for disputes
4. Key security → encryption, service-role-only RLS, Limited keys have no money/trade powers
5. Realtime quota → broadcast on change only + client-side extrapolation
