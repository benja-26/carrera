import Dexie, { type Table } from 'dexie';
import type {
  AuditLogEntry,
  Category,
  Entry,
  FinishEvent,
  Profile,
  Race,
  RaceStart,
} from '../types/domain';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_PROFILES,
  DEFAULT_RACE,
  generateDefaultEntries,
} from './defaultSeed';

export interface LoginAttemptLocal {
  id?: number;
  device_id: string;
  attempted_at_ms: number;
  success: boolean;
}

export class SkolRaceDB extends Dexie {
  races!: Table<Race, string>;
  categories!: Table<Category, string>;
  entries!: Table<Entry, string>;
  profiles!: Table<Profile, string>;
  race_start!: Table<RaceStart, string>;
  finish_events!: Table<FinishEvent, string>;
  audit_log!: Table<AuditLogEntry, string>;
  login_attempts!: Table<LoginAttemptLocal, number>;

  constructor() {
    super('SkolCronometrajeDB');

    this.version(1).stores({
      races: 'id, status',
      categories: 'id, race_id, slug, screen_group, sort_order',
      entries: 'id, race_id, category_id, [race_id+bib], bib, active',
      profiles: 'id, race_id, pin_code, role, revoked',
      race_start: 'id, race_id',
      finish_events:
        'id, race_id, [race_id+event_type+bib], bib, status, sync_state, ts_utc_ms, user_id, device_id',
      audit_log: 'id, race_id, created_at',
      login_attempts: '++id, device_id, attempted_at_ms',
    });
  }
}

export const db = new SkolRaceDB();

const broadcastChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('skol_crono_realtime')
    : null;

export function notifyLocalRealtimeChange(topic: string) {
  broadcastChannel?.postMessage({ topic, ts: Date.now() });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('skol-db-changed', { detail: { topic } }));
  }
}

export function subscribeToLocalRealtime(callback: () => void): () => void {
  const handler = () => callback();
  broadcastChannel?.addEventListener('message', handler);
  if (typeof window !== 'undefined') {
    window.addEventListener('skol-db-changed', handler);
  }
  return () => {
    broadcastChannel?.removeEventListener('message', handler);
    if (typeof window !== 'undefined') {
      window.removeEventListener('skol-db-changed', handler);
    }
  };
}

let seedPromise: Promise<void> | null = null;

export async function ensureLocalSeed(): Promise<void> {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    const raceCount = await db.races.count();
    if (raceCount === 0) {
      await db.transaction(
        'rw',
        [db.races, db.categories, db.entries, db.profiles],
        async () => {
          await db.races.put(DEFAULT_RACE);
          await db.categories.bulkPut(DEFAULT_CATEGORIES);
          await db.entries.bulkPut(generateDefaultEntries());
          await db.profiles.bulkPut(DEFAULT_PROFILES);
        }
      );
    }
  })();

  return seedPromise;
}
