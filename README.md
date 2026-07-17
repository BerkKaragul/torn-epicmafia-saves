# ChainWatch

Chain-saver duty tracker for the Torn faction **EPIC Mafia [40959]**.

Members enlist as chain savers ("I can save for 3h"), the app tracks their paid
availability time, watches the faction chain via the Torn API every ~15s,
**automatically detects and credits chain saves** (who hit, at how many seconds
remaining — holds included), rotates turns between simultaneous savers, sends
push notifications ("🚨 YOUR TURN — SAVE NOW"), and generates payout reports
for the bankers.

## Stack (free tier)

| Piece | Where | Why |
|---|---|---|
| Next.js web app + API | Vercel Hobby | UI, auth, shifts, admin, payouts |
| Postgres | Supabase Free | all data; RLS locked to service-role |
| Chain poller | Supabase Edge Function `poller` | pg_cron (every 15s) → pg_net → function |
| Live updates | Supabase Realtime broadcast | countdown page without polling |
| Alerts | Web Push (VAPID) | works with the site closed |

Members log in with a **Limited** Torn API key (never full). Keys are stored
AES-256-GCM encrypted; every API call the app makes carries the comment
`ChainWatch`, so key owners can audit usage in their own Torn key log.

## How save detection works

1. The poller reads `/v2/faction/chain` (with a unique `timestamp` param each
   call — Torn caches identical requests for ~30s and this is the documented
   bypass).
2. The chain timer falls exactly 1s/s between hits. If, extrapolating from the
   last observation, the timer would have dipped to ≤ the save threshold
   (default 90s) by the time a new hit appeared, that hit is a **save
   candidate**.
3. The poller then reads the attack logs of the on-duty savers (each with
   their own key) and matches the hit by its exact `chain` counter value.
   From the attack's real `ended` timestamp it computes the true seconds
   remaining — a held attack that registered "after zero" still counts.
4. No match after ~3 minutes → the save is recorded as done by a non-enlisted
   member (pays nobody, rotation doesn't advance); admins can attribute it
   manually.

Detection observes actual API values, so warm-up chains, milestone cooldowns
and future timer changes don't break it.

## Local development

```bash
npm install
npm test          # 29 unit tests: state machine, rotation, crypto
cp .env.example .env.local   # fill in values (see below)
npm run dev
```

## Deployment (one-time, ~30 minutes)

### 1. Supabase

1. Create a project at [database.new](https://database.new) (free tier, any region close to you).
2. In the repo:
   ```bash
   npx supabase login
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase db push          # applies migrations (schema + cron jobs)
   ```
3. Generate secrets:
   ```bash
   openssl rand -base64 32       # → API_KEY_ENC_KEY
   openssl rand -base64 32       # → POLLER_SECRET
   node scripts/generate-vapid.mjs   # prints VAPID_KEYS and NEXT_PUBLIC_VAPID_PUBLIC_KEY
   ```
4. Set the Edge Function secrets (VAPID_KEYS is the JSON JWK pair from the
   script — the Edge Function reads VAPID_KEYS, not VAPID_PRIVATE_KEY):
   ```bash
   npx supabase secrets set POLLER_SECRET=... API_KEY_ENC_KEY=... VAPID_SUBJECT=mailto:you@example.com
   npx supabase secrets set VAPID_KEYS='{"publicKey":{...},"privateKey":{...}}'
   ```
5. Deploy the poller (it authenticates with its own secret, not a JWT):
   ```bash
   npx supabase functions deploy poller --no-verify-jwt
   ```
6. In the Supabase SQL editor, point the cron at your function:
   ```sql
   select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1/poller', 'poller_url');
   select vault.create_secret('<POLLER_SECRET value>', 'poller_secret');
   ```
7. **Day-1 spike — verify the 15s schedule actually runs** (sub-minute cron
   needs Supabase's current pg_cron; all new projects have it):
   ```sql
   select jobname, status, start_time
   from cron.job_run_details
   order by start_time desc limit 10;
   ```
   Rows should appear ~15s apart with `status = succeeded`. If sub-minute
   scheduling is rejected on your project, fall back to a 1-minute schedule
   where the function loops internally:
   ```sql
   select cron.unschedule('chainwatch-poller');
   -- then re-add with schedule '* * * * *' (and ask the poller to loop —
   -- see supabase/migrations/0002_cron.sql comments)
   ```

### 2. Vercel

1. Push this repo to GitHub, then import it at [vercel.com/new](https://vercel.com/new).
2. Set environment variables (Project → Settings → Environment Variables):
   - `NEXT_PUBLIC_SUPABASE_URL` — from Supabase → Settings → API
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same page
   - `SUPABASE_SERVICE_ROLE_KEY` — same page (keep secret!)
   - `API_KEY_ENC_KEY` — same value as the Supabase secret
   - `SESSION_SECRET` — `openssl rand -base64 32`
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — from the generate-vapid script

   (The faction id lives in the database: `settings.faction_id`, seeded to
   40959. To track a different faction, update that row in the SQL editor.)
3. Deploy. The daily `/api/keepalive` cron (vercel.json) plus the poller's
   own traffic keep the Supabase free project from pausing.

### 3. First login & smoke test

1. Open the site, log in with your own key → you become the default poller key.
2. The faction leader/co-leader get admin automatically on their first login;
   they (or you, once granted) set the hourly rate and per-save bonus in Admin.
3. **Live test without a war:** any successful attack starts a 10-chain. Have
   2–3 members enlist on `/duty`, land ~5 hits, then *deliberately wait* until
   the timer is under 90s and have one enlisted member hit (bonus points for
   holding the result screen). Within a minute the save should appear
   confirmed with the seconds-remaining, the rotation should advance, and the
   turn-holder should have received a push.

## Operations

- **Poller health**: the live page shows a warning banner if the poller hasn't
  reported for 90s. Check `cron.job_run_details` and the function logs.
- **Pruning**: nightly cron deletes chain observations >7 days and
  notification logs >30 days.
- **Free-tier pause**: if Supabase emails a pause warning, click "keep active"
  — the keepalive should normally prevent it.
- **Key hygiene**: members can rotate their Torn key any time and just log in
  again; invalid keys auto-quarantine and end the member's shift.

## Repo map

```
app/                    Next.js pages + API routes
lib/                    server glue (db, session, crypto, torn, state)
supabase/functions/
  _shared/logic/        PURE chain state machine + rotation (unit-tested)
  _shared/lib/          torn client + crypto (runs in Node AND Deno)
  poller/               the 15s poll cycle (detection, attribution, alerts)
supabase/migrations/    schema + cron schedules
tests/                  Vitest suites for the correctness core
docs/superpowers/specs/ the approved design document
```
