import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Edit3,
  Flag,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
} from 'lucide-react';
import type { Profile, Race, RaceStart } from '../types/domain';
import {
  formatDurationMs,
  formatTimeOfDayAr,
  getCorrectedNowMs,
} from '../lib/timeSync';
import {
  clearRaceTimesOnly,
  correctRaceStart,
  parsePausedElapsedMs,
  pauseRaceClock,
  resumeRaceClock,
  triggerRaceStart,
} from '../lib/dataService';
import { feedbackStartGun, feedbackUndoOrVoid } from '../lib/soundAndHaptics';

interface RaceStartBannerProps {
  race: Race;
  raceStart: RaceStart | null;
  profiles: Profile[];
  currentUser: Profile | null;
  onUpdated: () => Promise<void>;
  compact?: boolean;
}

const LiveElapsedClock: React.FC<{
  raceStart: RaceStart;
  pausedElapsedMs: number | null;
}> = React.memo(({ raceStart, pausedElapsedMs }) => {
  const isPaused = pausedElapsedMs !== null;
  const [elapsedMs, setElapsedMs] = useState<number>(() =>
    pausedElapsedMs !== null
      ? pausedElapsedMs
      : Math.max(0, getCorrectedNowMs() - raceStart.ts_utc_ms)
  );

  useEffect(() => {
    if (pausedElapsedMs !== null) {
      setElapsedMs(pausedElapsedMs);
      return;
    }
    const updateClock = () => {
      setElapsedMs(Math.max(0, getCorrectedNowMs() - raceStart.ts_utc_ms));
    };
    updateClock();
    const id = window.setInterval(updateClock, 120);
    return () => window.clearInterval(id);
  }, [raceStart.ts_utc_ms, pausedElapsedMs]);

  return (
    <span
      className={`font-mono text-2xl sm:text-3xl font-black tracking-tight ${
        isPaused ? 'text-amber-400' : 'text-emerald-400'
      }`}
    >
      {formatDurationMs(elapsedMs, true)}
    </span>
  );
});

