-- Widget 1.14.0 (docks into Torn's sidebar / mobile header; × shrinks to a tab
-- instead of hiding) is on Greasy Fork: nudge older installs. The floor stays
-- at 1.11.0 (first Supabase-fed build).

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.14.0', 'min_version', '1.11.0')
$$;
