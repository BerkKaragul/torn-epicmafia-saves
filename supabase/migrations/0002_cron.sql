-- Scheduling: pg_cron fires the poller Edge Function via pg_net every 15s.
-- The function URL and shared secret live in Supabase Vault so this migration
-- is portable across projects. After deploy, insert them once:
--
--   select vault.create_secret('https://<PROJECT_REF>.supabase.co/functions/v1/poller', 'poller_url');
--   select vault.create_secret('<random secret, also set as POLLER_SECRET on the function>', 'poller_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Sub-minute schedule ("15 seconds") requires Supabase's pg_cron >= 1.5.
-- Day-1 spike: confirm rows appear in cron.job_run_details every 15s.
-- Fallback if unsupported: schedule '* * * * *' and let the Edge Function
-- loop 3 polls internally with ~20s sleeps (fits the 150s wall clock).
select cron.schedule(
  'chainwatch-poller',
  '15 seconds',
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

-- Nightly pruning keeps the free-tier database small.
select cron.schedule(
  'chainwatch-prune',
  '0 4 * * *',
  $$
  delete from chain_polls where polled_at < now() - interval '7 days';
  delete from notifications_log where sent_at < now() - interval '30 days';
  $$
);
