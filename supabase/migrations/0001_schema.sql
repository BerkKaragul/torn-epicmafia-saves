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
  poll_interval_s int not null default 15,  -- active cadence; cron floor is 15s
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
  rate_limited_until timestamptz,      -- backoff window after Torn error 5
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
-- hot "latest save" lookup for the live page
create index saves_recent on saves (detected_at desc)
  where status in ('confirmed', 'unattributed');

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

-- audit + dedup; pruned after 30 days. The UNIQUE index IS the dedup
-- mechanism: senders claim by insert-on-conflict-do-nothing, so at-most-once
-- per (key, member, channel) is a database invariant, not a timing accident.
create table notifications_log (
  id bigserial primary key,
  member_id bigint not null,
  channel text not null,                  -- 'webpush' (later: 'discord')
  event_type text not null,               -- 'timer_low' | 'your_turn' | 'scooped' | 'shift_end' | 'save_confirmed'
  dedup_key text not null,
  sent_at timestamptz not null default now(),
  success boolean,
  error text,
  unique (dedup_key, member_id, channel)
);

-- login rate limiting; pruned nightly
create table login_attempts (
  id bigserial primary key,
  ip text not null,
  at timestamptz not null default now()
);
create index login_attempts_ip_at on login_attempts (ip, at);

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
  last_max int not null default 0,
  consecutive_errors int not null default 0,
  danger_episode_key text,
  roster_refreshed_at timestamptz,
  last_broadcast_fingerprint text,
  last_broadcast_at timestamptz
);
insert into poller_state (id) values (1);

-- ── payout generation: one transaction, claim-once, crash-safe ───────────
-- Claims EVERYTHING unpaid up to p_end (ended shifts + confirmed saves), so
-- late manual attributions are always swept into the next run. p_start is a
-- report label. Row-level "payout_line_id is null" guards make concurrent
-- runs safe: the first writer wins each row, and amounts are computed from
-- the rows this line actually won.
create or replace function generate_payout(
  p_start timestamptz,
  p_end timestamptz,
  p_created_by bigint
) returns jsonb
language plpgsql
as $$
declare
  v_period_id uuid;
  v_member bigint;
  v_line_id uuid;
  v_duty bigint;
  v_hours numeric;
  v_saves_amt numeric;
  v_save_count int;
  v_lines int := 0;
begin
  insert into payout_periods (period_start, period_end, created_by)
  values (p_start, p_end, p_created_by)
  returning id into v_period_id;

  for v_member in
    select distinct member_id from (
      select member_id from shifts
       where payout_line_id is null and ended_at is not null and ended_at <= p_end
      union
      select member_id from saves
       where payout_line_id is null and status = 'confirmed'
         and member_id is not null and detected_at <= p_end
    ) candidates
  loop
    insert into payout_lines
      (period_id, member_id, duty_seconds, save_count, hours_amount, saves_amount, total_amount)
    values (v_period_id, v_member, 0, 0, 0, 0, 0)
    returning id into v_line_id;

    update shifts set payout_line_id = v_line_id
     where member_id = v_member and payout_line_id is null
       and ended_at is not null and ended_at <= p_end;

    update saves set payout_line_id = v_line_id
     where member_id = v_member and payout_line_id is null
       and status = 'confirmed' and detected_at <= p_end;

    select coalesce(sum(extract(epoch from (ended_at - started_at))), 0)::bigint,
           coalesce(sum(extract(epoch from (ended_at - started_at)) / 3600.0
                        * hourly_rate_snapshot), 0)
      into v_duty, v_hours
      from shifts where payout_line_id = v_line_id;

    select count(*), coalesce(sum(bonus_snapshot), 0)
      into v_save_count, v_saves_amt
      from saves where payout_line_id = v_line_id;

    if v_duty = 0 and v_save_count = 0 then
      delete from payout_lines where id = v_line_id;
    else
      update payout_lines
         set duty_seconds = v_duty,
             save_count = v_save_count,
             hours_amount = round(v_hours),
             saves_amount = round(v_saves_amt),
             total_amount = round(v_hours) + round(v_saves_amt)
       where id = v_line_id;
      v_lines := v_lines + 1;
    end if;
  end loop;

  if v_lines = 0 then
    delete from payout_periods where id = v_period_id;
    return jsonb_build_object('error', 'nothing to pay');
  end if;
  return jsonb_build_object('period_id', v_period_id, 'lines', v_lines);
end;
$$;

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
alter table login_attempts enable row level security;
