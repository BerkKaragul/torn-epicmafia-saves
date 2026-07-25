-- Editable weights for the post-war payout calculator. A calculator only — it
-- doesn't move money; it turns each member's war-report stats into a suggested
-- total the bankers pay out. Seeded from the live save/hourly rates so it lines
-- up with what savers are already earning.

alter table settings add column war_payout_config jsonb not null default '{}'::jsonb;

update settings
   set war_payout_config = jsonb_build_object(
     'warHit', 0,
     'outsideHit', 0,
     'bonusHit', 0,
     'save', per_save_bonus,
     'hourly', hourly_rate,
     'includeOutside', true,
     'includeDuty', true
   )
 where id = 1;
