-- Savers who physically can't attack (flying, hospital, jail) are paused:
-- they keep their shift and their place in the queue, but they're skipped for
-- the turn and earn nothing for that stretch.

create table unavailable_periods (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references members (torn_id),
  state text not null,                    -- 'Traveling' | 'Hospital' | 'Jail' | 'Federal'
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
-- one open period per member keeps the intervals disjoint, so billing can sum
create unique index one_open_unavailable on unavailable_periods (member_id)
  where ended_at is null;
create index unavailable_member on unavailable_periods (member_id, started_at);
alter table unavailable_periods enable row level security;

-- current state cache for the UI (null = available)
alter table shifts add column unavailable_state text;

-- how many hits before a chain bonus (25/50/100/250…) to start warning
alter table settings add column milestone_warn_hits int not null default 10;

-- chain-active seconds inside a window during which the member couldn't attack
create or replace function unavailable_chain_seconds(
  p_member bigint, p_start timestamptz, p_end timestamptz
) returns numeric
language sql
stable
as $$
  select coalesce(sum(greatest(0, chain_active_seconds(
    greatest(p_start, u.started_at),
    least(p_end, coalesce(u.ended_at, now()))
  ))), 0)
  from unavailable_periods u
  where u.member_id = p_member
    and u.started_at < p_end
    and coalesce(u.ended_at, now()) > p_start;
$$;

-- what a shift actually earns: chain-active time minus time they couldn't save
create or replace function shift_billable_seconds(
  p_member bigint, p_start timestamptz, p_end timestamptz
) returns numeric
language sql
stable
as $$
  select greatest(0,
    chain_active_seconds(p_start, p_end)
    - unavailable_chain_seconds(p_member, p_start, p_end));
$$;

create or replace function member_unpaid_duty(p_member bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'duty_seconds',
      coalesce(sum(shift_billable_seconds(member_id, started_at, coalesce(ended_at, now())))::bigint, 0),
    'hours_amount',
      round(coalesce(sum(
        shift_billable_seconds(member_id, started_at, coalesce(ended_at, now()))
        / 3600.0 * hourly_rate_snapshot
      ), 0))
  )
  from shifts
  where member_id = p_member and payout_line_id is null;
$$;

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

    select coalesce(sum(shift_billable_seconds(member_id, started_at, ended_at)), 0)::bigint,
           coalesce(sum(shift_billable_seconds(member_id, started_at, ended_at) / 3600.0
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

revoke all on function unavailable_chain_seconds(bigint, timestamptz, timestamptz) from public;
revoke all on function shift_billable_seconds(bigint, timestamptz, timestamptz) from public;
grant execute on function unavailable_chain_seconds(bigint, timestamptz, timestamptz) to service_role;
grant execute on function shift_billable_seconds(bigint, timestamptz, timestamptz) to service_role;
