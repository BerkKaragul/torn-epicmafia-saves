-- Savers only earn hourly pay while they're actually abroad (deployed to save):
-- saving is done in another country, so sitting in the home city (Torn, state
-- "Okay") earns nothing. This is a PAY gate only — it does NOT touch rotation,
-- turns, the save bonus, or the travel/hospital pause. The poller keeps this in
-- sync from each member's Torn status every cycle; billing already just sums the
-- accrued columns, so no billing function needs to change.
alter table shifts add column abroad boolean not null default false;