export const RaceStartBanner: React.FC<RaceStartBannerProps> = ({
  race,
  raceStart: propRaceStart,
  profiles,
  currentUser,
  onUpdated,
  compact = false,
}) => {
  const isAdmin = currentUser?.role === 'admin' && !currentUser.revoked;

  const [optimisticStart, setOptimisticStart] = useState<RaceStart | null | undefined>(
    undefined
  );

  useEffect(() => {
    setOptimisticStart(undefined);
  }, [propRaceStart?.id, propRaceStart?.ts_utc_ms, propRaceStart?.reason]);

  const raceStart = optimisticStart !== undefined ? optimisticStart : propRaceStart;

  const pausedElapsedMs = parsePausedElapsedMs(raceStart);
  const isPaused = pausedElapsedMs !== null;

  const [step1Armed, setStep1Armed] = useState<boolean>(false);
  const [pauseArmed, setPauseArmed] = useState<boolean>(false);
  const [resetArmed, setResetArmed] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const step1ArmedAtRef = useRef<number>(0);
  const pauseArmedAtRef = useRef<number>(0);
  const resetArmedAtRef = useRef<number>(0);

  // Estado para modal de corrección manual
  const [showCorrectionModal, setShowCorrectionModal] = useState<boolean>(false);
  const [deltaSeconds, setDeltaSeconds] = useState<string>('0');
  const [manualIsoTime, setManualIsoTime] = useState<string>('');
  const [correctionMode, setCorrectionMode] = useState<'delta' | 'exact'>('delta');
  const [correctionReason, setCorrectionReason] = useState<string>('');

  // Desarmar paso 1 automáticamente después de 8 segundos si no se confirma el paso 2
  useEffect(() => {
    if (!step1Armed) return;
    const timer = window.setTimeout(() => setStep1Armed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [step1Armed]);

  useEffect(() => {
    if (!pauseArmed) return;
    const timer = window.setTimeout(() => setPauseArmed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [pauseArmed]);

  useEffect(() => {
    if (!resetArmed) return;
    const timer = window.setTimeout(() => setResetArmed(false), 8000);
    return () => window.clearTimeout(timer);
  }, [resetArmed]);

  const starterName = raceStart
    ? profiles.find((p) => p.id === raceStart.user_id)?.display_name || 'Admin'
    : null;

  const correctedByName =
    raceStart?.corrected_by
      ? profiles.find((p) => p.id === raceStart.corrected_by)?.display_name || 'Admin'
      : null;

  const handleArmStartStep1 = (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    step1ArmedAtRef.current = Date.now();
    setStep1Armed(true);
  };

  const handleConfirmStartStep2 = async (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!currentUser || !isAdmin || submitting) return;
    if (Date.now() - step1ArmedAtRef.current < 120) return;
    const exactStartTs = getCorrectedNowMs();
    const nowIso = new Date().toISOString();

    feedbackStartGun();
    setStep1Armed(false);
    setOptimisticStart({
      id: 'optimistic-start',
      race_id: race.id,
      ts_utc_ms: exactStartTs,
      user_id: currentUser.id,
      corrected_by: null,
      reason: null,
      created_at: nowIso,
      updated_at: nowIso,
    });

    setSubmitting(true);
    setError(null);
    try {
      const saved = await triggerRaceStart(race.id, currentUser.id, exactStartTs);
      setOptimisticStart(saved);
      await onUpdated();
    } catch (err) {
      setOptimisticStart(undefined);
      setError(err instanceof Error ? err.message : 'Error al registrar la largada');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTogglePauseConfirm = async (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!currentUser || !isAdmin || !raceStart || submitting) return;
    if (!pauseArmed) {
      pauseArmedAtRef.current = Date.now();
      setPauseArmed(true);
      setResetArmed(false);
      return;
    }
    if (Date.now() - pauseArmedAtRef.current < 120) return;

    feedbackUndoOrVoid();
    setPauseArmed(false);

    const nowIso = new Date().toISOString();
    if (isPaused) {
      const newTs =
        pausedElapsedMs !== null
          ? Math.round(getCorrectedNowMs() - pausedElapsedMs)
          : raceStart.ts_utc_ms;
      setOptimisticStart({
        ...raceStart,
        ts_utc_ms: newTs,
        corrected_by: currentUser.id,
        reason: null,
        updated_at: nowIso,
      });
    } else {
      const elapsed = Math.max(0, Math.round(getCorrectedNowMs() - raceStart.ts_utc_ms));
      setOptimisticStart({
        ...raceStart,
        corrected_by: currentUser.id,
        reason: `PAUSED:${elapsed}`,
        updated_at: nowIso,
      });
    }

    setSubmitting(true);
    setError(null);
    try {
      const updated = isPaused
        ? await resumeRaceClock(race.id, currentUser.id)
        : await pauseRaceClock(race.id, currentUser.id);
      setOptimisticStart(updated);
      await onUpdated();
    } catch (err) {
      setOptimisticStart(undefined);
      setError(err instanceof Error ? err.message : 'No se pudo pausar/reanudar el cronómetro');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetClockConfirm = async (e: React.PointerEvent | React.MouseEvent) => {
    e.preventDefault();
    if (!currentUser || !isAdmin || !raceStart || submitting) return;
    if (!resetArmed) {
      resetArmedAtRef.current = Date.now();
      setResetArmed(true);
      setPauseArmed(false);
      return;
    }
    if (Date.now() - resetArmedAtRef.current < 120) return;

    feedbackUndoOrVoid();
    setResetArmed(false);
    setOptimisticStart(null);

    setSubmitting(true);
    setError(null);
    try {
      await clearRaceTimesOnly(race.id, currentUser.id);
      await onUpdated();
    } catch (err) {
      setOptimisticStart(undefined);
      setError(err instanceof Error ? err.message : 'No se pudo reiniciar el cronómetro');
    } finally {
      setSubmitting(false);
    }
  };

  const openCorrection = () => {
    if (!raceStart) return;
    setDeltaSeconds('0');
    const d = new Date(raceStart.ts_utc_ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    setManualIsoTime(`${hh}:${mm}:${ss}.${ms}`);
    setCorrectionReason('');
    setError(null);
    setShowCorrectionModal(true);
  };

  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!raceStart || !currentUser) return;
    setError(null);

    let newTsMs = raceStart.ts_utc_ms;
    if (correctionMode === 'delta') {
      const sec = Number.parseFloat(deltaSeconds);
      if (!Number.isFinite(sec) || sec === 0) {
        setError('Ingresá un ajuste en segundos distinto de 0 (ej. -2.5 o +1.8).');
        return;
      }
      newTsMs = Math.round(raceStart.ts_utc_ms + sec * 1000);
    } else {
      const match = manualIsoTime
        .trim()
        .match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
      if (!match) {
        setError('Formato de hora inválido. Usá HH:MM:SS.mmm (ej. 09:00:00.000).');
        return;
      }
      const d = new Date(raceStart.ts_utc_ms);
      d.setHours(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number((match[4] || '0').padEnd(3, '0'))
      );
      newTsMs = d.getTime();
    }

    setSubmitting(true);
    try {
      await correctRaceStart(race.id, newTsMs, correctionReason, currentUser.id);
      setShowCorrectionModal(false);
      await onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo corregir la largada');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={`rounded-2xl border ${
        raceStart
          ? 'bg-slate-900/95 border-emerald-700/60'
          : 'bg-amber-950/30 border-amber-600/60'
      } ${compact ? 'p-2.5' : 'p-4'}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Reloj Oficial y Metadatos de Largada */}
        <div className="flex items-center gap-3">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
              raceStart
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
            }`}
          >
            {raceStart ? <Clock className="w-6 h-6" /> : <Flag className="w-6 h-6" />}
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                {raceStart
                  ? 'Tiempo Oficial de Carrera (Gun Time)'
                  : 'Largada Única (Punto A · 4K + 6K)'}
              </span>
              {isPaused && (
                <span className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 text-[10px] font-black uppercase tracking-wider animate-pulse">
                  EN PAUSA
                </span>
              )}
              {raceStart?.corrected_by && !isPaused && (
                <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">
                  Corregida por {correctedByName}
                </span>
              )}
            </div>

            {raceStart ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <LiveElapsedClock
                  raceStart={raceStart}
                  pausedElapsedMs={pausedElapsedMs}
                />
                <span className="text-xs text-slate-400">
                  {isPaused ? (
                    <strong className="text-amber-300">Cronómetro pausado por Admin</strong>
                  ) : (
                    <>
                      Largó a las{' '}
                      <strong className="text-slate-200 font-mono">
                        {formatTimeOfDayAr(raceStart.ts_utc_ms)}
                      </strong>{' '}
                      ({starterName})
                    </>
                  )}
                </span>
              </div>
            ) : (
              <div className="text-sm font-bold text-amber-200">
                Esperando disparo único de largada (Duplas 4K e Individuales 6K largan juntos)
              </div>
            )}
          </div>
        </div>

        {/* Acciones de Admin: LARGAR en 2 pasos, PAUSAR/REANUDAR, REINICIAR o Corregir Largada */}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {!raceStart ? (
              !step1Armed ? (
                <button
                  type="button"
                  onPointerDown={handleArmStartStep1}
                  className="touch-manipulation w-full sm:w-auto px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm uppercase tracking-wide flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition active:scale-95"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>LARGAR CARRERA (Paso 1/2)</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onPointerDown={handleConfirmStartStep2}
                    disabled={submitting}
                    className="touch-manipulation flex-1 sm:flex-initial px-5 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm uppercase tracking-wide flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/30 animate-pulse"
                  >
                    <CheckCircle2 className="w-5 h-5" />
                    <span>¡CONFIRMAR LARGADA YA! (Paso 2/2)</span>
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      setStep1Armed(false);
                    }}
                    className="touch-manipulation px-3 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-300"
                  >
                    Cancelar
                  </button>
                </div>
              )
            ) : (
              <>
                <button
                  type="button"
                  onPointerDown={handleTogglePauseConfirm}
                  disabled={submitting}
                  className={`touch-manipulation px-3.5 py-2.5 rounded-xl border text-xs font-black flex items-center gap-1.5 transition active:scale-95 ${
                    pauseArmed
                      ? 'bg-amber-500 border-amber-400 text-slate-950 animate-pulse shadow-md'
                      : isPaused
                      ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/50 text-emerald-300'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-amber-300'
                  }`}
                >
                  {isPaused ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5" />}
                  <span>
                    {pauseArmed
                      ? isPaused
                        ? '¿CONFIRMAR REANUDAR? (2/2)'
                        : '¿CONFIRMAR PAUSA? (2/2)'
                      : isPaused
                      ? 'Reanudar Crono'
                      : 'Pausar Crono'}
                  </span>
                </button>

                <button
                  type="button"
                  onPointerDown={handleResetClockConfirm}
                  disabled={submitting}
                  className={`touch-manipulation px-3.5 py-2.5 rounded-xl border text-xs font-black flex items-center gap-1.5 transition active:scale-95 ${
                    resetArmed
                      ? 'bg-rose-600 border-rose-400 text-white animate-pulse shadow-md'
                      : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-rose-300'
                  }`}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>{resetArmed ? '¿CONFIRMAR REINICIO A 00:00? (2/2)' : 'Reiniciar Crono'}</span>
                </button>

                <button
                  type="button"
                  onClick={openCorrection}
                  className="touch-manipulation px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-slate-300 flex items-center gap-1.5"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Corregir Hora</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {error && !showCorrectionModal && (
        <div className="mt-2 p-2.5 rounded-xl bg-rose-950 border border-rose-700 text-rose-200 text-xs font-semibold flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Modal de Corrección Manual de Hora de Largada (Solo Admin, auditado) */}
      {showCorrectionModal && raceStart && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveCorrection}
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-black text-base flex items-center gap-2 text-amber-400">
                <AlertTriangle className="w-5 h-5" />
                <span>Corrección Manual de Hora de Largada</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowCorrectionModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-1">
              <div className="text-slate-400">Hora de largada actual (UTC ms):</div>
              <div className="font-mono font-bold text-slate-100 text-sm">
                {formatTimeOfDayAr(raceStart.ts_utc_ms)} ({raceStart.ts_utc_ms})
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setCorrectionMode('delta')}
                className={`py-2 rounded-xl text-xs font-bold border ${
                  correctionMode === 'delta'
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                Ajustar por ± Segundos
              </button>
              <button
                type="button"
                onClick={() => setCorrectionMode('exact')}
                className={`py-2 rounded-xl text-xs font-bold border ${
                  correctionMode === 'exact'
                    ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                Ingresar Hora Exacta
              </button>
            </div>

            {correctionMode === 'delta' ? (
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Desplazamiento en segundos (ej. -3.5 si se tocó 3.5s tarde)
                </label>
                <input
                  type="number"
                  step="0.1"
                  required
                  value={deltaSeconds}
                  onChange={(e) => setDeltaSeconds(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-base font-mono font-black text-amber-400"
                />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Nueva Hora Exacta (HH:MM:SS.mmm)
                </label>
                <input
                  type="text"
                  required
                  value={manualIsoTime}
                  onChange={(e) => setManualIsoTime(e.target.value)}
                  placeholder="09:00:00.000"
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-base font-mono font-black text-amber-400"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">
                Motivo obligatorio de la corrección (se guarda en audit_log)
              </label>
              <textarea
                rows={2}
                required
                minLength={5}
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="Ej: Sincronización con bocina oficial en arco de largada (-2.0s)"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 p-2.5 text-xs"
              />
            </div>

            {error && (
              <div className="p-2.5 rounded-xl bg-rose-950 border border-rose-700 text-rose-200 text-xs font-bold">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCorrectionModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-xs font-bold"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-black"
              >
                Guardar y Auditar Corrección
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
