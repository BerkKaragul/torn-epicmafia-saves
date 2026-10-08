-- Widget 1.12.0 (minimize/close, siren and freshness fixes) is on Greasy Fork:
-- nudge older installs. The floor stays at 1.11.0 (first Supabase-fed build).

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.12.0', 'min_version', '1.11.0')
$$;
