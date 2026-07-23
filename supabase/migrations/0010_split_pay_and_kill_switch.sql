-- 1) Master switch: admins can turn saving off entirely (between wars, etc).
--    Turning it off ends every active shift; nobody can enlist until it's back.
alter table settings add column saving_enabled boolean not null default true;

-- 2) Availability pay becomes an ACCRUAL. The per-saver rate now depends on how
--    many savers are active at that moment (1-2 → full rate each, 3+ → a pool of
--    double the rate split evenly), which changes as people join and leave, so
--    it can't be derived after the fact from a shift's start/end. The poller
--    credits each eligible saver every cycle instead — and only while a chain is
--    live, the saver can actually attack, and saving is enabled.
alter table shifts add column billable_seconds bigint not null default 0;
alter table shifts add column earned_amount numeric not null default 0;
alter table poller_state add column last_accrual_at timestamptz;

alter table shifts drop constraint shifts_end_reason_check;
alter table shifts add constraint shifts_end_reason_check
  check (end_reason in
    ('manual', 'planned_elapsed', 'admin', 'key_invalid', 'chain_dropped', 'saving_disabled'));

-- one round-trip per cycle: [{id, seconds, amount}, ...]
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
revoke all on function accrue_shifts(jsonb) from public;
grant execute on function accrue_shifts(jsonb) to service_role;

-- 3) Billing now just reads what was accrued.
create or replace function member_unpaid_duty(p_member bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'duty_seconds', coalesce(sum(billable_seconds), 0)::bigint,
    'hours_amount', round(coalesce(sum(earned_amount), 0))
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

    select coalesce(sum(billable_seconds), 0)::bigint, coalesce(sum(earned_amount), 0)
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

-- 4) Enlisting respects the master switch (still race-safe under the lock).
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

  insert into shifts (member_id, planned_minutes, hourly_rate_snapshot)
  values (p_member_id, p_planned_minutes, coalesce(v_hourly_rate, 0))
  returning * into v_shift;

  return jsonb_build_object('shift', to_jsonb(v_shift));
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_on_duty');
end;
$$;
