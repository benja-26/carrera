export type UserRole = 'admin' | 'timekeeper';
export type RaceStatus = 'pending' | 'running' | 'finished';
export type EventStatus = 'valid' | 'duplicate' | 'void' | 'unassigned';
export type EventType = 'finish' | 'start_crossing';
export type RunnerStatus = 'registered' | 'running' | 'finished' | 'dns';

export interface ScreenGroup {
  id: number;
  title: string;
  subtitle: string;
}

export interface Race {
  id: string;
  name: string;
  location: string;
  race_date: string;
  status: RaceStatus;
  net_time_enabled: boolean;
  duplicate_threshold_ms: number;
  screen_groups: ScreenGroup[];
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  race_id: string;
  slug: string;
  name: string;
  short_name: string;
  distance_km: 4 | 6;
  is_pair: boolean;
  bib_range_start: number;
  bib_range_end: number;
  bib_step: number;
  color: string;
  screen_group: number;
  sort_order: number;
}

export interface Entry {
  id: string;
  race_id: string;
  category_id: string;
  bib: number;
  display_name: string;
  team_name: string | null;
  members: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  race_id: string | null;
  display_name: string;
  role: UserRole;
  pin_code: string | null;
  synthetic_email: string | null;
  assigned_screens: number[];
  revoked: boolean;
  created_at: string;
}

export interface RaceStart {
  id: string;
  race_id: string;
  ts_utc_ms: number;
  user_id: string;
  corrected_by: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinishEvent {
  id: string;
  race_id: string;
  event_type: EventType;
  bib: number | null;
  ts_utc_ms: number;
  clock_offset_ms: number;
  device_id: string;
  user_id: string;
  status: EventStatus;
  high_discrepancy: boolean;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  created_at: string;
  synced_at: string | null;
  sync_state?: 'pending' | 'syncing' | 'synced' | 'error';
  last_sync_error?: string | null;
}

export interface AuditLogEntry {
  id: string;
  race_id: string;
  actor_id: string;
  actor_name?: string;
  action: string;
  entity_table: string;
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface LiveResultRow {
  entry_id: string;
  race_id: string;
  race_name: string;
  race_status: RaceStatus;
  net_time_enabled: boolean;
  bib: number;
  display_name: string;
  team_name: string | null;
  members: string[];
  active: boolean;
  category_id: string;
  category_slug: string;
  category_name: string;
  category_short_name: string;
  distance_km: 4 | 6;
  is_pair: boolean;
  category_color: string;
  screen_group: number;
  race_start_ts_utc_ms: number | null;
  finish_event_id: string | null;
  finish_ts_utc_ms: number | null;
  start_crossing_ts_utc_ms: number | null;
  official_time_ms: number | null;
  net_time_ms: number | null;
  duplicate_count: number;
  has_high_discrepancy: boolean;
  runner_status: RunnerStatus;
  category_rank: number | null;
  distance_rank: number | null;
  overall_finish_order: number | null;
  category_gap_ms: number | null;
  distance_gap_ms: number | null;
}
