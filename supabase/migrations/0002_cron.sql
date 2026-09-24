-- Scheduling: pg_cron fires the poller Edge Function via pg_net every 10s.
-- ONE job serves every faction: each invocation walks the factions with an
-- active subscription and runs a cycle for each that is due (each faction has
-- its own cadence and overlap lock in poller_state), then runs the billing
-- sweep at most once a minute.
--
-- The function URL and shared secret live in Supabase Vault so this migration
-- is portable across projects. Store them once with setup_poller_config()
-- below (or vault.create_secret in the SQL editor).
--
-- Sub-minute schedules need pg_cron >= 1.5 (all current Supabase projects).

create extension if not exists pg_cron;
create extension if not exists pg_net;

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

-- Nightly pruning keeps the free-tier database small.
select cron.schedule(
  'chainwatch-prune',
  '0 4 * * *',
  $$
  delete from chain_polls where polled_at < now() - interval '7 days';
  delete from notifications_log where sent_at < now() - interval '30 days';
  delete from login_attempts where at < now() - interval '1 day';
  $$
);

-- Stores/replaces the two Vault secrets the cron job reads. Contains no
-- secret values itself — they're passed in at call time.
create or replace function setup_poller_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where name in ('poller_url', 'poller_secret');
  perform vault.create_secret(p_url, 'poller_url');
  perform vault.create_secret(p_secret, 'poller_secret');
end;
$$;
revoke all on function setup_poller_config(text, text) from public;
grant execute on function setup_poller_config(text, text) to service_role;

-- Health check: proves the cron is firing and shows every faction's poller.
create or replace function poller_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_runs jsonb;
  v_state jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'job', j.jobname, 'status', d.status,
           'started', d.start_time, 'finished', d.end_time)
           order by d.start_time desc), '[]'::jsonb)
    into v_runs
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
   where j.jobname like 'chainwatch%'
     and d.start_time > now() - interval '3 minutes';

  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_state
    from (select faction_id, last_poll_at, last_chain_id, last_current, last_timeout_s,
                 consecutive_errors, running_since
            from public.poller_state) p;

  return jsonb_build_object('recent_cron_runs', v_runs, 'poller_state', v_state);
end;
$$;
revoke all on function poller_health() from public;
grant execute on function poller_health() to service_role;
