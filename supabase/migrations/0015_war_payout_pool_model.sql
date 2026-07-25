-- War payout is a POOL split, not per-unit rates. The admin enters a total
-- prize (e.g. 1b); the weights turn each stat into points (war hit 0.3, save
-- 0.4, …, needn't sum to 1); each member's share of the pool is their points
-- over the total points. Reseed the config into that shape.

update settings
   set war_payout_config = jsonb_build_object(
     'pool', 0,
     'warHit', 0.3,
     'outsideHit', 0.5,
     'bonusHit', 1.0,
     'save', 0.4,
     'duty', 0.2,
     'includeOutside', true,
     'includeDuty', true
   )
 where id = 1;
