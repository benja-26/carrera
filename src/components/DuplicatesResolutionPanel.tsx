import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitCompare,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  Category,
  Entry,
  FinishEvent,
  Profile,
  Race,
  RaceStart,
} from '../types/domain';
import {
  adminResolveFinishEvent,
  assignBibToUnassignedEvent,
  recordFinishEvent,
} from '../lib/dataService';
import { formatDurationMs, formatTimeOfDayAr, getCorrectedNowMs } from '../lib/timeSync';

interface DuplicatesResolutionPanelProps {
  race: Race;
  raceStart: RaceStart | null;
  categories: Category[];
  entries: Entry[];
  profiles: Profile[];
  finishEvents: FinishEvent[];
  currentAdmin: Profile;
  onUpdated: () => Promise<void>;
  onNotify: (type: 'ok' | 'err', text: string) => void;
}

interface BibDuplicateGroup {
  bib: number;
  entry: Entry | undefined;
  category: Category | undefined;
  validEvent: FinishEvent | undefined;
  duplicateEvents: FinishEvent[];
  voidEvents: FinishEvent[];
  maxDeltaMs: number;
  hasHighDiscrepancy: boolean;
}

export const DuplicatesResolutionPanel: React.FC<DuplicatesResolutionPanelProps> = ({
  race,
  raceStart,
  categories,
  entries,
  profiles,
  finishEvents,
  currentAdmin,
  onUpdated,
  onNotify,
}) => {
  const [reasonByBib, setReasonByBib] = useState<Record<number, string>>({});
  const [assignInputs, setAssignInputs] = useState<Record<string, string>>({});
  const [simBib, setSimBib] = useState<number>(entries[0]?.bib || 100);
  const [simDeltaMs, setSimDeltaMs] = useState<number>(4500);

  const catMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );
  const entryByBib = useMemo(
    () => new Map(entries.map((e) => [e.bib, e])),
    [entries]
  );
  const profileById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p])),
    [profiles]
  );

  const { duplicateGroups, unassignedEvents } = useMemo(() => {
    const byBib = new Map<number, FinishEvent[]>();
    const unassigned: FinishEvent[] = [];

    for (const ev of finishEvents) {
      if (ev.status === 'unassigned' || ev.bib === null) {
        if (ev.status === 'unassigned') unassigned.push(ev);
        continue;
      }
      const list = byBib.get(ev.bib) || [];
      list.push(ev);
      byBib.set(ev.bib, list);
    }

    const groups: BibDuplicateGroup[] = [];
    for (const [bib, list] of byBib.entries()) {
      const sorted = list.slice().sort((a, b) => a.ts_utc_ms - b.ts_utc_ms);
      const validEvent = sorted.find((e) => e.status === 'valid');
      const duplicateEvents = sorted.filter((e) => e.status === 'duplicate');
      const voidEvents = sorted.filter((e) => e.status === 'void');

      if (duplicateEvents.length > 0) {
        const baseTs = validEvent?.ts_utc_ms ?? duplicateEvents[0].ts_utc_ms;
        let maxDeltaMs = 0;
        let hasHighDiscrepancy = false;

        for (const dup of duplicateEvents) {
          const delta = Math.abs(dup.ts_utc_ms - baseTs);
          if (delta > maxDeltaMs) maxDeltaMs = delta;
          if (dup.high_discrepancy || delta > race.duplicate_threshold_ms) {
            hasHighDiscrepancy = true;
          }
        }

        const entry = entryByBib.get(bib);
        const category = entry ? catMap.get(entry.category_id) : undefined;

        groups.push({
          bib,
          entry,
          category,
          validEvent,
          duplicateEvents,
          voidEvents,
          maxDeltaMs,
          hasHighDiscrepancy,
        });
      }
    }

    // Priorizar discrepancias altas arriba
    groups.sort((a, b) => {
      if (a.hasHighDiscrepancy !== b.hasHighDiscrepancy) {
        return a.hasHighDiscrepancy ? -1 : 1;
      }
      return b.maxDeltaMs - a.maxDeltaMs;
    });

    unassigned.sort((a, b) => a.ts_utc_ms - b.ts_utc_ms);

    return { duplicateGroups: groups, unassignedEvents: unassigned };
  }, [finishEvents, entryByBib, catMap, race.duplicate_threshold_ms]);

  const getReasonForBib = (bib: number, fallback: string): string => {
    const custom = (reasonByBib[bib] || '').trim();
    return custom.length >= 3 ? custom : fallback;
  };

  const handleConfirmEarliestAndVoidDuplicates = async (group: BibDuplicateGroup) => {
    try {
      const reason = getReasonForBib(
        group.bib,
        'Confirmado el registro más temprano; duplicados descartados por Admin'
      );
      for (const dup of group.duplicateEvents) {
        await adminResolveFinishEvent(dup.id, 'void', reason, currentAdmin.id);
      }
      await onUpdated();
      onNotify(
        'ok',
        `Dorsal #${group.bib}: se conservó el tiempo más temprano y se descartaron ${group.duplicateEvents.length} duplicado(s).`
      );
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'Error al resolver duplicados');
    }
  };

  const handlePromoteDuplicateToValid = async (bib: number, dupEvent: FinishEvent) => {
    try {
      const reason = getReasonForBib(
        bib,
        `Promovido registro del dispositivo ${dupEvent.device_id} como oficial por Admin`
      );
      await adminResolveFinishEvent(dupEvent.id, 'valid', reason, currentAdmin.id);
      await onUpdated();
      onNotify('ok', `Dorsal #${bib}: se promovió el nuevo registro como válido.`);
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'Error al promover registro');
    }
  };

  const handleVoidSingleEvent = async (bib: number, ev: FinishEvent) => {
    try {
      const reason = getReasonForBib(
        bib,
        `Registro del dispositivo ${ev.device_id} anulado por Admin`
      );
      await adminResolveFinishEvent(ev.id, 'void', reason, currentAdmin.id);
      await onUpdated();
      onNotify('ok', `Registro de dorsal #${bib} anulado con auditoría.`);
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'Error al anular registro');
    }
  };

  const handleSimulateSecondDeviceTap = async () => {
    try {
      const baseTs = getCorrectedNowMs();
      // Si el dorsal aún no tiene llegada, creamos primero la del Crono 01 y luego la del Crono 02
      const existingValid = finishEvents.find(
        (e) => e.bib === simBib && e.status === 'valid' && e.event_type === 'finish'
      );

      const tk1 = profiles.find((p) => p.role === 'timekeeper') || currentAdmin;
      const tk2 =
        profiles.find((p) => p.role === 'timekeeper' && p.id !== tk1.id) || currentAdmin;

      let firstTs = existingValid?.ts_utc_ms ?? baseTs;
      if (!existingValid) {
        await recordFinishEvent({
          race_id: race.id,
          event_type: 'finish',
          bib: simBib,
          ts_utc_ms: firstTs,
          clock_offset_ms: -12,
          device_id: 'cel-crono-01',
          user_id: tk1.id,
        });
      }

      await recordFinishEvent({
        race_id: race.id,
        event_type: 'finish',
        bib: simBib,
        ts_utc_ms: firstTs + simDeltaMs,
        clock_offset_ms: 18,
        device_id: 'cel-crono-02',
        user_id: tk2.id,
      });

      await onUpdated();
      onNotify(
        'ok',
        `Simulado doble toque para dorsal #${simBib} (diferencia +${simDeltaMs} ms entre dos celulares).`
      );
    } catch (err) {
      onNotify('err', err instanceof Error ? err.message : 'Error en simulación');
    }
  };

  const raceStartTs = raceStart?.ts_utc_ms ?? null;

  return (
    <div className="space-y-5">
      {/* Tarjetas de Resumen + Simulador de prueba */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-xs font-bold text-slate-400 uppercase">
            Dorsales con Duplicados Activos
          </div>
          <div className="text-3xl font-black text-amber-400 mt-1">
            {duplicateGroups.length}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            El más temprano queda como <code>valid</code> automáticamente; nada se borra.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-xs font-bold text-slate-400 uppercase">
            Con Alerta de Discrepancia (&gt; {race.duplicate_threshold_ms} ms)
          </div>
          <div className="text-3xl font-black text-rose-400 mt-1">
            {duplicateGroups.filter((g) => g.hasHighDiscrepancy).length}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Diferencia mayor a ±{(race.duplicate_threshold_ms / 1000).toFixed(1)}s entre
            cronometristas.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-xs font-bold text-slate-400 uppercase">
            Tiempos Modo B Sin Asignar
          </div>
          <div className="text-3xl font-black text-sky-400 mt-1">
            {unassignedEvents.length}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Capturados con el botón "LLEGÓ (sin número)" pendientes de dorsal.
          </p>
        </div>
      </div>

      {/* Herramienta rápida para probar duplicados entre 2 teléfonos */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs font-black uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" />
            <span>Generador de Duplicado de Prueba (2 Dispositivos)</span>
          </div>
          <p className="text-xs text-slate-400">
            Simulá que dos cronometristas distintos tocan el mismo dorsal con una
            diferencia cercana (ej. +600 ms) o con discrepancia alta (ej. +4500 ms).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={simBib}
            onChange={(e) => setSimBib(Number(e.target.value))}
            className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
          >
            {entries.slice(0, 30).map((e) => (
              <option key={e.id} value={e.bib}>
                #{e.bib} - {e.display_name}
              </option>
            ))}
          </select>

          <select
            value={simDeltaMs}
            onChange={(e) => setSimDeltaMs(Number(e.target.value))}
            className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
          >
            <option value={650}>+650 ms (Dentro de tolerancia ≤ 2s)</option>
            <option value={1400}>+1400 ms (Dentro de tolerancia ≤ 2s)</option>
            <option value={4500}>+4500 ms (Alerta Discrepancia Alta &gt; 2s)</option>
            <option value={-2800}>
              -2800 ms (Offline más temprano que reemplaza al válido)
            </option>
          </select>

          <button
            type="button"
            onClick={handleSimulateSecondDeviceTap}
            className="px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs shrink-0"
          >
            Simular 2° Toque
          </button>
        </div>
      </div>

      {/* Listado de Dorsales con Duplicados */}
      <div className="space-y-3">
        <h3 className="font-black text-base flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-amber-400" />
          <span>Panel de Resolución de Duplicados ({duplicateGroups.length})</span>
        </h3>

        {duplicateGroups.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-400">
            No hay registros duplicados pendientes de revisión en este momento.
          </div>
        ) : (
          duplicateGroups.map((group) => (
            <div
              key={group.bib}
              className={`bg-slate-900 border-2 rounded-2xl p-4 space-y-3 ${
                group.hasHighDiscrepancy
                  ? 'border-rose-600/80'
                  : 'border-amber-600/60'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <span
                    className="px-3 py-1.5 rounded-xl font-black text-lg text-white"
                    style={{
                      backgroundColor: group.category?.color || '#334155',
                    }}
                  >
                    #{group.bib}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-black text-base text-white">
                        {group.entry?.display_name || `Dorsal #${group.bib}`}
                      </h4>
                      {group.hasHighDiscrepancy ? (
                        <span className="px-2 py-0.5 rounded-full bg-rose-500 text-slate-950 text-[10px] font-black uppercase flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Discrepancia Alta (+{(group.maxDeltaMs / 1000).toFixed(2)}s)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-black uppercase">
                          Duplicado Cercano (+{group.maxDeltaMs} ms ≤ 2s)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {group.category?.name} ({group.category?.distance_km} km)
                      {group.entry?.members?.length
                        ? ` · Integrantes: ${group.entry.members.join(' + ')}`
                        : ''}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleConfirmEarliestAndVoidDuplicates(group)}
                  className="px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shrink-0"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Confirmar el Más Temprano y Descartar Duplicados</span>
                </button>
              </div>

              {/* Comparación de las tomas registradas para este dorsal */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {group.validEvent && (
                  <div className="p-3 rounded-xl bg-emerald-950/35 border border-emerald-600/60 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-black text-[10px] uppercase">
                        ✓ VÁLIDO ACTUAL (Más temprano)
                      </span>
                      <span className="font-mono text-[11px] text-slate-400">
                        {profileById.get(group.validEvent.user_id)?.display_name ||
                          'Staff'}{' '}
                        · {group.validEvent.device_id}
                      </span>
                    </div>

                    <div className="flex items-baseline justify-between">
                      <div className="text-xl font-mono font-black text-emerald-300">
                        {raceStartTs !== null
                          ? formatDurationMs(
                              group.validEvent.ts_utc_ms - raceStartTs,
                              true
                            )
                          : formatTimeOfDayAr(group.validEvent.ts_utc_ms)}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">
                        Reloj: {formatTimeOfDayAr(group.validEvent.ts_utc_ms)} (offset{' '}
                        {group.validEvent.clock_offset_ms}ms)
                      </div>
                    </div>

                    <div className="flex justify-end pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          handleVoidSingleEvent(group.bib, group.validEvent!)
                        }
                        className="px-2.5 py-1 rounded-lg bg-rose-950 hover:bg-rose-900 text-rose-200 font-bold text-[11px] flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Anular este y promover siguiente</span>
                      </button>
                    </div>
                  </div>
                )}

                {group.duplicateEvents.map((dup) => {
                  const deltaMs = group.validEvent
                    ? dup.ts_utc_ms - group.validEvent.ts_utc_ms
                    : 0;
                  return (
                    <div
                      key={dup.id}
                      className="p-3 rounded-xl bg-slate-950 border border-amber-700/60 space-y-2 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 font-black text-[10px] uppercase">
                          DUPLICADO ({deltaMs >= 0 ? `+${deltaMs}` : deltaMs} ms)
                        </span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {profileById.get(dup.user_id)?.display_name || 'Staff'} ·{' '}
                          {dup.device_id}
                        </span>
                      </div>

                      <div className="flex items-baseline justify-between">
                        <div className="text-xl font-mono font-black text-amber-300">
                          {raceStartTs !== null
                            ? formatDurationMs(dup.ts_utc_ms - raceStartTs, true)
                            : formatTimeOfDayAr(dup.ts_utc_ms)}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400">
                          Reloj: {formatTimeOfDayAr(dup.ts_utc_ms)} (offset{' '}
                          {dup.clock_offset_ms}ms)
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handlePromoteDuplicateToValid(group.bib, dup)}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px]"
                        >
                          Usar éste como Oficial
                        </button>
                        <button
                          type="button"
                          onClick={() => handleVoidSingleEvent(group.bib, dup)}
                          className="px-2.5 py-1 rounded-lg bg-rose-950 hover:bg-rose-900 text-rose-200 font-bold text-[11px]"
                        >
                          Descartar duplicado
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Campo opcional de motivo para auditoría */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  value={reasonByBib[group.bib] || ''}
                  onChange={(e) =>
                    setReasonByBib((prev) => ({
                      ...prev,
                      [group.bib]: e.target.value,
                    }))
                  }
                  placeholder="Motivo de resolución para audit_log (opcional, se autocompleta si lo dejás vacío)"
                  className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-1.5 text-xs"
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Tiempos en Modo B ("LLEGÓ sin número") pendientes de asignación */}
      {unassignedEvents.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h3 className="font-black text-base flex items-center gap-2 text-sky-400">
            <Zap className="w-5 h-5" />
            <span>
              Tiempos Modo B Sin Dorsal Asignado ({unassignedEvents.length})
            </span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {unassignedEvents.map((ev, idx) => (
              <div
                key={ev.id}
                className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-2 text-xs"
              >
                <div>
                  <div className="font-black text-amber-300">
                    Sin Número #{idx + 1} ·{' '}
                    {raceStartTs !== null
                      ? formatDurationMs(ev.ts_utc_ms - raceStartTs, true)
                      : formatTimeOfDayAr(ev.ts_utc_ms)}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Capturado por {profileById.get(ev.user_id)?.display_name || 'Staff'}{' '}
                    ({ev.device_id})
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    placeholder="Dorsal"
                    value={assignInputs[ev.id] || ''}
                    onChange={(e) =>
                      setAssignInputs((p) => ({ ...p, [ev.id]: e.target.value }))
                    }
                    className="w-20 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs font-black text-amber-400"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const bib = Number.parseInt(assignInputs[ev.id] || '', 10);
                      if (!Number.isFinite(bib)) {
                        onNotify('err', 'Ingresá un dorsal válido.');
                        return;
                      }
                      try {
                        await assignBibToUnassignedEvent(ev.id, bib, currentAdmin.id);
                        await onUpdated();
                        onNotify('ok', `Tiempo asignado al dorsal #${bib}.`);
                      } catch (err) {
                        onNotify(
                          'err',
                          err instanceof Error ? err.message : 'Error al asignar'
                        );
                      }
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-black text-xs"
                  >
                    Asignar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
