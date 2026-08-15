-- Two small saver-experience additions:
--   location        — the country a saver is currently in (parsed from Torn's
--                     member status by the poller), shown next to their name.
--   deprioritized_at — set when a saver taps "skip my turn"; the rotation key
--                     is greatest(started_at, last_save_at, deprioritized_at),
--                     so setting it to now() sends them to the back of the
--                     queue without recording a save (no pay/stat credit).

alter table shifts add column if not exists location text;
alter table shifts add column if not exists deprioritized_at timestamptz;
