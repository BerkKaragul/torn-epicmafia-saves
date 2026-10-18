-- Widget 1.15.1 (own storage keys, no countdown from a frozen reading) is on
-- Greasy Fork: nudge 1.15.0 installs. The floor stays at 1.15.0, the first
-- build that reads from the VPS.

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.15.1', 'min_version', '1.15.0')
$$;
