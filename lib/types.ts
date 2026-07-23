// Row shapes for the tables the app reads/writes (mirrors 0001_schema.sql).

export interface MemberRow {
  torn_id: number;
  name: string;
  api_key_ct: string | null;
  api_key_iv: string | null;
  key_access_level: string | null;
  key_valid: boolean;
  rate_limited_until: string | null;
  is_admin: boolean;
  admin_source: "auto" | "granted" | null;
  created_at: string;
  last_login_at: string | null;
}

export interface SettingsRow {
  id: 1;
  faction_id: number;
  hourly_rate: number;
  per_save_bonus: number;
  save_threshold_s: number;
  alert_threshold_s: number;
  poll_interval_s: number;
  idle_poll_interval_s: number;
  leader_id: number | null;
  co_leader_id: number | null;
  poller_member_id: number | null;
  saver_cap: number;
  save_bonus_mode: "flat" | "scaled";
  saving_enabled: boolean;
  milestone_warn_hits: number;
  updated_at: string;
}

export interface ShiftRow {
  id: string;
  member_id: number;
  started_at: string;
  planned_minutes: number | null;
  ended_at: string | null;
  end_reason: "manual" | "planned_elapsed" | "admin" | "key_invalid" | null;
  hourly_rate_snapshot: number;
  last_save_at: string | null;
  unavailable_state: string | null;
  payout_line_id: string | null;
}

export interface SaveRow {
  id: string;
  torn_chain_id: number;
  chain_count: number;
  window_start: string;
  window_end: string;
  timeout_at_window_start: number;
  status: "pending" | "confirmed" | "unattributed" | "not_a_save";
  member_id: number | null;
  expected_member_id: number | null;
  attack_id: number | null;
  attack_code: string | null;
  hit_registered_at: string | null;
  remaining_at_hit_s: number | null;
  bonus_snapshot: number | null;
  attempts: number;
  note: string | null;
  payout_line_id: string | null;
  detected_at: string;
}

export interface ChainRow {
  torn_chain_id: number;
  started_at: string;
  ended_at: string | null;
  end_reason: "completed" | "dropped" | "unknown" | null;
  max_current: number;
}

export interface PayoutPeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  created_by: number;
  created_at: string;
  status: "draft" | "finalized";
}

export interface PayoutLineRow {
  id: string;
  period_id: string;
  member_id: number;
  duty_seconds: number;
  save_count: number;
  hours_amount: number;
  saves_amount: number;
  total_amount: number;
  paid_at: string | null;
  paid_by: number | null;
  note: string | null;
}

export interface PushSubscriptionRow {
  id: string;
  member_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  failed_count: number;
  disabled: boolean;
}
