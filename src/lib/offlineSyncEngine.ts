import { db, notifyLocalRealtimeChange, subscribeToLocalRealtime } from './db';
import { trySyncSingleEvent } from './dataService';
import { isSupabaseConfigured, supabase } from './supabase';
import type { FinishEvent } from '../types/domain';

export interface SyncQueueStats {
  isOnline: boolean;
  simulatedOffline: boolean;
  pendingCount: number;
  syncingCount: number;
  syncedCount: number;
  errorCount: number;
  retryAttempt: number;
  nextRetryAtMs: number | null;
  lastSyncedAtIso: string | null;
  isFlushing: boolean;
}

const SIM_OFFLINE_KEY = 'skol_crono_simulated_offline';

let simulatedOffline =
  typeof window !== 'undefined' && window.localStorage.getItem(SIM_OFFLINE_KEY) === 'true';

let retryAttempt = 0;
let nextRetryAtMs: number | null = null;
let lastSyncedAtIso: string | null = null;
let isFlushing = false;
let retryTimerId: number | null = null;

const listeners = new Set<(stats: SyncQueueStats) => void>();

export function isEffectivelyOnline(): boolean {
  if (simulatedOffline) return false;
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/**
 * Calcula el delay de reintento exponencial con jitter aleatorio:
 * delay = min(30000, 1000 * 2^attempt) + jitter(0..450ms)
 */
export function computeExponentialBackoffMs(attempt: number): number {
  const baseMs = 1000;
  const maxMs = 30000;
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const jitter = Math.floor(Math.random() * 450);
  return exp + jitter;
}

export async function getSyncQueueStats(): Promise<SyncQueueStats> {
  const allEvents = await db.finish_events.toArray();
  let pendingCount = 0;
  let syncingCount = 0;
  let syncedCount = 0;
  let errorCount = 0;

  for (const ev of allEvents) {
    if (ev.sync_state === 'syncing') {
      syncingCount++;
    } else if (ev.sync_state === 'synced') {
      syncedCount++;
    } else if (ev.last_sync_error) {
      errorCount++;
      pendingCount++;
    } else {
      pendingCount++;
    }
  }

  return {
    isOnline: isEffectivelyOnline(),
    simulatedOffline,
    pendingCount,
    syncingCount,
    syncedCount,
    errorCount,
    retryAttempt,
    nextRetryAtMs,
    lastSyncedAtIso,
    isFlushing,
  };
}

async function emitStats() {
  const stats = await getSyncQueueStats();
  listeners.forEach((cb) => cb(stats));
}

function clearRetryTimer() {
  if (retryTimerId !== null && typeof window !== 'undefined') {
    window.clearTimeout(retryTimerId);
    retryTimerId = null;
  }
  nextRetryAtMs = null;
}

function scheduleNextExponentialRetry() {
  clearRetryTimer();
  if (typeof window === 'undefined') return;

  const delayMs = computeExponentialBackoffMs(retryAttempt);
  nextRetryAtMs = Date.now() + delayMs;
  void emitStats();

  retryTimerId = window.setTimeout(() => {
    retryTimerId = null;
    nextRetryAtMs = null;
    void flushOfflineQueue();
  }, delayMs);
}

let activeFlushPromise: Promise<{ flushed: number; remaining: number }> | null = null;

/**
 * Procesa todos los eventos pendientes en IndexedDB en orden cronológico (ts_utc_ms ASC).
 * Si alguno falla o no hay red, programa el siguiente reintento exponencial.
 */
export async function flushOfflineQueue(): Promise<{
  flushed: number;
  remaining: number;
}> {
  if (activeFlushPromise) {
    return activeFlushPromise;
  }

  activeFlushPromise = (async () => {
    const allPending = (await db.finish_events.toArray())
      .filter((ev) => ev.sync_state !== 'synced')
      .sort((a, b) => a.ts_utc_ms - b.ts_utc_ms);

    if (allPending.length === 0) {
      retryAttempt = 0;
      clearRetryTimer();
      await emitStats();
      return { flushed: 0, remaining: 0 };
    }

    if (!isEffectivelyOnline()) {
      scheduleNextExponentialRetry();
      return { flushed: 0, remaining: allPending.length };
    }

    isFlushing = true;
    clearRetryTimer();
    await emitStats();

    let flushed = 0;
    let anyFailed = false;

    for (const ev of allPending) {
      if (!isEffectivelyOnline()) {
        anyFailed = true;
        break;
      }

      const ok = await syncEventWithOfflineAwareness(ev);
      if (ok) {
        flushed++;
      } else {
        anyFailed = true;
      }
    }

    isFlushing = false;

    if (flushed > 0) {
      lastSyncedAtIso = new Date().toISOString();
      notifyLocalRealtimeChange('finish_events');
    }

    const remaining = (await db.finish_events.toArray()).filter(
      (ev) => ev.sync_state !== 'synced'
    ).length;

    if (remaining > 0 || anyFailed) {
      retryAttempt++;
      scheduleNextExponentialRetry();
    } else {
      retryAttempt = 0;
      clearRetryTimer();
    }

    await emitStats();
    return { flushed, remaining };
  })();

  try {
    return await activeFlushPromise;
  } finally {
    activeFlushPromise = null;
  }
}

async function syncEventWithOfflineAwareness(ev: FinishEvent): Promise<boolean> {
  if (!isEffectivelyOnline()) {
    await db.finish_events.update(ev.id, {
      sync_state: 'pending',
      last_sync_error: 'Dispositivo sin conexión (en cola offline)',
    });
    return false;
  }

  if (!isSupabaseConfigured || !supabase) {
    const syncedIso = new Date().toISOString();
    await db.finish_events.update(ev.id, {
      sync_state: 'synced',
      synced_at: syncedIso,
      last_sync_error: null,
    });
    return true;
  }

  return trySyncSingleEvent(ev.id);
}

export function setSimulatedOfflineMode(enabled: boolean) {
  simulatedOffline = enabled;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SIM_OFFLINE_KEY, String(enabled));
  }
  if (!enabled) {
    retryAttempt = 0;
    void flushOfflineQueue();
  } else {
    void emitStats();
  }
}

