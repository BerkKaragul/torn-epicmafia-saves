-- ChainWatch schema — multi-faction.
--
-- One deployment serves any number of Torn factions. Every tenant row carries
-- the faction_id it belongs to, and every query the app and the poller make is
-- scoped by it. All access is server-side via the service-role key; RLS is
-- enabled everywhere with NO policies, so the anon/authenticated roles see
-- nothing.
--
-- Torn ids (members, chains, wars) are global, but two customer factions can
-- fight the SAME ranked war, and a member can move between factions, so every
-- tenant table keys on (faction_id, torn id) rather than the torn id alone.

-- ── factions: the tenants ────────────────────────────────────────────────
create table factions (
  faction_id bigint primary key,
  name text not null default '',
  tag text,
  created_at timestamptz not null default now(),
  -- the faction may use the app while now() < subscription_expires_at
  subscription_expires_at timestamptz,
  trial_granted_at timestamptz,
  -- platform owner kill switch, independent of the subscription
  suspended boolean not null default false,
  -- unguessable Realtime channel name, so one faction's pokes can't be watched
  -- (or spammed) by another
  realtime_topic text not null default 'cw-' || replace(gen_random_uuid()::text, '-', ''),
  -- unguessable id for the public userscript widget feed
  widget_token text not null unique default replace(gen_random_uuid()::text, '-', '')
);

-- ── per-faction settings ─────────────────────────────────────────────────
create table settings (
  faction_id bigint primary key references factions (faction_id) on delete cascade,
  hourly_rate numeric not null default 0,          -- Torn $ per hour on duty
  per_save_bonus numeric not null default 0,       -- Torn $ per confirmed save
  save_bonus_mode text not null default 'flat' check (save_bonus_mode in ('flat', 'scaled')),
  save_threshold_s int not null default 60,        -- hit with <= this remaining => save
  alert_threshold_s int not null default 90,       -- push/danger UI below this
  poll_interval_s int not null default 10,         -- active cadence (floor 10s)
  idle_poll_interval_s int not null default 60,    -- cadence when nothing is happening
  saver_cap int not null default 0,                -- 0 = unlimited simultaneous savers
  milestone_warn_hits int not null default 10,     -- warn this many hits before a bonus
  saving_enabled boolean not null default true,
  -- the faction saves from abroad only: enlisting requires being abroad (or
  -- flying out), pay accrues only while abroad, and flying home ends the shift
  abroad_only boolean not null default false,
  war_payout_config jsonb not null default '{}'::jsonb,
  leader_id bigint,
  co_leader_id bigint,
  poller_member_id bigint,                         -- whose key polls /faction/chain
  updated_at timestamptz not null default now()
);

-- ── per-faction poller state (also the per-faction overlap lock) ─────────
create table poller_state (
  faction_id bigint primary key references factions (faction_id) on delete cascade,
  last_poll_at timestamptz,
  last_chain_id bigint,
  last_current int,
  last_max int not null default 0,
  last_timeout_s int,
  last_cooldown_s int,
  running_since timestamptz,               -- overlap guard; stale after 55s
  consecutive_errors int not null default 0,
  danger_episode_key text,
  roster_refreshed_at timestamptz,
  last_broadcast_fingerprint text,
  last_broadcast_at timestamptz,
  last_accrual_at timestamptz
);

