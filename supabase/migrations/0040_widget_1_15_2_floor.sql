-- Widget 1.15.2 (backend at cw.cloum.com behind Cloudflare, fallback through
-- the site for blocked networks) is mandatory: raise the floor to it, so
-- 1.15.0/1.15.1 show "Update required" and go quiet. Applied to the VPS and to
-- the retired Supabase feed alike, once Greasy Fork serves 1.15.2.

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.15.2', 'min_version', '1.15.2')
$$;
