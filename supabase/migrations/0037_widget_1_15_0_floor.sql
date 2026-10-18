-- Widget 1.15.0 reads the feed from the ChainWatch server (VPS) instead of
-- Supabase. Raise the floor to it: on Supabase this makes every older install
-- show "Update required" and go quiet instead of extrapolating a frozen timer
-- into a false siren; on the VPS it changes nothing (only 1.15.0+ reach it).

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.15.0', 'min_version', '1.15.0')
$$;