-- ── members & their encrypted keys ───────────────────────────────────────
-- A Torn user is one row; faction_id is the faction they belong to NOW. When
-- they move, login re-points it (and drops their admin flag and open shift).
create table members (
  torn_id bigint primary key,
  faction_id bigint not null references factions (faction_id),
  name text not null,
  api_key_ct text,                    -- base64 AES-256-GCM ciphertext (includes auth tag)
  api_key_iv text,                    -- base64 96-bit IV
  key_access_level text,              -- "Limited" / "Full" / "Custom"
  key_valid boolean not null default true,
  rate_limited_until timestamptz,     -- backoff window after Torn error 5
  is_admin boolean not null default false,
  admin_source text check (admin_source in ('auto', 'granted')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create index members_faction on members (faction_id);

-- ── saver duty shifts ────────────────────────────────────────────────────
create table shifts (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null references factions (faction_id) on delete cascade,
  member_id bigint not null references members (torn_id),
  started_at timestamptz not null default now(),
  planned_minutes int,
  ended_at timestamptz,
  end_reason text check (end_reason in (
    'manual', 'planned_elapsed', 'admin', 'key_invalid', 'chain_dropped',
    'saving_disabled', 'returning_home', 'left_faction', 'subscription_expired'
  )),
  hourly_rate_snapshot numeric not null,
  last_save_at timestamptz,               -- drives rotation order
  deprioritized_at timestamptz,           -- "skip my turn"
  unavailable_state text,                 -- Traveling / Hospital / Jail / Federal
  abroad boolean not null default false,  -- pay only accrues while abroad
  location text,
  travel_dest text,
  travel_started_at timestamptz,
  billable_seconds bigint not null default 0,  -- accrued by the poller
  earned_amount numeric not null default 0
);
create unique index one_active_shift on shifts (member_id) where ended_at is null;
create index shifts_faction_active on shifts (faction_id) where ended_at is null;
create index shifts_member on shifts (member_id);

-- ── chains & raw observations ────────────────────────────────────────────
create table chains (
  faction_id bigint not null references factions (faction_id) on delete cascade,
  torn_chain_id bigint not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('completed', 'dropped', 'unknown')),
  max_current int not null default 0,
  report_synced boolean not null default false,
  primary key (faction_id, torn_chain_id)
);

-- rolling observation log; pruned after 7 days (dispute evidence + calibration)
create table chain_polls (
  id bigserial primary key,
  faction_id bigint not null references factions (faction_id) on delete cascade,
  polled_at timestamptz not null,
  torn_chain_id bigint,
  current int not null,
  timeout_s int not null,
  cooldown_s int not null,
  raw jsonb
);
create index chain_polls_polled_at on chain_polls (polled_at);
create index chain_polls_chain_current on chain_polls (faction_id, torn_chain_id, current, polled_at);

-- ── detected saves ───────────────────────────────────────────────────────
create table saves (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null,
  torn_chain_id bigint not null,
  chain_count int not null,               -- `chain` value of the saving hit
  window_start timestamptz not null,      -- last poll before the reset
  window_end timestamptz not null,        -- poll that observed the reset
  timeout_at_window_start int not null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'unattributed', 'not_a_save')),
  expected_member_id bigint references members (torn_id),  -- rotation head when danger opened
  member_id bigint references members (torn_id),
  attack_id bigint,
  attack_code text,
  hit_registered_at timestamptz,          -- attack.ended
  remaining_at_hit_s numeric,             -- may be <= 0 for held attacks (still a save)
  bonus_snapshot numeric,
  attempts int not null default 0,        -- attribution sweep attempts so far
  note text,                              -- set on manual/admin attribution
  detected_at timestamptz not null default now(),
  unique (faction_id, torn_chain_id, chain_count),
  unique (faction_id, attack_id),
  foreign key (faction_id, torn_chain_id) references chains (faction_id, torn_chain_id) on delete cascade
);
create index saves_pending on saves (faction_id) where status = 'pending';
create index saves_member on saves (member_id);
create index saves_recent on saves (faction_id, detected_at desc)
  where status in ('confirmed', 'unattributed');

-- ── accountability & coordination ────────────────────────────────────────
-- When an ESTABLISHED chain (10+) dies with savers on duty, the rotation head
-- at that moment "missed their turn".
create table missed_turns (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null references factions (faction_id) on delete cascade,
  torn_chain_id bigint not null,
  chain_count_at_drop int not null,
  member_id bigint not null references members (torn_id),
  occurred_at timestamptz not null default now()
);
create index missed_turns_member on missed_turns (faction_id, member_id);

