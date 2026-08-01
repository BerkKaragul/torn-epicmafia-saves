-- Respect must come from the ranked war report's per-member SCORE when the war
-- report exists — that's the authoritative figure. Summing respect out of the
-- individual chain reports was wrong. Fall back to the chain-summed respect only
-- while a war is still running (no report yet). Same rule already applies to war
-- hits. (Retals and assists are NOT in the ranked war report, so they always
-- come from the chain reports.)

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
    select wc.member_id,
           sum(wc.war_hits) as war_hits,
           sum(wc.war_score) as war_score
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
         -- authoritative respect = ranked war report score; chain respect only
         -- until the report exists
         round(coalesce(w.war_score, h.respect, 0), 2),
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
