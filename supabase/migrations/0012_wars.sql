-- War-scoped reporting. Wars, chains and saves are linked BY TIME rather than
-- by a stored id, so anything recorded before this migration (and anything
-- backfilled later) lands under the right war automatically.

create table wars (
  torn_war_id bigint primary key,
  opponent_id bigint,
  opponent_name text,
  started_at timestamptz not null,
  ended_at timestamptz,
  target int,
  winner_id bigint,
  our_score int not null default 0,
  their_score int not null default 0,
  updated_at timestamptz not null default now()
);
create index wars_window on wars (started_at desc);
alter table wars enable row level security;

-- every faction member's name, so war reports can name people who never
-- signed into ChainWatch (Torn's chain report gives ids only)
create table roster (
  torn_id bigint primary key,
  name text not null,
  updated_at timestamptz not null default now()
);
alter table roster enable row level security;

-- per-member contribution to a chain, straight from Torn's chain report
create table chain_contributions (
  torn_chain_id bigint not null references chains (torn_chain_id) on delete cascade,
  member_id bigint not null,
  attacks_total int not null default 0,
  attacks_war int not null default 0,
  attacks_overseas int not null default 0,
  retaliations int not null default 0,
  bonuses int not null default 0,
  respect numeric not null default 0,
  primary key (torn_chain_id, member_id)
);
create index chain_contributions_member on chain_contributions (member_id);
alter table chain_contributions enable row level security;

alter table chains add column report_synced boolean not null default false;

-- ── per-member breakdown for one war (or all-time when p_war is null) ────
-- War hits vs outside hits come from Torn's chain reports; saves come from
-- ChainWatch's own detection. Chains are attributed to a war by overlap.
create or replace function war_report(p_war bigint)
returns table (
  member_id bigint,
  name text,
  war_hits bigint,
  outside_hits bigint,
  bonus_hits bigint,
  respect numeric,
  saves bigint,
  best_save_seconds numeric
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
  )
  select coalesce(h.member_id, v.member_id) as member_id,
         coalesce(r.name, m.name, 'id ' || coalesce(h.member_id, v.member_id)::text) as name,
         coalesce(h.war_hits, 0),
         coalesce(h.outside_hits, 0),
         coalesce(h.bonus_hits, 0),
         round(coalesce(h.respect, 0), 2),
         coalesce(v.saves, 0),
         v.best_save_seconds
    from hits h
    full outer join svs v on v.member_id = h.member_id
    left join roster r on r.torn_id = coalesce(h.member_id, v.member_id)
    left join members m on m.torn_id = coalesce(h.member_id, v.member_id)
   order by 7 desc, 3 desc, 2;
$$;

revoke all on function war_report(bigint) from public;
grant execute on function war_report(bigint) to service_role;