export function getSimulatedOfflineMode(): boolean {
  return simulatedOffline;
}

let engineInitialized = false;

export function startOfflineSyncEngine() {
  if (engineInitialized || typeof window === 'undefined') return;
  engineInitialized = true;

  window.addEventListener('online', () => {
    retryAttempt = 0;
    void flushOfflineQueue();
  });

  window.addEventListener('offline', () => {
    void emitStats();
  });

  subscribeToLocalRealtime(() => {
    void emitStats();
  });

  // Ciclo periódico de seguridad cada 8 segundos
  window.setInterval(() => {
    if (isEffectivelyOnline() && !isFlushing && retryTimerId === null) {
      void flushOfflineQueue();
    } else {
      void emitStats();
    }
  }, 8000);

  void flushOfflineQueue();
}

export function subscribeSyncQueueStats(cb: (stats: SyncQueueStats) => void): () => void {
  startOfflineSyncEngine();
  listeners.add(cb);
  void getSyncQueueStats().then(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Exporta un backup completo en JSON de todas las tablas de IndexedDB
 * (carreras, categorías, inscriptos, largada, eventos de llegada y auditoría).
 */
export async function exportFullDatabaseBackupJson(): Promise<string> {
  const [races, categories, entries, profiles, raceStart, finishEvents, auditLog] =
    await Promise.all([
      db.races.toArray(),
      db.categories.toArray(),
      db.entries.toArray(),
      db.profiles.toArray(),
      db.race_start.toArray(),
      db.finish_events.toArray(),
      db.audit_log.toArray(),
    ]);

  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      version: 1,
      races,
      categories,
      entries,
      profiles: profiles.map((p) => ({ ...p, pin_code: undefined })), // Sin secretos en backup
      race_start: raceStart,
      finish_events: finishEvents,
      audit_log: auditLog,
    },
    null,
    2
  );
}
