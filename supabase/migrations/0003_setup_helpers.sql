-- Remote-setup helpers so deployment needs no manual SQL-editor work.
-- Both are service_role-only: EXECUTE is revoked from everyone else.

-- Stores/replaces the two Vault secrets the pg_cron poller job reads.
-- Contains no secret values itself — they're passed in at call time.
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

-- Health check: proves the 15s cron is firing and shows poller state.
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

  select to_jsonb(p) into v_state
    from (select last_poll_at, last_chain_id, last_current, last_timeout_s,
                 consecutive_errors, running_since
            from public.poller_state where id = 1) p;

  return jsonb_build_object('recent_cron_runs', v_runs, 'poller_state', v_state);
end;
$$;
revoke all on function poller_health() from public;
grant execute on function poller_health() to service_role;
