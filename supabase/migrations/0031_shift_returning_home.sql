-- Widen the shift end_reason CHECK to allow 'returning_home' (auto-ended when a
-- saver starts flying back to Torn). Additive: every existing row's end_reason
-- is already in the prior set, so validation passes instantly. Safe during a war.
alter table shifts drop constraint shifts_end_reason_check;
alter table shifts add constraint shifts_end_reason_check
  check (end_reason in
    ('manual', 'planned_elapsed', 'admin', 'key_invalid', 'chain_dropped', 'saving_disabled', 'returning_home'));
