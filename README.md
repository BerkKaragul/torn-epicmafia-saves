# ChainWatch

Chain-saver duty tracker for Torn factions, run as one hosted service that
**any number of factions** can subscribe to.

Faction members enlist as chain savers ("I can save for 3h"). The app:

- watches each faction's chain through the Torn API every ~10s
- **detects saves automatically and credits them**: who hit, and with how many
  seconds left. Held attacks count.
- rotates turns between savers who are on duty at the same time
- sends push notifications ("🚨 YOUR TURN — SAVE NOW")
- tracks availability pay and builds war payout reports for the bankers

Factions pay for access **in-game**. They send Xanax to the operator's Torn
account, and the subscription extends on its own within about a minute.

## How multi-faction works

- **Tenants.** Every table carries a `faction_id`. Each API route and poller
  query is scoped to the logged-in member's faction.
- **Sign-up.** There isn't one. The first login from a new faction registers
  it. Leaders and co-leaders become admins automatically.
- **Poller.** One cron job (every 10s) runs a cycle for each faction whose
  subscription is active. Each faction has its own cadence, overlap lock and
  poller key (a member of that faction). The poller always calls
  `/faction/{id}/…` with an explicit id, so a member who has changed faction
  can never feed their new faction's chain into the old one.
- **Live updates.** Each faction gets its own unguessable Realtime channel and
  its own widget token.
- **Inactive factions.** A faction without an active subscription is not
  polled. Its members land on `/subscribe`, and any open saver shifts are
  ended.

## Billing (Xanax → subscription time)

1. As the operator, open **/platform**, set the price (e.g. *10 Xanax per 15
   days*), and optionally set a free trial length.
2. Paste the **Full Access API key** of the account that receives payments
   (reading logs needs Full Access). The app:
   - finds the "item receive" log types through `/torn/logtypes`
   - shows a dry-run preview of recent Xanax receipts and the raw log entries
3. Every minute the poller reads new item-receive logs. For each Xanax receipt
   it credits this faction:
   - the one named in the item message (`CW 12345`), if there is one
   - otherwise the sender's current faction

   Time is proportional (half the price buys half the days) and stacks on
   top of any remaining time.
4. On /platform you can also:
   - credit unmatched payments (a sender with no faction) by hand
   - grant or remove days
   - suspend a faction

> **Verify on day 1.** Torn documents the log `data` payload only as
> "dynamic key-value pairs". The parser
> (`supabase/functions/_shared/logic/billing.ts`) accepts the item layouts
> we expect, but it has not been checked against a live log yet. After saving
> the vendor key, send one Xanax from an alt and press **Test** on /platform.
> The receipt should appear with the right sender and quantity. If it doesn't,
> the raw entry shown there tells you what to adjust. Until then, manual
> "Grant time" always works.

## Stack (free tier friendly)

| Piece | Where | Why |
|---|---|---|
| Next.js web app + API | Vercel | UI, auth, shifts, admin, payouts, platform |
| Postgres | Supabase | all data; RLS locked to service-role |
| Chain poller + billing | Supabase Edge Function `poller` | pg_cron (every 10s) → pg_net → function |
| Live updates | Supabase Realtime broadcast | one private-by-obscurity channel per faction |
| Alerts | Web Push (VAPID) | works with the site closed |

Members log in with a **Limited** Torn API key, never a Full one. Keys are
stored encrypted with AES-256-GCM. Every API call carries the comment
`ChainWatch`, so key owners can audit usage in their own Torn key log.

## How save detection works

1. The poller reads `/v2/faction/{id}/chain`. Each call adds a unique
   `timestamp` param, because Torn caches identical requests for ~30s.
2. Between hits, the chain timer falls exactly 1s per second. The poller
   extrapolates from the last observation. If the timer would have dipped to
   the save threshold or below before a new hit appeared, that hit becomes a
   **save candidate**.
3. The poller then reads the attack log of the saver whose turn it was, using
   their own key, and matches the hit by its `chain` counter. The attack's
   real timestamps give the true seconds remaining, so a held attack still
   counts.
4. If there's no match after a few minutes, the save is marked unattributed.
   Admins can attribute it by hand.

## Local development

```bash
npm install
npm test                      # unit tests: detection, rotation, pay, billing, crypto
cp .env.example .env.local    # fill in values (see below)
npm run dev
```

## Deployment (one-time)

### 1. Supabase

1. Create a project at [database.new](https://database.new).
2. Apply the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push          # schema + cron jobs
   ```
3. Generate secrets:
   ```bash
   openssl rand -base64 32       # → API_KEY_ENC_KEY
   openssl rand -base64 32       # → POLLER_SECRET
   node scripts/generate-vapid.mjs   # prints VAPID_KEYS and NEXT_PUBLIC_VAPID_PUBLIC_KEY
   ```
4. Set the Edge Function secrets:
   ```bash
   npx supabase secrets set POLLER_SECRET=... API_KEY_ENC_KEY=... VAPID_SUBJECT=mailto:you@example.com
   npx supabase secrets set VAPID_KEYS='{"publicKey":{...},"privateKey":{...}}'
   ```
5. Deploy the poller. It authenticates with its own secret, not a JWT:
   ```bash
   npx supabase functions deploy poller --no-verify-jwt
   ```
6. Point the cron at the function. Run this in the SQL editor:
   ```sql
   select setup_poller_config(
     'https://<PROJECT_REF>.supabase.co/functions/v1/poller',
     '<POLLER_SECRET value>'
   );
   ```
7. Check that the cron is firing:
   ```sql
   select poller_health();
   ```

### 2. Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Set these environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`: from Supabase → Settings → API
   - `API_KEY_ENC_KEY`: the **same** value as the Supabase secret
   - `SESSION_SECRET`: `openssl rand -base64 32`
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`: from the generate-vapid script
   - `PLATFORM_OWNER_IDS`: your Torn id (comma-separate several)
3. Deploy. The daily `/api/keepalive` cron keeps a free Supabase project from
   pausing.

### 3. First run

1. Log in with your own Limited key. That registers your own faction.
2. Open **/platform**:
   - set the price
   - paste the vendor Full Access key
   - press **Test**
3. Give your own faction time with **Grant time**, or send yourself a Xanax
   from an alt to test the whole payment path.
4. Tell other factions about it. They log in, see `/subscribe` with the price
   and your profile link, pay, and they're live.

## Operations

- **Poller health.** Each faction's live page shows a warning if its poller
  hasn't reported for 90s. /platform lists the last poll and error count for
  every faction.
- **Billing health.** /platform shows the last billing sweep and its last
  error.
- **Pruning.** A nightly cron deletes chain observations older than 7 days and
  notification logs older than 30 days.
- **Key hygiene.** Members can rotate their key and log in again. Invalid keys
  are quarantined automatically, and the member's shift ends.
- **Torn API ToS.** The login page shows the key-use disclosure table (access
  level, purpose, storage, sharing). Keep it accurate if you change what the
  app reads.

## Repo map

```
app/                    Next.js pages + API routes
  platform/             operator page (factions, payments, pricing, vendor key)
  subscribe/            a faction's subscription status + how to pay
  widget/[token]/       per-faction Tampermonkey widget installer
lib/                    server glue (db, session, crypto, torn, state)
supabase/functions/
  _shared/logic/        PURE logic: detection, rotation, pay, billing (unit-tested)
  _shared/lib/          torn client + crypto (runs in Node AND Deno)
  poller/               per-faction poll cycle + billing sweep
supabase/migrations/    schema + cron schedules
tests/                  Vitest suites
```
