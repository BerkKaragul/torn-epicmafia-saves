-- Faster poll cadence: 15s -> 10s so a landed save/hit reaches savers sooner.
-- This matters most in war: the danger siren must stop promptly once someone
-- saves, and a slower cadence leaves it wailing after the hit already landed.
-- Reschedule the existing pg_cron job in place and tighten the active poll
-- interval; cycle.ts's busy floor is lowered to 10s to match.
--
-- Sub-minute schedule needs pg_cron >= 1.5 (same requirement as migration 0002).
-- Day-1 check after applying: confirm rows appear in cron.job_run_details every
-- ~10s, and that the poller function logs show a fresh poll on that cadence.

select cron.unschedule('chainwatch-poller');

select cron.schedule(
  'chainwatch-poller',
  '10 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'poller_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-poller-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'poller_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Active cadence used by the busy path, which now floors at max(10, this). Leave
-- any admin-set value that's already tighter than 10s untouched.
update settings set poll_interval_s = 10 where id = 1 and poll_interval_s > 10;
