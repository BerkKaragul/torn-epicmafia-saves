-- Saves are now credited to the TURN-HOLDER who actually spent energy, not to
-- whoever's hit happened to reset the timer.
--
-- expected_member_id = the rotation head at the moment the danger window
-- opened (captured when the save candidate is created). A save confirms only
-- if THAT member landed a successful hit committed while the timer was under
-- the threshold. If a teammate's war hit resets the timer instead, the save
-- goes 'unattributed' and the head keeps their turn (rotation does not
-- advance) — matching "keep him as the saver."

alter table saves add column expected_member_id bigint references members (torn_id);

-- "under 1 minute" is the save-counting window (alerts still fire earlier, at
-- alert_threshold_s, to give the saver lead time).
update settings set save_threshold_s = 60 where id = 1 and save_threshold_s = 90;
alter table settings alter column save_threshold_s set default 60;
