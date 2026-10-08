-- Widget version signal split out of widget_feed() so a release only has to
-- replace this tiny function, not copy the whole feed. widget_feed() is
-- security definer and calls it as its owner, so anon needs no grant here
-- (and 0033 stopped new functions from being granted to anon).
--
-- latest → the widget shows an "update available" nudge below it.
-- min    → the kill floor: installs below it show "Update required" and go
--          quiet. Keep it at a version that's actually on Greasy Fork.

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.11.1', 'min_version', '1.11.0')
$$;

create or replace function public.widget_feed()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select saving_enabled, alert_threshold_s from public.settings where id = 1
  ),
  st as (
    select last_chain_id, last_current, last_max, last_timeout_s, last_cooldown_s, last_poll_at
      from public.poller_state where id = 1
  ),
  active as (
    select sh.member_id, m.name, sh.location,
           coalesce(sh.unavailable_state, '') = '' as available,
           greatest(
             date_trunc('second', sh.started_at),
             date_trunc('second', coalesce(sh.last_save_at, sh.started_at)),
             date_trunc('second', coalesce(sh.deprioritized_at, 'epoch'::timestamptz))
           ) as turn_key
      from public.shifts sh
      join public.members m on m.torn_id = sh.member_id
     where sh.ended_at is null
  ),
  queue as (
    select name, location, row_number() over (order by turn_key, member_id) as pos
      from active where available
  )
  select case when not exists (select 1 from s) then
    jsonb_build_object('error', 'not ready')
  else
    public.widget_versions() || jsonb_build_object(
      'ok', true,
      'saving_enabled', (select saving_enabled from s),
      'alert_threshold_s', (select alert_threshold_s from s),
      'chain', jsonb_build_object(
        'id', coalesce((select last_chain_id from st), 0),
        'current', coalesce((select last_current from st), 0),
        'max', coalesce((select last_max from st), 0),
        'timeout_s', coalesce((select last_timeout_s from st), 0),
        'cooldown_s', coalesce((select last_cooldown_s from st), 0),
        'observed_at', coalesce(floor(extract(epoch from (select last_poll_at from st)))::bigint, 0)
      ),
      'turn', (select name from queue where pos = 1),
      'turn_location', (select location from queue where pos = 1),
      'next', (select name from queue where pos = 2),
      'next_location', (select location from queue where pos = 2),
      'on_duty', (select count(*) from queue),
      'total_on_duty', (select count(*) from active),
      'on_duty_names', coalesce((select jsonb_agg(name) from active), '[]'::jsonb)
    )
  end
$$;

revoke all on function public.widget_versions() from public;
