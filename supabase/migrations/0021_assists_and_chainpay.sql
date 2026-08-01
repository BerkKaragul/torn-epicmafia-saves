-- War payout inputs: per-member assists and the chain-hour pay ($) they earned.
--
-- Assists come from Torn's chain reports (chained assists only — the public key
-- can't see assists made outside a chain). Chain-hour pay is the availability
-- pay already accrued into shifts.earned_amount, summed over the war window.

alter table chain_contributions add column assists int not null default 0;

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
           coalesce(w.ended_at, now()) as to_at
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
    select wc.member_id, sum(wc.war_hits) as war_hits
      from war_contributions wc
     where p_war is null or wc.torn_war_id = p_war
     group by wc.member_id
  ),
  svs as (
    select s.member_id, count(*) as saves
      from saves s
      cross join win
     where s.status = 'confirmed' and s.member_id is not null
       and (p_war is null or (s.detected_at >= win.from_at and s.detected_at <= win.to_at))
     group by s.member_id
  ),
  dut as (
    select sh.member_id,
           sum(sh.billable_seconds) as save_seconds,
           sum(sh.earned_amount) as chain_pay
      from shifts sh
      cross join win
     where p_war is null
        or (sh.started_at < win.to_at and coalesce(sh.ended_at, now()) > win.from_at)
     group by sh.member_id
  ),
  ids as (
    select member_id from chainhits
    union select member_id from warrep
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(w.war_hits, h.chain_war_hits, 0),
         coalesce(h.outside_hits, 0),
         coalesce(h.retaliations, 0),
         coalesce(h.assists, 0),
         round(coalesce(h.respect, 0), 2),
         coalesce(v.saves, 0),
         coalesce(d.save_seconds, 0)::bigint,
         round(coalesce(d.chain_pay, 0))
    from ids i
    left join chainhits h on h.member_id = i.member_id
    left join warrep w on w.member_id = i.member_id
    left join svs v on v.member_id = i.member_id
    left join dut d on d.member_id = i.member_id
    left join roster r on r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 7 desc, 3 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
