-- ChainWatch schema. All access is server-side via the service-role key;
-- RLS is enabled everywhere with NO policies so anon/authenticated see nothing.

-- ── singleton app settings ───────────────────────────────────────────────
create table settings (
  id int primary key default 1 check (id = 1),
  faction_id bigint not null default 40959,
  hourly_rate numeric not null default 0,          -- Torn $ per hour on duty
  per_save_bonus numeric not null default 0,       -- Torn $ per confirmed save
  save_threshold_s int not null default 90,        -- hit with <= this remaining => save
  alert_threshold_s int not null default 90,       -- push/danger UI below this
  poll_interval_s int not null default 20,
  idle_poll_interval_s int not null default 60,    -- cadence when no chain & nobody on duty
  leader_id bigint,
  co_leader_id bigint,
  poller_member_id bigint,                         -- whose key polls /faction/chain
  updated_at timestamptz not null default now()
);
insert into settings (id) values (1);

-- ── members & their encrypted keys ───────────────────────────────────────
create table members (
  torn_id bigint primary key,
  name text not null,
  api_key_ct text,                    -- base64 AES-256-GCM ciphertext (includes auth tag)
  api_key_iv text,                    -- base64 96-bit IV
  key_access_level text,              -- "Limited" / "Full Access"
  key_valid boolean not null default true,
  is_admin boolean not null default false,
  admin_source text check (admin_source in ('auto', 'granted')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- ── saver duty shifts ────────────────────────────────────────────────────
create table shifts (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id),
  started_at timestamptz not null default now(),
  planned_minutes int,                -- optional "I can save for 3h"
  ended_at timestamptz,
  end_reason text check (end_reason in ('manual', 'planned_elapsed', 'admin', 'key_invalid')),
  hourly_rate_snapshot numeric not null,
  last_save_at timestamptz,           -- drives rotation order
  payout_line_id uuid
);
create unique index one_active_shift on shifts (member_id) where ended_at is null;
create index shifts_member on shifts (member_id);
create index shifts_unpaid on shifts (ended_at) where payout_line_id is null;

-- ── chains & raw observations ────────────────────────────────────────────
create table chains (
  torn_chain_id bigint primary key,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('completed', 'dropped', 'unknown')),
  max_current int not null default 0
);

-- rolling observation log; pruned after 7 days (dispute evidence + calibration)
create table chain_polls (
  id bigserial primary key,
  polled_at timestamptz not null,
  torn_chain_id bigint,
  current int not null,
  timeout_s int not null,
  cooldown_s int not null,
  raw jsonb
);
create index chain_polls_polled_at on chain_polls (polled_at);

-- ── detected saves ───────────────────────────────────────────────────────
create table saves (
  id uuid primary key default gen_random_uuid(),
  torn_chain_id bigint not null references chains (torn_chain_id),
  chain_count int not null,               -- `chain` value of the saving hit
  window_start timestamptz not null,      -- last poll before the reset
  window_end timestamptz not null,        -- poll that observed the reset
  timeout_at_window_start int not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'unattributed', 'not_a_save')),
  member_id bigint references members (torn_id),
  attack_id bigint unique,
  attack_code text,
  hit_registered_at timestamptz,          -- attack.ended
  remaining_at_hit_s numeric,             -- may be <= 0 for held attacks (still a save)
  bonus_snapshot numeric,
  attempts int not null default 0,        -- attribution sweep attempts so far
  note text,                              -- set on manual/admin attribution
  payout_line_id uuid,
  detected_at timestamptz not null default now(),
  unique (torn_chain_id, chain_count)
);
create index saves_pending on saves (status) where status = 'pending';
create index saves_member on saves (member_id);

-- ── web push ─────────────────────────────────────────────────────────────
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  failed_count int not null default 0,
  disabled boolean not null default false
);
create index push_subs_member on push_subscriptions (member_id);

-- audit + dedup; pruned after 30 days
create table notifications_log (
  id bigserial primary key,
  member_id bigint,
  channel text not null,                  -- 'webpush' (later: 'discord')
  event_type text not null,               -- 'timer_low' | 'your_turn' | 'scooped' | 'shift_end' | 'save_confirmed'
  dedup_key text not null,
  sent_at timestamptz not null default now(),
  success boolean,
  error text
);
create index notif_dedup on notifications_log (dedup_key, sent_at);

-- ── payouts ──────────────────────────────────────────────────────────────
create table payout_periods (
  id uuid primary key default gen_random_uuid(),
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_by bigint not null,
  created_at timestamptz not null default now(),
  status text not null default 'draft' check (status in ('draft', 'finalized'))
);

create table payout_lines (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references payout_periods (id) on delete cascade,
  member_id bigint not null references members (torn_id),
  duty_seconds bigint not null,
  save_count int not null,
  hours_amount numeric not null,
  saves_amount numeric not null,
  total_amount numeric not null,
  paid_at timestamptz,
  paid_by bigint,
  note text
);
create index payout_lines_period on payout_lines (period_id);

alter table shifts
  add constraint shifts_payout_line_fk
  foreign key (payout_line_id) references payout_lines (id) on delete set null;
alter table saves
  add constraint saves_payout_line_fk
  foreign key (payout_line_id) references payout_lines (id) on delete set null;

-- ── poller state singleton (also the overlap lock) ───────────────────────
create table poller_state (
  id int primary key default 1 check (id = 1),
  last_poll_at timestamptz,
  last_chain_id bigint,
  last_current int,
  last_timeout_s int,
  last_cooldown_s int,
  running_since timestamptz,              -- overlap guard; stale after 60s
  consecutive_errors int not null default 0,
  danger_episode_key text,
  roster_refreshed_at timestamptz
);
insert into poller_state (id) values (1);

-- ── lock it all down: service-role only ──────────────────────────────────
alter table settings enable row level security;
alter table members enable row level security;
alter table shifts enable row level security;
alter table chains enable row level security;
alter table chain_polls enable row level security;
alter table saves enable row level security;
alter table push_subscriptions enable row level security;
alter table notifications_log enable row level security;
alter table payout_periods enable row level security;
alter table payout_lines enable row level security;
alter table poller_state enable row level security;
