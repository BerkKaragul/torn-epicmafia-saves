-- Availability pay now accrues ONLY while a chain is actually live. A saver on
-- duty during dead peacetime (no chain) earns nothing for that gap; the moment
-- a chain is running they're paid again. Billable time = the overlap between a
-- shift's [start, end] window and the union of chain-active intervals. Chains
-- are sequential in Torn, so the `chains` rows are disjoint and a plain sum of
-- per-chain overlaps is exact. Cooldown sits after chains.ended_at, so it is
-- correctly unpaid. An active chain (ended_at null) is clamped to now().

create or replace function chain_active_seconds(p_start timestamptz, p_end timestamptz)
returns numeric
language sql
stable
as $$
  select coalesce(sum(greatest(0,
    extract(epoch from (
      least(p_end, coalesce(c.ended_at, now())) - greatest(p_start, c.started_at)
    ))
  )), 0)
  from chains c
  where c.started_at < p_end
    and coalesce(c.ended_at, now()) > p_start;
$$;

-- Live "owed to you" preview for one member (unpaid closed shifts + the active
-- one), valued at each shift's snapshotted rate but only for chain-active time.
create or replace function member_unpaid_duty(p_member bigint)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'duty_seconds',
      coalesce(sum(chain_active_seconds(started_at, coalesce(ended_at, now())))::bigint, 0),
    'hours_amount',
      round(coalesce(sum(
        chain_active_seconds(started_at, coalesce(ended_at, now())) / 3600.0 * hourly_rate_snapshot
      ), 0))
  )
  from shifts
  where member_id = p_member and payout_line_id is null;
$$;

-- Rewrite generate_payout: duty seconds/amount now count only chain-active time.
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

    -- only chain-active seconds within each claimed shift are billable
    select coalesce(sum(chain_active_seconds(started_at, ended_at)), 0)::bigint,
           coalesce(sum(chain_active_seconds(started_at, ended_at) / 3600.0
                        * hourly_rate_snapshot), 0)
      into v_duty, v_hours
      from shifts where payout_line_id = v_line_id;

    select count(*), coalesce(sum(bonus_snapshot), 0)
      into v_save_count, v_saves_amt
      from saves where payout_line_id = v_line_id;

    if v_duty = 0 and v_save_count = 0 then
      -- nothing billable (idled through peacetime, no saves): FK on delete
      -- set null releases the claimed shifts back to unpaid
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

revoke all on function chain_active_seconds(timestamptz, timestamptz) from public;
revoke all on function member_unpaid_duty(bigint) from public;
grant execute on function chain_active_seconds(timestamptz, timestamptz) to service_role;
grant execute on function member_unpaid_duty(bigint) to service_role;
