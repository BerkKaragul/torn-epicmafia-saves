-- Additive only: two nullable columns on shifts for showing where a flying saver
-- is headed and when they took off. Safe during an active war — no existing row
-- is touched, no default backfill.
--   travel_dest       — direction-aware destination parsed from Torn status:
--                       "Traveling to X" -> X ; "Returning to Torn from X" -> "Torn".
--                       Null unless the saver is currently Traveling.
--   travel_started_at — when the poller first observed the saver enter Traveling
--                       (~poll-cadence accurate departure time). Null when not flying.
alter table shifts add column if not exists travel_dest text;
alter table shifts add column if not exists travel_started_at timestamptz;
