-- Accurate war-hit counts from Torn's Ranked War Report.
--
-- Until now "war hits" came only from chain reports (chain_contributions.
-- attacks_war), so any war hit that wasn't part of a chain was invisible and
-- members were undercounted. Torn's ranked war report — available once a war
-- ends — gives the authoritative per-member war hit total, so we store it and
-- prefer it over the chain-derived estimate.

create table war_contributions (
  torn_war_id bigint not null references wars (torn_war_id) on delete cascade,
  member_id bigint not null,
  war_hits int not null default 0,
  war_score numeric not null default 0,
  primary key (torn_war_id, member_id)
);
create index war_contributions_member on war_contributions (member_id);
alter table war_contributions enable row level security;

-- the poller pulls each ended war's report exactly once
alter table wars add column report_synced boolean not null default false;

-- ── per-member breakdown, now with authoritative war hits ────────────────
-- war_hits: from the ranked war report when it's synced (post-war), else the
-- chain-derived estimate (so a still-running war keeps showing a live count).
-- Everything else (outside/bonus hits, respect, saves, duty time) is unchanged.
create or replace function war_report(p_war bigint)
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
  chainhits as (
    select cc.member_id,
           sum(cc.attacks_war) as chain_war_hits,
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
  warrep as (
    select wc.member_id, sum(wc.war_hits) as war_hits
      from war_contributions wc
     where p_war is null or wc.torn_war_id = p_war
     group by wc.member_id
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
    select member_id from chainhits
    union select member_id from warrep
    union select member_id from svs
    union select member_id from dut
  )
  select i.member_id,
         coalesce(r.name, m.name, 'id ' || i.member_id::text) as name,
         coalesce(w.war_hits, h.chain_war_hits, 0),
         coalesce(h.outside_hits, 0),
         coalesce(h.bonus_hits, 0),
         round(coalesce(h.respect, 0), 2),
         coalesce(v.saves, 0),
         v.best_save_seconds,
         coalesce(d.save_seconds, 0)::bigint
    from ids i
    left join chainhits h on h.member_id = i.member_id
    left join warrep w on w.member_id = i.member_id
    left join svs v on v.member_id = i.member_id
    left join dut d on d.member_id = i.member_id
    left join roster r on r.torn_id = i.member_id
    left join members m on m.torn_id = i.member_id
   order by 3 desc, 7 desc, 9 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
