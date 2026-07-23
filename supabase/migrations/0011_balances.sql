-- Running per-member balance the admins can act on directly: pay it out, wipe
-- it, or nudge it up/down by hand. The balance is derived from everything not
-- yet settled — accrued duty pay + confirmed save bonuses + manual adjustments.

create table adjustments (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id),
  amount numeric not null,                 -- positive adds, negative removes
  note text,
  created_by bigint not null,
  created_at timestamptz not null default now(),
  payout_line_id uuid references payout_lines (id) on delete set null
);
create index adjustments_unpaid on adjustments (member_id) where payout_line_id is null;
alter table adjustments enable row level security;

alter table payout_lines add column adjustments_amount numeric not null default 0;
-- settlements record how the balance was cleared
alter table payout_lines add column settle_mode text
  check (settle_mode in ('paid', 'written_off'));

-- ── what every member is owed right now ──────────────────────────────────
create or replace function member_balances()
returns table (
  member_id bigint,
  name text,
  duty_seconds bigint,
  duty_amount numeric,
  save_count int,
  saves_amount numeric,
  adjustments_amount numeric,
  total_amount numeric
)
language sql
stable
as $$
  select m.torn_id,
         m.name,
         coalesce(s.secs, 0)::bigint,
         round(coalesce(s.amt, 0)),
         coalesce(v.cnt, 0)::int,
         round(coalesce(v.amt, 0)),
         round(coalesce(a.amt, 0)),
         round(coalesce(s.amt, 0)) + round(coalesce(v.amt, 0)) + round(coalesce(a.amt, 0))
    from members m
    left join (
      select member_id, sum(billable_seconds) as secs, sum(earned_amount) as amt
        from shifts where payout_line_id is null group by member_id
    ) s on s.member_id = m.torn_id
    left join (
      select member_id, count(*) as cnt, sum(bonus_snapshot) as amt
        from saves
       where payout_line_id is null and status = 'confirmed' and member_id is not null
       group by member_id
    ) v on v.member_id = m.torn_id
    left join (
      select member_id, sum(amount) as amt
        from adjustments where payout_line_id is null group by member_id
    ) a on a.member_id = m.torn_id
   order by 8 desc, 2;
$$;

-- ── settle one member's balance to zero ──────────────────────────────────
-- p_paid true  = "paid in game", recorded as a payment
-- p_paid false = wipe the balance without paying (write-off)
-- An OPEN shift can't be claimed (it keeps accruing), so its accrued total is
-- drained into the settlement and its counters reset — the saver stays on duty.
create or replace function settle_member(
  p_member bigint,
  p_by bigint,
  p_paid boolean,
  p_note text
) returns jsonb
language plpgsql
as $$
declare
  v_period_id uuid;
  v_line_id uuid;
  v_open_secs bigint := 0;
  v_open_amt numeric := 0;
  v_duty bigint;
  v_hours numeric;
  v_saves numeric;
  v_cnt int;
  v_adj numeric;
  v_total numeric;
begin
  insert into payout_periods (period_start, period_end, created_by, status)
  values (now(), now(), p_by, 'finalized')
  returning id into v_period_id;

  insert into payout_lines
    (period_id, member_id, duty_seconds, save_count, hours_amount, saves_amount,
     adjustments_amount, total_amount, settle_mode, note,
     paid_at, paid_by)
  values (v_period_id, p_member, 0, 0, 0, 0, 0, 0,
          case when p_paid then 'paid' else 'written_off' end, p_note,
          now(), p_by)
  returning id into v_line_id;

  -- drain the currently running shift without ending it
  select coalesce(sum(billable_seconds), 0), coalesce(sum(earned_amount), 0)
    into v_open_secs, v_open_amt
    from shifts where member_id = p_member and ended_at is null and payout_line_id is null;
  update shifts set billable_seconds = 0, earned_amount = 0
   where member_id = p_member and ended_at is null and payout_line_id is null;

  update shifts set payout_line_id = v_line_id
   where member_id = p_member and payout_line_id is null and ended_at is not null;
  update saves set payout_line_id = v_line_id
   where member_id = p_member and payout_line_id is null and status = 'confirmed';
  update adjustments set payout_line_id = v_line_id
   where member_id = p_member and payout_line_id is null;

  select coalesce(sum(billable_seconds), 0) + v_open_secs,
         coalesce(sum(earned_amount), 0) + v_open_amt
    into v_duty, v_hours
    from shifts where payout_line_id = v_line_id;
  select count(*), coalesce(sum(bonus_snapshot), 0)
    into v_cnt, v_saves from saves where payout_line_id = v_line_id;
  select coalesce(sum(amount), 0) into v_adj
    from adjustments where payout_line_id = v_line_id;

  v_total := round(v_hours) + round(v_saves) + round(v_adj);

  if v_duty = 0 and v_cnt = 0 and v_adj = 0 then
    delete from payout_lines where id = v_line_id;
    delete from payout_periods where id = v_period_id;
    return jsonb_build_object('error', 'nothing to settle');
  end if;

  update payout_lines
     set duty_seconds = v_duty,
         save_count = v_cnt,
         hours_amount = round(v_hours),
         saves_amount = round(v_saves),
         adjustments_amount = round(v_adj),
         total_amount = v_total
   where id = v_line_id;

  return jsonb_build_object('settled', v_total, 'line_id', v_line_id);
end;
$$;

-- batch payouts must claim adjustments too, or they'd be paid twice
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
  v_adj numeric;
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
      union
      select member_id from adjustments
       where payout_line_id is null and created_at <= p_end
    ) candidates
  loop
    insert into payout_lines
      (period_id, member_id, duty_seconds, save_count, hours_amount, saves_amount,
       adjustments_amount, total_amount)
    values (v_period_id, v_member, 0, 0, 0, 0, 0, 0)
    returning id into v_line_id;

    update shifts set payout_line_id = v_line_id
     where member_id = v_member and payout_line_id is null
       and ended_at is not null and ended_at <= p_end;
    update saves set payout_line_id = v_line_id
     where member_id = v_member and payout_line_id is null
       and status = 'confirmed' and detected_at <= p_end;
    update adjustments set payout_line_id = v_line_id
     where member_id = v_member and payout_line_id is null and created_at <= p_end;

    select coalesce(sum(billable_seconds), 0)::bigint, coalesce(sum(earned_amount), 0)
      into v_duty, v_hours
      from shifts where payout_line_id = v_line_id;
    select count(*), coalesce(sum(bonus_snapshot), 0)
      into v_save_count, v_saves_amt
      from saves where payout_line_id = v_line_id;
    select coalesce(sum(amount), 0) into v_adj
      from adjustments where payout_line_id = v_line_id;

    if v_duty = 0 and v_save_count = 0 and v_adj = 0 then
      delete from payout_lines where id = v_line_id;
    else
      update payout_lines
         set duty_seconds = v_duty,
             save_count = v_save_count,
             hours_amount = round(v_hours),
             saves_amount = round(v_saves_amt),
             adjustments_amount = round(v_adj),
             total_amount = round(v_hours) + round(v_saves_amt) + round(v_adj)
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

revoke all on function member_balances() from public;
revoke all on function settle_member(bigint, bigint, boolean, text) from public;
grant execute on function member_balances() to service_role;
grant execute on function settle_member(bigint, bigint, boolean, text) to service_role;
