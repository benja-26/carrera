import { isSupabaseConfigured, supabase } from './supabase';

export interface ClockSyncSample {
  rttMs: number;
  offsetMs: number;
  sampledAtMs: number;
}

export interface ClockSyncState {
  offsetMs: number;
  bestRttMs: number;
  sampleCount: number;
  lastSyncedAtMs: number;
  source: 'supabase-rpc' | 'local-monotonic';
}

const OFFSET_STORAGE_KEY = 'skol_crono_clock_offset_ms';

let currentSyncState: ClockSyncState = {
  offsetMs: loadPersistedOffset(),
  bestRttMs: 0,
  sampleCount: 0,
  lastSyncedAtMs: Date.now(),
  source: 'local-monotonic',
};

const listeners = new Set<(state: ClockSyncState) => void>();

function loadPersistedOffset(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(OFFSET_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function savePersistedOffset(offsetMs: number) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(OFFSET_STORAGE_KEY, String(Math.round(offsetMs)));
}

function notifyListeners() {
  listeners.forEach((fn) => fn(currentSyncState));
}

/**
 * Sincroniza el reloj local contra el servidor tomando N muestras (algoritmo tipo NTP):
 * Para cada muestra mide t0 (envío), tServer (hora UTC servidor), t1 (recepción).
 * Latencia RTT = t1 - t0.
 * Offset estimado = tServer - (t0 + RTT / 2).
 * Se conserva la muestra de MENOR latencia (RTT) por ser la menos afectada por jitter de red.
 */
export async function synchronizeServerClock(samplesCount = 5): Promise<ClockSyncState> {
  if (!isSupabaseConfigured || !supabase || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    currentSyncState = {
      ...currentSyncState,
      sampleCount: Math.max(1, currentSyncState.sampleCount),
      lastSyncedAtMs: Date.now(),
      source: 'local-monotonic',
    };
    notifyListeners();
    return currentSyncState;
  }

  const samples: ClockSyncSample[] = [];

  for (let i = 0; i < samplesCount; i++) {
    const t0 = Date.now();
    const perf0 = performance.now();
    try {
      const { data, error } = await supabase.rpc('get_server_time_ms');
      const perf1 = performance.now();
      const rttMs = Math.max(1, Math.round(perf1 - perf0));

      if (!error && typeof data === 'number') {
        const midpointClientMs = t0 + rttMs / 2;
        const offsetMs = Math.round(data - midpointClientMs);
        samples.push({
          rttMs,
          offsetMs,
          sampledAtMs: Date.now(),
        });
      }
    } catch {
      // Ignorar muestra fallida por microcorte
    }
  }

  if (samples.length > 0) {
    // Ordenar por menor latencia (RTT) y elegir la mejor muestra
    samples.sort((a, b) => a.rttMs - b.rttMs);
    const best = samples[0];

    currentSyncState = {
      offsetMs: best.offsetMs,
      bestRttMs: best.rttMs,
      sampleCount: samples.length,
      lastSyncedAtMs: best.sampledAtMs,
      source: 'supabase-rpc',
    };
    savePersistedOffset(best.offsetMs);
    notifyListeners();
  }

  return currentSyncState;
}

export function getClockOffsetMs(): number {
  return currentSyncState.offsetMs;
}

export function getClockSyncState(): ClockSyncState {
  return currentSyncState;
}

/**
 * Permite inyectar un offset simulado (usado en tests y simulación multi-dispositivo).
 */
export function setSimulatedClockOffsetMs(offsetMs: number) {
  currentSyncState = {
    offsetMs: Math.round(offsetMs),
    bestRttMs: 1,
    sampleCount: 5,
    lastSyncedAtMs: Date.now(),
    source: 'local-monotonic',
  };
  savePersistedOffset(currentSyncState.offsetMs);
  notifyListeners();
}

/**
 * Devuelve el timestamp actual en UTC (ms) corregido con el offset del servidor.
 */
export function getCorrectedNowMs(): number {
  return Math.round(Date.now() + currentSyncState.offsetMs);
}

export function subscribeClockSync(cb: (state: ClockSyncState) => void): () => void {
  listeners.add(cb);
  cb(currentSyncState);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Formatea una duración en milisegundos como MM:SS.d o HH:MM:SS.d
 */
export function formatDurationMs(ms: number | null | undefined, showTenths = true): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--';
  const negative = ms < 0;
  const absMs = Math.abs(Math.round(ms));

  const totalSeconds = Math.floor(absMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((absMs % 1000) / 100);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const prefix = negative ? '-' : '';

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return showTenths ? `${prefix}${hh}:${mm}:${ss}.${tenths}` : `${prefix}${hh}:${mm}:${ss}`;
  }

  return showTenths ? `${prefix}${mm}:${ss}.${tenths}` : `${prefix}${mm}:${ss}`;
}

export function formatTimeOfDayAr(tsUtcMs: number): string {
  const d = new Date(tsUtcMs);
  const base = d.toLocaleTimeString('es-AR', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const tenths = Math.floor((tsUtcMs % 1000) / 100);
  return `${base}.${tenths}`;
}
