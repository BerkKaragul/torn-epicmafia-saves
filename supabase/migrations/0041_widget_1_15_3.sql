-- Widget 1.15.3 (docks under the header on phones whose bars it can't match)
-- is the latest; not mandatory, so the floor stays at 1.15.2. Applied to the
-- VPS once Greasy Fork serves 1.15.3.

create or replace function public.widget_versions()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('latest_version', '1.15.3', 'min_version', '1.15.2')
$$;
