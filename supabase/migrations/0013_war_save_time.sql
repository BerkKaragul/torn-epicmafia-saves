-- Add each member's total time on saver duty to the war report, alongside
-- their hits and saves. Duty time comes from the shifts that overlap the war
-- window (all shifts, paid or not — it's a contribution stat, not an amount).

-- adding an OUT column changes the return type, which requires a drop first
drop function if exists war_report(bigint);
create function war_report(p_war bigint)
returns table (
  member_id bigint,
  name text,
  war_hits bigint,
  outside_hits bigint,
  bonus_hits bigint,
  respect numeric,
  saves bigint,
  best_save_seconds numeric,
  save_seconds bigint
)
language sql
stable
as $$
  with win as (
    select coalesce(w.started_at, '-infinity'::timestamptz) as from_at,
           coalesce(w.ended_at, now()) as to_at
      from (select 1) x
      left join wars w on w.torn_war_id = p_war
  ),
  hits as (
    select cc.member_id,
           sum(cc.attacks_war) as war_hits,
           sum(cc.attacks_total - cc.attacks_war) as outside_hits,
           sum(cc.bonuses) as bonus_hits,
           sum(cc.respect) as respect
      from chain_contributions cc
      join chains c on c.torn_chain_id = cc.torn_chain_id
      cross join win
     where p_war is null
        or (c.started_at < win.to_at and coalesce(c.ended_at, now()) > win.from_at)
     group by cc.member_id
  ),
  svs as (
    select s.member_id,
           count(*) as saves,
           min(greatest(0, s.remaining_at_hit_s)) as best_save_seconds
      from saves s
      cross join win
     where s.status = 'confirmed' and s.member_id is not null
       and (p_war is null or (s.detected_at >= win.from_at and s.detected_at <= win.to_at))
     group by s.member_id
  ),
  dut as (
    select sh.member_id, sum(sh.billable_seconds) as save_seconds
      from shifts sh
      cross join win
     where p_war is null
        or (sh.started_at < win.to_at and coalesce(sh.ended_at, now()) > win.from_at)
     group by sh.member_id
  ),
  ids as (
    select member_id from hits
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(h.war_hits, 0),
         coalesce(h.outside_hits, 0),
         coalesce(h.bonus_hits, 0),
         round(coalesce(h.respect, 0), 2),
         coalesce(v.saves, 0),
         v.best_save_seconds,
         coalesce(d.save_seconds, 0)::bigint
    from ids i
    left join hits h on h.member_id = i.member_id
    left join svs v on v.member_id = i.member_id
    left join dut d on d.member_id = i.member_id
    left join roster r on r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 7 desc, 9 desc, 3 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
