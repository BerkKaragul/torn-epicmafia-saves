-- Event mode: a time-boxed stretch where the faction pays for saves WITHOUT a
-- ranked war (first use: the Halloween event, ending 2026-11-01 16:00 TCT).
--
-- War payouts are keyed to a Torn ranked war, so an event with no war had no
-- way to be paid. An event is its own window instead:
--   - starting one ends every open shift, and every shift started while it runs
--     is stamped with its id — so an event's chain pay is exactly the
--     earned_amount of its own shifts, never a pre-event shift's tail
--   - while it runs, saving from Torn City counts too: you can enlist from home,
--     flying home doesn't end your shift, and hourly pay accrues at home
--   - event shifts and saves are left out of war_report, so if a ranked war
--     ever overlaps an event nothing is paid twice
--   - the payout (chain pay + saves × the event's flat per-save amount) is
--     frozen into the row, like war_payouts, and shown on /payouts
--
-- Safe to apply live: additive columns, a widened CHECK, and functions
-- replaced in place.

create table chain_events (
  id bigserial primary key,
  name text not null,
  -- which look the site wears while it runs ('halloween' is the only one so far)
  theme text not null default 'halloween',
  started_at timestamptz not null default now(),
  -- scheduled end; the poller closes the event's shifts once it passes
  ends_at timestamptz not null,
  -- set when an admin ends it early
  ended_at timestamptz,
  -- flat $ per confirmed save during the event (editable until frozen)
  save_bonus numeric not null default 0,
  created_by bigint references members (torn_id),
  -- the frozen payout: rows + totals, null until an admin locks it in
  payout_lines jsonb,
  payout_totals jsonb,
  payout_saved_by bigint references members (torn_id),
  payout_saved_at timestamptz,
  check (ends_at > started_at)
);
create index chain_events_started on chain_events (started_at desc);
alter table chain_events enable row level security;

alter table shifts add column event_id bigint references chain_events (id);
create index shifts_event on shifts (event_id) where event_id is not null;

alter table shifts drop constraint shifts_end_reason_check;
alter table shifts add constraint shifts_end_reason_check
  check (end_reason in
    ('manual', 'planned_elapsed', 'admin', 'key_invalid', 'chain_dropped', 'saving_disabled',
     'returning_home', 'event_started', 'event_ended'));

-- the event running right now, if any
create or replace function active_event_id()
returns bigint
language sql
stable
as $$
  select id from chain_events
   where ended_at is null and started_at <= now() and ends_at > now()
   order by started_at desc
   limit 1;
$$;

-- Enlisting stamps the running event onto the shift (same lock + cap as before).
create or replace function start_shift(p_member_id bigint, p_planned_minutes int)
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
  perform pg_advisory_xact_lock(783401);

  select hourly_rate, saver_cap, saving_enabled
    into v_hourly_rate, v_cap, v_enabled
    from settings where id = 1;

  if not v_enabled then
    return jsonb_build_object('error', 'disabled');
  end if;

  select count(*) into v_active from shifts where ended_at is null;
  if v_cap > 0 and v_active >= v_cap then
    return jsonb_build_object('error', 'full', 'cap', v_cap, 'active', v_active);
  end if;

  insert into shifts (member_id, planned_minutes, hourly_rate_snapshot, event_id)
  values (p_member_id, p_planned_minutes, coalesce(v_hourly_rate, 0), active_event_id())
  returning * into v_shift;

  return jsonb_build_object('shift', to_jsonb(v_shift));
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_on_duty');
end;
$$;

-- Per-member event earnings: chain pay from the event's own shifts, saves
-- confirmed inside the event window at the event's flat rate.
create or replace function event_report(p_event bigint)
returns table (
  member_id bigint,
  name text,
  save_seconds bigint,
  chain_pay numeric,
  saves bigint,
  saves_pay numeric,
  missed_turns bigint
)
language sql
stable
as $$
  with ev as (
    select e.started_at as from_at,
           least(coalesce(e.ended_at, e.ends_at), now()) as to_at,
           e.save_bonus
      from chain_events e where e.id = p_event
  ),
  dut as (
    select sh.member_id,
           sum(sh.billable_seconds) as save_seconds,
           sum(sh.earned_amount) as chain_pay
      from shifts sh
     where sh.event_id = p_event
     group by sh.member_id
  ),
  svs as (
    select s.member_id, count(*) as saves
      from saves s cross join ev
     where s.status = 'confirmed' and s.member_id is not null
       and s.detected_at >= ev.from_at and s.detected_at <= ev.to_at
     group by s.member_id
  ),
  mis as (
    select mt.member_id, count(*) as missed
      from missed_turns mt cross join ev
     where mt.occurred_at >= ev.from_at and mt.occurred_at <= ev.to_at
     group by mt.member_id
  ),
  ids as (
    select member_id from dut
    union select member_id from svs
  ),
  res as (
    select i.member_id,
           coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
           coalesce(d.save_seconds, 0)::bigint as save_seconds,
           round(coalesce(d.chain_pay, 0)) as chain_pay,
           coalesce(v.saves, 0) as saves,
           round(coalesce(v.saves, 0) * ev.save_bonus) as saves_pay,
           coalesce(mi.missed, 0) as missed_turns
      from ids i
      cross join ev
      left join dut d on d.member_id = i.member_id
      left join svs v on v.member_id = i.member_id
      left join mis mi on mi.member_id = i.member_id
      left join roster r on r.torn_id = i.member_id
      left join members m on m.torn_id = i.member_id
  )
  select * from res
   order by chain_pay + saves_pay desc, saves desc, name;
$$;

revoke all on function active_event_id() from public;
revoke all on function event_report(bigint) from public;
grant execute on function active_event_id() to service_role;
grant execute on function event_report(bigint) to service_role;

-- war_report (as of 0027), minus event shifts and event-window saves.
drop function if exists war_report(bigint);
create function war_report(p_war bigint)
returns table (
  member_id bigint,
  name text,
  war_hits bigint,
  outside_hits bigint,
  retaliations bigint,
  assists bigint,
  respect numeric,
  saves bigint,
  save_seconds bigint,
  chain_pay numeric
)
language sql
stable
as $$
  with win as (
    select coalesce(w.started_at, '-infinity'::timestamptz) as from_at,
           coalesce(w.ended_at, now()) as to_at,
           coalesce(w.retals_synced, false) as retals_synced
      from (select 1) x
      left join wars w on w.torn_war_id = p_war
  ),
  chainhits as (
    select cc.member_id,
           sum(cc.attacks_war) as chain_war_hits,
           sum(cc.attacks_total - cc.attacks_war) as outside_hits,
           sum(cc.retaliations) as retaliations,
           sum(cc.assists) as assists,
           sum(cc.respect) as respect
      from chain_contributions cc
      join chains c on c.torn_chain_id = cc.torn_chain_id
      cross join win
     where p_war is null
        or (c.started_at < win.to_at and coalesce(c.ended_at, now()) > win.from_at)
     group by cc.member_id
  ),
  warrep as (
    select wc.member_id,
           sum(wc.war_hits) as war_hits,
           sum(wc.war_score) as war_score
      from war_contributions wc
     where p_war is null or wc.torn_war_id = p_war
     group by wc.member_id
  ),
  wret as (
    select wr.member_id, sum(wr.retals) as retals, sum(wr.assists) as assists
      from war_retals wr
     where p_war is null or wr.torn_war_id = p_war
     group by wr.member_id
  ),
  bon as (
    select cb.member_id,
           sum(cb.respect) as bonus_respect,
           count(*) as bonus_hits
      from chain_bonuses cb
      join chains c on c.torn_chain_id = cb.torn_chain_id
      cross join win
     where cb.chain_count >= 50
       and (p_war is null
            or (c.started_at < win.to_at and coalesce(c.ended_at, now()) > win.from_at))
       -- only milestones reached by war end (present in the war score); unknown
       -- crossing time falls back to stripping
       and (p_war is null
            or coalesce(
                 (select min(cp.polled_at) from chain_polls cp
                   where cp.torn_chain_id = cb.torn_chain_id and cp.current >= cb.chain_count),
                 c.started_at
               ) <= win.to_at + interval '30 seconds')
     group by cb.member_id
  ),
  svs as (
    select s.member_id, count(*) as saves
      from saves s
      cross join win
     where s.status = 'confirmed' and s.member_id is not null
       and (p_war is null or (s.detected_at >= win.from_at and s.detected_at <= win.to_at))
       -- saves inside an event window are paid by that event
       and not exists (
         select 1 from chain_events e
          where s.detected_at >= e.started_at
            and s.detected_at <= coalesce(e.ended_at, e.ends_at)
       )
     group by s.member_id
  ),
  dut as (
    select sh.member_id,
           sum(sh.billable_seconds) as save_seconds,
           sum(sh.earned_amount) as chain_pay
      from shifts sh
      cross join win
     -- event shifts are paid by their event
     where sh.event_id is null
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
         greatest(
           0,
           round(
             coalesce(w.war_score, h.respect, 0)
             - coalesce(b.bonus_respect, 0)
             + 10 * coalesce(b.bonus_hits, 0),
             2
           )
         ),
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
    left join roster r on r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 7 desc, 3 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
