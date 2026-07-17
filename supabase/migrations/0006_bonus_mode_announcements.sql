-- 1) Save bonus valuation mode: 'flat' pays per_save_bonus for every save;
--    'scaled' pays per_save_bonus × (chain/100), floored at 1× — saving a
--    1,200-chain is worth 12× a small-chain save. Toggleable at any time;
--    bonuses are snapshotted at confirmation so history never changes.
alter table settings add column save_bonus_mode text not null default 'flat'
  check (save_bonus_mode in ('flat', 'scaled'));

-- 2) Urgent leave notes: when a saver stops duty they can attach a message;
--    if they were the rotation head (or left a note), the poller broadcasts
--    it to the remaining savers within one cycle (~15s).
create table announcements (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id),
  message text,
  was_head boolean not null default false,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index announcements_pending on announcements (created_at) where processed_at is null;
alter table announcements enable row level security;
