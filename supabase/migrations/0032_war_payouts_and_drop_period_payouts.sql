-- A war's payout is decided once: the admin fetches retals, checks the report,
-- tunes the weights, and then FREEZES the numbers. From that moment the
-- snapshot below is what every member reads at /payouts — it never drifts when
-- a late chain report syncs or someone edits the default weights.
--
-- The rows are stored rather than recomputed on read precisely because "final"
-- has to mean final. Re-saving replaces the snapshot (admins can correct a
-- mistake), which is why torn_war_id is the primary key: one war, one truth.

create table war_payouts (
  torn_war_id bigint primary key references wars (torn_war_id) on delete cascade,
  -- the weight knobs exactly as they were when the numbers were frozen
  config jsonb not null,
  -- { prize, sumChain, sumRetal, distributed, grand, members }
  totals jsonb not null,
  -- the frozen per-member rows (see WarPayoutRow in lib/warPayout.ts)
  lines jsonb not null,
  saved_by bigint not null references members (torn_id),
  saved_at timestamptz not null default now()
);
create index war_payouts_saved on war_payouts (saved_at desc);
alter table war_payouts enable row level security;

-- ── retire the period-sweep payout system ────────────────────────────────
-- War payouts already include duty pay (chain_pay) and save bonuses, scoped to
-- the war window. Sweeping the same shifts and saves into a separate periodic
-- report paid them a second time, so the whole mechanism goes: generate_payout,
-- the per-member balance/settle flow, and their API routes and UI.
--
-- The payout_periods / payout_lines / adjustments TABLES stay: they hold the
-- historical record of what was already paid, and shifts.payout_line_id /
-- saves.payout_line_id still point at them.

drop function if exists generate_payout(timestamptz, timestamptz, bigint);
drop function if exists settle_member(bigint, bigint, boolean, text);
drop function if exists member_balances();