-- Urgent leave notes, broadcast by the poller to the remaining savers.
create table announcements (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null references factions (faction_id) on delete cascade,
  member_id bigint not null references members (torn_id),
  message text,
  was_head boolean not null default false,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index announcements_pending on announcements (faction_id, created_at)
  where processed_at is null;

-- Savers who physically can't attack (flying, hospital, jail).
create table unavailable_periods (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null references factions (faction_id) on delete cascade,
  member_id bigint not null references members (torn_id) on delete cascade,
  state text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
-- one open period per member keeps the intervals disjoint
create unique index one_open_unavailable on unavailable_periods (member_id)
  where ended_at is null;
create index unavailable_member on unavailable_periods (faction_id, member_id, started_at);

-- Planned availability ("I can save Tuesday 18–21").
create table availability_slots (
  id uuid primary key default gen_random_uuid(),
  faction_id bigint not null references factions (faction_id) on delete cascade,
  member_id bigint not null references members (torn_id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index availability_range on availability_slots (faction_id, start_at);

-- ── faction roster (names for members who never signed in) ───────────────
create table roster (
  faction_id bigint not null references factions (faction_id) on delete cascade,
  torn_id bigint not null,
  name text not null,
  updated_at timestamptz not null default now(),
  primary key (faction_id, torn_id)
);

-- ── wars, chain reports and payouts ──────────────────────────────────────
create table wars (
  faction_id bigint not null references factions (faction_id) on delete cascade,
  torn_war_id bigint not null,
  opponent_id bigint,
  opponent_name text,
  started_at timestamptz not null,
  ended_at timestamptz,
  target int,
  winner_id bigint,
  our_score int not null default 0,
  their_score int not null default 0,
  updated_at timestamptz not null default now(),
  report_synced boolean not null default false,
  retals_synced boolean not null default false,
  primary key (faction_id, torn_war_id)
);
create index wars_window on wars (faction_id, started_at desc);

-- per-member ranked war report (authoritative war hits + score)
create table war_contributions (
  faction_id bigint not null,
  torn_war_id bigint not null,
  member_id bigint not null,
  war_hits int not null default 0,
  war_score numeric not null default 0,
  primary key (faction_id, torn_war_id, member_id),
  foreign key (faction_id, torn_war_id) references wars (faction_id, torn_war_id) on delete cascade
);

-- war retals/assists counted from /faction/attacks by an admin
create table war_retals (
  faction_id bigint not null,
  torn_war_id bigint not null,
  member_id bigint not null,
  retals int not null default 0,
  respect numeric not null default 0,
  assists int not null default 0,
  primary key (faction_id, torn_war_id, member_id),
  foreign key (faction_id, torn_war_id) references wars (faction_id, torn_war_id) on delete cascade
);

-- per-member chain report
create table chain_contributions (
  faction_id bigint not null,
  torn_chain_id bigint not null,
  member_id bigint not null,
  attacks_total int not null default 0,
  attacks_war int not null default 0,
  attacks_overseas int not null default 0,
  retaliations int not null default 0,
  assists int not null default 0,
  bonuses int not null default 0,
  respect numeric not null default 0,
  primary key (faction_id, torn_chain_id, member_id),
  foreign key (faction_id, torn_chain_id) references chains (faction_id, torn_chain_id) on delete cascade
);

-- milestone bonus hits (their inflated respect is stripped from war payouts)
create table chain_bonuses (
  faction_id bigint not null,
  torn_chain_id bigint not null,
  chain_count int not null,
  member_id bigint not null,
  respect numeric not null default 0,
  primary key (faction_id, torn_chain_id, chain_count),
  foreign key (faction_id, torn_chain_id) references chains (faction_id, torn_chain_id) on delete cascade
);

-- a war's frozen final payout, readable by every member at /payouts
create table war_payouts (
  faction_id bigint not null,
  torn_war_id bigint not null,
  config jsonb not null,
  totals jsonb not null,
  lines jsonb not null,
  saved_by bigint not null references members (torn_id),
  saved_at timestamptz not null default now(),
  primary key (faction_id, torn_war_id),
  foreign key (faction_id, torn_war_id) references wars (faction_id, torn_war_id) on delete cascade
);
create index war_payouts_saved on war_payouts (faction_id, saved_at desc);

-- ── web push ─────────────────────────────────────────────────────────────
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  failed_count int not null default 0,
  disabled boolean not null default false
);
create index push_subs_member on push_subscriptions (member_id);

-- audit + dedup; pruned after 30 days. The UNIQUE constraint IS the dedup
-- mechanism: senders claim by insert-on-conflict-do-nothing.
create table notifications_log (
  id bigserial primary key,
  member_id bigint not null,
  channel text not null,
  event_type text not null,
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

-- ── billing (platform level) ─────────────────────────────────────────────
-- Factions pay in Xanax sent in-game to the vendor (the operator of this
-- deployment). The poller reads the vendor's own item-receive logs with the
-- vendor's Full Access key and extends the sender's faction subscription.
create table platform_config (
  id int primary key default 1 check (id = 1),
  -- the price: this many Xanax buys `period_days` days. Proportional, so half
  -- the price buys half the days. NULL = billing sweep is off.
  xanax_per_period int check (xanax_per_period is null or xanax_per_period > 0),
  period_days int not null default 15 check (period_days > 0),
  -- free days granted once to a faction on its first login (0 = no trial)
  trial_days int not null default 0 check (trial_days >= 0),
  xanax_item_id int not null default 206,
  -- the vendor account that receives payments; key is Full Access (logs need it)
  vendor_torn_id bigint,
  vendor_name text,
  vendor_key_ct text,
  vendor_key_iv text,
  vendor_key_valid boolean not null default false,
  -- item-receive log type ids, resolved from /torn/logtypes when the key is saved
  receive_log_type_ids int[] not null default '{}',
  -- sweep bookkeeping
  billing_cursor bigint,                  -- unix seconds of the newest log processed
  billing_running_since timestamptz,
  last_billing_sweep_at timestamptz,
  last_billing_error text,
  updated_at timestamptz not null default now()
);
insert into platform_config (id) values (1);

create table payments (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('torn_log', 'manual')),
  torn_log_id text unique,                -- dedup for log-sourced payments
  sender_id bigint,
  sender_name text,
  faction_id bigint references factions (faction_id) on delete set null,
  quantity int not null default 0,        -- Xanax received
  seconds_credited bigint not null default 0,
  status text not null check (status in ('applied', 'unmatched', 'ignored')),
  note text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index payments_faction on payments (faction_id, received_at desc);
create index payments_unmatched on payments (received_at desc) where status = 'unmatched';

-- ════════════════════════════════════════════════════════════════════════
-- Functions. All are service_role only.
-- ════════════════════════════════════════════════════════════════════════

-- Creates a faction (plus its settings and poller rows) if it doesn't exist
-- yet, and refreshes its name/tag when given. Idempotent. Returns the row.
create or replace function ensure_faction(p_faction bigint, p_name text, p_tag text)
returns factions
language plpgsql
as $$
declare
  v_row factions;
begin
  insert into factions (faction_id, name, tag)
  values (p_faction, coalesce(p_name, ''), p_tag)
  on conflict (faction_id) do update
    set name = coalesce(nullif(excluded.name, ''), factions.name),
        tag = coalesce(excluded.tag, factions.tag)
  returning * into v_row;
  insert into settings (faction_id) values (p_faction) on conflict do nothing;
  insert into poller_state (faction_id) values (p_faction) on conflict do nothing;
  return v_row;
end;
$$;

-- One-time free trial for a faction that has never had one.
create or replace function grant_trial(p_faction bigint)
returns factions
language plpgsql
as $$
declare
  v_days int;
  v_row factions;
begin
  select trial_days into v_days from platform_config where id = 1;
  update factions
     set trial_granted_at = now(),
         subscription_expires_at =
           greatest(coalesce(subscription_expires_at, now()), now()) + make_interval(days => v_days)
   where faction_id = p_faction
     and trial_granted_at is null
     and coalesce(v_days, 0) > 0
  returning * into v_row;
  return v_row;
end;
$$;

-- Records one payment and, if it can be matched to a faction, extends that
-- faction's subscription. Dedup on torn_log_id makes this safe to call again
-- for a log already seen: the second call is a no-op returning 'duplicate'.
create or replace function record_payment(
  p_source text,
  p_log_id text,
  p_sender bigint,
  p_sender_name text,
  p_faction bigint,
  p_faction_name text,
  p_quantity int,
  p_received_at timestamptz,
  p_note text
) returns jsonb
language plpgsql
as $$
declare
  v_price int;
  v_days int;
  v_seconds bigint := 0;
  v_status text;
  v_payment_id uuid;
  v_expires timestamptz;
begin
  select xanax_per_period, period_days into v_price, v_days from platform_config where id = 1;

  if p_faction is not null and p_faction > 0 then
    perform ensure_faction(p_faction, p_faction_name, null);
    if v_price is not null and p_quantity > 0 then
      v_seconds := floor(p_quantity::numeric / v_price * v_days * 86400);
    end if;
    v_status := case when v_seconds > 0 then 'applied' else 'ignored' end;
  else
    v_status := 'unmatched';
  end if;

  insert into payments (source, torn_log_id, sender_id, sender_name, faction_id,
                        quantity, seconds_credited, status, note, received_at)
  values (p_source, p_log_id, p_sender, p_sender_name,
          case when p_faction > 0 then p_faction end,
          p_quantity, v_seconds, v_status, p_note, coalesce(p_received_at, now()))
  on conflict (torn_log_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    return jsonb_build_object('status', 'duplicate');
  end if;

  if v_seconds > 0 then
    update factions
       set subscription_expires_at =
             greatest(coalesce(subscription_expires_at, now()), now())
             + make_interval(secs => v_seconds)
     where faction_id = p_faction
    returning subscription_expires_at into v_expires;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'payment_id', v_payment_id,
    'seconds', v_seconds,
    'expires_at', v_expires
  );
end;
$$;

-- Assigns an unmatched payment to a faction after the fact (platform owner).
create or replace function assign_payment(p_payment uuid, p_faction bigint)
returns jsonb
language plpgsql
as $$
declare
  v_price int;
  v_days int;
  v_qty int;
  v_seconds bigint;
  v_expires timestamptz;
begin
  select xanax_per_period, period_days into v_price, v_days from platform_config where id = 1;
  if v_price is null then
    return jsonb_build_object('error', 'price_not_set');
  end if;
  perform ensure_faction(p_faction, null, null);

  update payments set status = 'applied', faction_id = p_faction
   where id = p_payment and status in ('unmatched', 'ignored')
  returning quantity into v_qty;
  if v_qty is null then
    return jsonb_build_object('error', 'not_assignable');
  end if;

  v_seconds := floor(v_qty::numeric / v_price * v_days * 86400);
  update payments set seconds_credited = v_seconds where id = p_payment;
  update factions
     set subscription_expires_at =
           greatest(coalesce(subscription_expires_at, now()), now())
           + make_interval(secs => v_seconds)
   where faction_id = p_faction
  returning subscription_expires_at into v_expires;
  return jsonb_build_object('status', 'applied', 'seconds', v_seconds, 'expires_at', v_expires);
end;
$$;

-- Operator adds (or, with a negative amount, removes) subscription time by
-- hand — comps, refunds, payments made some other way. Logged as a payment.
create or replace function grant_time(p_faction bigint, p_seconds bigint, p_note text)
returns timestamptz
language plpgsql
as $$
declare
  v_expires timestamptz;
begin
  perform ensure_faction(p_faction, null, null);
  update factions
     set subscription_expires_at = case
           when p_seconds >= 0
             then greatest(coalesce(subscription_expires_at, now()), now())
                  + make_interval(secs => p_seconds)
           else coalesce(subscription_expires_at, now()) + make_interval(secs => p_seconds)
         end
   where faction_id = p_faction
  returning subscription_expires_at into v_expires;
  insert into payments (source, faction_id, quantity, seconds_credited, status, note)
  values ('manual', p_faction, 0, p_seconds, 'applied', p_note);
  return v_expires;
end;
$$;

-- Starts a duty shift, enforcing the faction's saver cap atomically: the
-- advisory lock is per faction, so concurrent enlist clicks in one faction
-- can never oversubscribe the cap while other factions don't wait on it.
create or replace function start_shift(p_faction bigint, p_member_id bigint, p_planned_minutes int)
returns jsonb
language plpgsql
as $$
declare
  v_hourly_rate numeric;
  v_cap int;
  v_enabled boolean;
  v_active int;
  v_shift shifts;
begin
  perform pg_advisory_xact_lock(783401, p_faction::int);

  select hourly_rate, saver_cap, saving_enabled
    into v_hourly_rate, v_cap, v_enabled
    from settings where faction_id = p_faction;

  if not found then
    return jsonb_build_object('error', 'no_faction');
  end if;
  if not v_enabled then
    return jsonb_build_object('error', 'disabled');
  end if;

  select count(*) into v_active from shifts where faction_id = p_faction and ended_at is null;
  if v_cap > 0 and v_active >= v_cap then
    return jsonb_build_object('error', 'full', 'cap', v_cap, 'active', v_active);
  end if;

  insert into shifts (faction_id, member_id, planned_minutes, hourly_rate_snapshot)
  values (p_faction, p_member_id, p_planned_minutes, coalesce(v_hourly_rate, 0))
  returning * into v_shift;

  return jsonb_build_object('shift', to_jsonb(v_shift));
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_on_duty');
end;
$$;

-- One round-trip per cycle: [{id, seconds, amount}, ...]
create or replace function accrue_shifts(p_rows jsonb)
returns void
language sql
as $$
  update shifts s
     set billable_seconds = s.billable_seconds + (r.value->>'seconds')::bigint,
         earned_amount = s.earned_amount + (r.value->>'amount')::numeric
    from jsonb_array_elements(p_rows) r
   where s.id = (r.value->>'id')::uuid
     and s.ended_at is null;
$$;

-- A member's accrued duty time and pay within their current faction.
create or replace function member_duty_totals(p_faction bigint, p_member bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'duty_seconds', coalesce(sum(billable_seconds), 0)::bigint,
    'hours_amount', round(coalesce(sum(earned_amount), 0))
  )
  from shifts
  where faction_id = p_faction and member_id = p_member;
$$;

-- Per-member war report for one faction: authoritative war hits/score from
-- the ranked war report, retals/assists from /faction/attacks when synced
-- (chain reports otherwise), respect with milestone bonuses stripped, plus
-- saves and accrued saver pay inside the war window. p_war null = all time.
create or replace function war_report(p_faction bigint, p_war bigint)
returns table (
  member_id bigint, name text, war_hits bigint, outside_hits bigint,
  retaliations bigint, assists bigint, respect numeric, saves bigint,
  save_seconds bigint, chain_pay numeric
)
language sql
stable
as $$
  with win as (
    select coalesce(w.started_at, '-infinity'::timestamptz) as from_at,
           coalesce(w.ended_at, now()) as to_at,
           coalesce(w.retals_synced, false) as retals_synced
      from (select 1) x
      left join wars w on w.faction_id = p_faction and w.torn_war_id = p_war
  ),
  chainhits as (
    select cc.member_id,
           sum(cc.attacks_war) as chain_war_hits,
           sum(cc.attacks_total - cc.attacks_war) as outside_hits,
           sum(cc.retaliations) as retaliations,
           sum(cc.assists) as assists,
           sum(cc.respect) as respect
      from chain_contributions cc
      join chains c on c.faction_id = cc.faction_id and c.torn_chain_id = cc.torn_chain_id
      cross join win
     where cc.faction_id = p_faction
       and (p_war is null
            or (c.started_at < win.to_at and coalesce(c.ended_at, now()) > win.from_at))
     group by cc.member_id
  ),
  warrep as (
    select wc.member_id, sum(wc.war_hits) as war_hits, sum(wc.war_score) as war_score
      from war_contributions wc
     where wc.faction_id = p_faction and (p_war is null or wc.torn_war_id = p_war)
     group by wc.member_id
  ),
  wret as (
    select wr.member_id, sum(wr.retals) as retals, sum(wr.assists) as assists
      from war_retals wr
     where wr.faction_id = p_faction and (p_war is null or wr.torn_war_id = p_war)
     group by wr.member_id
  ),
  bon as (
    select cb.member_id, sum(cb.respect) as bonus_respect, count(*) as bonus_hits
      from chain_bonuses cb
      join chains c on c.faction_id = cb.faction_id and c.torn_chain_id = cb.torn_chain_id
      cross join win
     where cb.faction_id = p_faction
       and cb.chain_count >= 50
       and (p_war is null
            or (c.started_at < win.to_at and coalesce(c.ended_at, now()) > win.from_at))
       -- only milestones reached by war end (present in the war score); an
       -- unknown crossing time falls back to stripping
       and (p_war is null
            or coalesce(
                 (select min(cp.polled_at) from chain_polls cp
                   where cp.faction_id = cb.faction_id
                     and cp.torn_chain_id = cb.torn_chain_id
                     and cp.current >= cb.chain_count),
                 c.started_at
               ) <= win.to_at + interval '30 seconds')
     group by cb.member_id
  ),
  svs as (
    select s.member_id, count(*) as saves
      from saves s
      cross join win
     where s.faction_id = p_faction
       and s.status = 'confirmed' and s.member_id is not null
       and (p_war is null or (s.detected_at >= win.from_at and s.detected_at <= win.to_at))
     group by s.member_id
  ),
  dut as (
    select sh.member_id,
           sum(sh.billable_seconds) as save_seconds,
           sum(sh.earned_amount) as chain_pay
      from shifts sh
      cross join win
     where sh.faction_id = p_faction
       and (p_war is null
            or (sh.started_at < win.to_at and coalesce(sh.ended_at, now()) > win.from_at))
     group by sh.member_id
  ),
  ids as (
    select member_id from chainhits
    union select member_id from warrep
    union select member_id from wret
    union select member_id from bon
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(w.war_hits, h.chain_war_hits, 0),
         coalesce(h.outside_hits, 0),
         case when win.retals_synced then coalesce(wr.retals, 0)
              else coalesce(h.retaliations, 0) end,
         case when win.retals_synced then coalesce(wr.assists, 0)
              else coalesce(h.assists, 0) end,
         greatest(0, round(
           coalesce(w.war_score, h.respect, 0)
           - coalesce(b.bonus_respect, 0)
           + 10 * coalesce(b.bonus_hits, 0),
           2)),
         coalesce(v.saves, 0),
         coalesce(d.save_seconds, 0)::bigint,
         round(coalesce(d.chain_pay, 0))
    from ids i
    cross join win
    left join chainhits h on h.member_id = i.member_id
    left join warrep w on w.member_id = i.member_id
    left join wret wr on wr.member_id = i.member_id
    left join bon b on b.member_id = i.member_id
    left join svs v on v.member_id = i.member_id
    left join dut d on d.member_id = i.member_id
    left join roster r on r.faction_id = p_faction and r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 7 desc, 3 desc, 2;
$$;

-- ── lock it all down: service-role only ──────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'factions', 'settings', 'poller_state', 'members', 'shifts', 'chains',
    'chain_polls', 'saves', 'missed_turns', 'announcements', 'unavailable_periods',
    'availability_slots', 'roster', 'wars', 'war_contributions', 'war_retals',
    'chain_contributions', 'chain_bonuses', 'war_payouts', 'push_subscriptions',
    'notifications_log', 'login_attempts', 'platform_config', 'payments'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'ensure_faction(bigint, text, text)',
    'grant_trial(bigint)',
    'record_payment(text, text, bigint, text, bigint, text, int, timestamptz, text)',
    'assign_payment(uuid, bigint)',
    'grant_time(bigint, bigint, text)',
    'start_shift(bigint, bigint, int)',
    'accrue_shifts(jsonb)',
    'member_duty_totals(bigint, bigint)',
    'war_report(bigint, bigint)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
