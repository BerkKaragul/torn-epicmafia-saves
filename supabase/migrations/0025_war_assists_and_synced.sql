-- Count assists from faction attacks too (chain reports miss non-chain assists,
-- so members were under-paid on assists). Also add a per-war "retals_synced" flag
-- so that once an admin fetches from faction attacks, those counts become
-- authoritative for EVERYONE in that war (0 when a member isn't in the fetch)
-- instead of leaking the chain-derived numbers back in.

alter table war_retals add column assists int not null default 0;
alter table wars add column retals_synced boolean not null default false;

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
     group by cb.member_id
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
    union select member_id from wret
    union select member_id from bon
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(w.war_hits, h.chain_war_hits, 0),
         coalesce(h.outside_hits, 0),
         -- once fetched from faction attacks, those counts are authoritative for
         -- everyone (0 if absent); otherwise fall back to the chain-derived count
         case when win.retals_synced then coalesce(wr.retals, 0)
              else coalesce(wr.retals, h.retaliations, 0) end,
         case when win.retals_synced then coalesce(wr.assists, 0)
              else coalesce(wr.assists, h.assists, 0) end,
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
