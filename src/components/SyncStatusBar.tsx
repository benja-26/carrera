import React, { useEffect, useState } from 'react';
import {
  CloudUpload,
  CheckCircle2,
  RefreshCw,
  Wifi,
  WifiOff,
  Clock,
} from 'lucide-react';
import {
  flushOfflineQueue,
  setSimulatedOfflineMode,
  subscribeSyncQueueStats,
  type SyncQueueStats,
} from '../lib/offlineSyncEngine';

export const SyncStatusBar: React.FC = () => {
  const [stats, setStats] = useState<SyncQueueStats | null>(null);
  const [nextRetrySec, setNextRetrySec] = useState<number | null>(null);

  useEffect(() => {
    return subscribeSyncQueueStats((next) => {
      setStats(next);
    });
  }, []);

  useEffect(() => {
    if (!stats?.nextRetryAtMs) {
      setNextRetrySec(null);
      return;
    }
    const tick = () => {
      if (!stats.nextRetryAtMs) return;
      const diff = Math.max(0, Math.ceil((stats.nextRetryAtMs - Date.now()) / 1000));
      setNextRetrySec(diff);
    };
    tick();
    const id = window.setInterval(tick, 300);
    return () => window.clearInterval(id);
  }, [stats?.nextRetryAtMs]);

  if (!stats) return null;

  return (
    <div
      className={`rounded-2xl border px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2 ${
        !stats.isOnline
          ? 'bg-rose-950/60 border-rose-700/70 text-rose-100'
          : stats.pendingCount > 0
          ? 'bg-amber-950/50 border-amber-700/70 text-amber-100'
          : 'bg-slate-900/90 border-slate-800 text-slate-300'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-black uppercase ${
            stats.isOnline
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              : 'bg-rose-500 text-slate-950'
          }`}
        >
          {stats.isOnline ? (
            <Wifi className="w-3 h-3" />
          ) : (
            <WifiOff className="w-3 h-3" />
          )}
          {stats.isOnline
            ? 'Conexión Activa'
            : stats.simulatedOffline
            ? 'Offline (Simulado)'
            : 'Sin Señal (Cola Offline)'}
        </span>

        <span className="font-bold">
          Pendientes:{' '}
          <strong
            className={
              stats.pendingCount > 0 ? 'text-amber-300 font-black' : 'text-emerald-400'
            }
          >
            {stats.pendingCount}
          </strong>
        </span>

        <span className="text-slate-400">·</span>

        <span className="inline-flex items-center gap-1 text-slate-300">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>Sincronizados: {stats.syncedCount}</span>
        </span>

        {stats.pendingCount > 0 && nextRetrySec !== null && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950/80 border border-slate-700 text-[11px] font-mono text-amber-300">
            <Clock className="w-3 h-3" />
            <span>
              Backoff #{stats.retryAttempt + 1} en {nextRetrySec}s
            </span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 ml-auto">
        {stats.pendingCount > 0 && (
          <button
            type="button"
            disabled={stats.isFlushing || !stats.isOnline}
            onClick={() => void flushOfflineQueue()}
            className="px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-black text-[11px] flex items-center gap-1"
          >
            <CloudUpload className="w-3.5 h-3.5" />
            <span>{stats.isFlushing ? 'Sincronizando...' : 'Sincronizar Ahora'}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setSimulatedOfflineMode(!stats.simulatedOffline)}
          className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold flex items-center gap-1 transition ${
            stats.simulatedOffline
              ? 'bg-amber-500 text-slate-950 border-amber-400 font-black'
              : 'bg-slate-950 hover:bg-slate-800 text-slate-300 border-slate-800'
          }`}
          title="Permite simular un corte de señal 4G/WiFi para verificar que la cola offline en IndexedDB almacena todos los toques y los sincroniza al reconectar"
        >
          <RefreshCw className="w-3 h-3" />
          <span>
            {stats.simulatedOffline ? 'Reconectar Red' : 'Simular Corte Señal'}
          </span>
        </button>
      </div>
    </div>
  );
};
