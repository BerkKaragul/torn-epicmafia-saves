-- Widget feed served straight from Supabase, so the Torn userscript no longer
-- touches Vercel at all. Every faction member's userscript polls this from
-- every open Torn tab; through /api/widget each poll was a Vercel function
-- invocation, which blew through the Hobby plan's invocation and Active CPU
-- limits. Through PostgREST it's one cheap read per poll:
--   GET /rest/v1/rpc/widget_feed   (header: apikey = anon key)
--
-- Same payload as the old /api/widget route: non-sensitive live state only
-- (saver names, locations, chain timer). Every table has RLS on with no
-- policies, so anon reads nothing directly; this security-definer function is
-- the one narrow window. The rotation queue mirrors rotationOrder()
-- (supabase/functions/_shared/logic/rotation.ts): available savers sorted by
-- greatest(start, last save, skip) in whole seconds, ties by member id.
--
-- Version signal for the userscript: it compares its own @version to these.
-- Bumping them means a new migration with `create or replace`.

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
    jsonb_build_object(
      'ok', true,
      'latest_version', '1.11.0',
      'min_version', '1.11.0',
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

-- Lock down function EXECUTE. Supabase's default privileges grant EXECUTE on
-- every new public function to anon and authenticated explicitly, so the
-- `revoke ... from public` in 0003 never took effect: setup_poller_config()
-- (security definer — rewrites the poller's Vault URL/secret) was callable
-- with the anon key that ships in the site's JS. Nothing uses anon/
-- authenticated RPC (the app and the poller use the service role), so revoke
-- across the board, re-grant only the widget feed, and stop future functions
-- from being auto-granted.
revoke execute on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
revoke all on function public.widget_feed() from public;
grant execute on function public.widget_feed() to anon, service_role;

notify pgrst, 'reload schema';
