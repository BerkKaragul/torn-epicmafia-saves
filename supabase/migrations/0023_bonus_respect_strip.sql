-- Strip chain milestone-bonus respect from the payout respect.
--
-- The war score (authoritative total respect) includes the huge multiplier
-- respect from chain milestone hits (50th, 100th, 250th, 500th, 1000th, …). A
-- milestone hit is still just one hit, so that extra bonus respect shouldn't
-- inflate a member's total. For each milestone bonus a member landed we subtract
-- its respect and count it as a flat 10 instead. The 10th and 25th milestones are
-- left alone (chain establishment), so we only adjust chain_count >= 50.

-- one row per milestone bonus hit, from the chain report's `bonuses` array
create table chain_bonuses (
  torn_chain_id bigint not null references chains (torn_chain_id) on delete cascade,
  chain_count int not null,
  member_id bigint not null,
  respect numeric not null default 0,
  primary key (torn_chain_id, chain_count)
);
create index chain_bonuses_member on chain_bonuses (member_id);
alter table chain_bonuses enable row level security;

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
  bon as (
    -- milestone-bonus respect to strip (skip the 10th and 25th)
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
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(w.war_hits, h.chain_war_hits, 0),
         coalesce(h.outside_hits, 0),
         coalesce(h.retaliations, 0),
         coalesce(h.assists, 0),
         -- authoritative respect (war score, chain fallback) minus milestone
         -- bonus respect, with 10 counted back per stripped bonus hit
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
    left join chainhits h on h.member_id = i.member_id
    left join warrep w on w.member_id = i.member_id
    left join bon b on b.member_id = i.member_id
    left join svs v on v.member_id = i.member_id
    left join dut d on d.member_id = i.member_id
    left join roster r on r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 7 desc, 3 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
