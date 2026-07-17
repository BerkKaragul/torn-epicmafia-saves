-- Admin-configurable cap on simultaneous on-duty savers. 0 = unlimited.
-- Enforcement lives in start_shift() under an advisory lock so concurrent
-- enlist clicks can never oversubscribe the cap. Lowering the cap below the
-- current on-duty count does NOT kick anyone — it only blocks new starts
-- (admins can force-end shifts from the members table).

alter table settings add column saver_cap int not null default 0;

create or replace function start_shift(p_member_id bigint, p_planned_minutes int)
returns jsonb
language plpgsql
as $$
declare
  v_hourly_rate numeric;
  v_cap int;
  v_active int;
  v_shift shifts;
begin
  perform pg_advisory_xact_lock(783401);

  select hourly_rate, saver_cap into v_hourly_rate, v_cap from settings where id = 1;
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
revoke all on function start_shift(bigint, int) from public;
grant execute on function start_shift(bigint, int) to service_role;
