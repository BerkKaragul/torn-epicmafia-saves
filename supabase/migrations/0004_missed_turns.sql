-- Accountability for dropped chains: when an ESTABLISHED chain (10+ hits)
-- dies while savers were on duty, the rotation head at that moment "missed
-- their turn" — recorded here as a per-member tally. Availability pay also
-- stops at that moment: all active shifts are ended with reason
-- 'chain_dropped' (paid up to the drop, nothing after).

create table missed_turns (
  id uuid primary key default gen_random_uuid(),
  torn_chain_id bigint not null,
  chain_count_at_drop int not null,
  member_id bigint not null references members (torn_id),
  occurred_at timestamptz not null default now()
);
create index missed_turns_member on missed_turns (member_id);
alter table missed_turns enable row level security;

alter table shifts drop constraint shifts_end_reason_check;
alter table shifts add constraint shifts_end_reason_check
  check (end_reason in ('manual', 'planned_elapsed', 'admin', 'key_invalid', 'chain_dropped'));
