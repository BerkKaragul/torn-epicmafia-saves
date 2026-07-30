-- Saver availability planner. Completely separate from the live saving system:
-- nothing here is read by the poller, affects shifts, rotation, or pay. It's
-- just people saying "I might be around to save then" so the faction can spot
-- coverage and gaps ahead of time.

create table availability_slots (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index availability_range on availability_slots (start_at);
create index availability_member on availability_slots (member_id);
alter table availability_slots enable row level security;
