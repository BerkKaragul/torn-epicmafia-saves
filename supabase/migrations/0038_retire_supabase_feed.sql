-- Applied to Supabase only (the retired backend), not the VPS.
--
-- Supabase's poller is off since the move, so its widget_feed froze at the
-- last reading. Old installs still poll it, and on TornPDA (one storage for
-- every userscript) an old copy left next to 1.15.0 wrote that frozen
-- reading where 1.15.0 picked it up: timer at 0:00, siren-prone. Serve only
-- the version floor from here — enough for "Update required", nothing to
-- count down.

create or replace function public.widget_feed()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true) || public.widget_versions()
$$;
