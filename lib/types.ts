// Row shapes for the tables the app reads/writes (mirrors 0001_schema.sql).

export interface FactionRow {
  faction_id: number;
  name: string;
  tag: string | null;
  created_at: string;
  subscription_expires_at: string | null;
  trial_granted_at: string | null;
  suspended: boolean;
  realtime_topic: string;
  widget_token: string;
}

export interface MemberRow {
  torn_id: number;
  faction_id: number;
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
  abroad_only: boolean;
  milestone_warn_hits: number;
  war_payout_config: unknown;
  updated_at: string;
}

export interface ShiftRow {
  id: string;
  faction_id: number;
  member_id: number;
  started_at: string;
  planned_minutes: number | null;
  ended_at: string | null;
  end_reason:
    | "manual"
    | "planned_elapsed"
    | "admin"
    | "key_invalid"
    | "chain_dropped"
    | "saving_disabled"
    | "returning_home"
    | "left_faction"
    | "subscription_expired"
    | null;
  hourly_rate_snapshot: number;
  last_save_at: string | null;
  unavailable_state: string | null;
  abroad: boolean;
  /** Country the saver is currently in (null = home / not abroad). */
  location: string | null;
  /** Where a flying saver is headed ("Torn" = returning home); null unless traveling. */
  travel_dest: string | null;
  /** When the poller first saw them enter Traveling (≈ departure); null unless traveling. */
  travel_started_at: string | null;
  /** Set when the saver taps "skip my turn" — pushes them to the back. */
  deprioritized_at: string | null;
  billable_seconds: number;
  earned_amount: number;
}

export interface SaveRow {
  id: string;
  faction_id: number;
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
  detected_at: string;
}

export interface ChainRow {
  faction_id: number;
  torn_chain_id: number;
  started_at: string;
  ended_at: string | null;
  end_reason: "completed" | "dropped" | "unknown" | null;
  max_current: number;
}

/**
 * One war's frozen final payout — what the Payouts page shows every member.
 * `lines` is a WarPayoutRow[] and `config` a WarPayoutConfig (see lib/warPayout).
 */
export interface WarPayoutSnapshotRow {
  faction_id: number;
  torn_war_id: number;
  config: unknown;
  totals: {
    prize: number;
    sumChain: number;
    sumRetal: number;
    distributed: number;
    grand: number;
    members: number;
  };
  lines: unknown;
  saved_by: number;
  saved_at: string;
}

export interface PlatformConfigRow {
  xanax_per_period: number | null;
  period_days: number;
  trial_days: number;
  xanax_item_id: number;
  vendor_torn_id: number | null;
  vendor_name: string | null;
  vendor_key_valid: boolean;
  receive_log_type_ids: number[];
  billing_cursor: number | null;
  last_billing_sweep_at: string | null;
  last_billing_error: string | null;
}

export interface PaymentRow {
  id: string;
  source: "torn_log" | "manual";
  torn_log_id: string | null;
  sender_id: number | null;
  sender_name: string | null;
  faction_id: number | null;
  quantity: number;
  seconds_credited: number;
  status: "applied" | "unmatched" | "ignored";
  note: string | null;
  received_at: string;
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
