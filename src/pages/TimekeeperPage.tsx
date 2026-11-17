import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Delete,
  Flag,
  HelpCircle,
  Info,
  KeyRound,
  RotateCcw,
  Search,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { RaceStartBanner } from '../components/RaceStartBanner';
import { SyncStatusBar } from '../components/SyncStatusBar';
import {
  assignBibToUnassignedEvent,
  getLocalRaceBundleFast,
  getRaceBundle,
  parsePausedElapsedMs,
  recordFinishEvent,
  startRealtimeRaceSync,
  undoFinishEventByLongPress,
  undoOwnFinishEvent,
  type RaceBundle,
} from '../lib/dataService';
import { subscribeToLocalRealtime } from '../lib/db';
import {
  feedbackFinishRecorded,
  feedbackUnassignedRecorded,
  feedbackUndoOrVoid,
} from '../lib/soundAndHaptics';
import {
  formatDurationMs,
  formatTimeOfDayAr,
  getClockOffsetMs,
  getCorrectedNowMs,
  subscribeClockSync,
  synchronizeServerClock,
  type ClockSyncState,
} from '../lib/timeSync';
import type { Category, Entry, EventType, FinishEvent } from '../types/domain';

interface UndoBannerState {
  event: FinishEvent;
  entryName: string;
  expiresAtMs: number;
}

export const TimekeeperPage: React.FC = () => {
  const { profile, deviceId } = useAuth();

  const [bundle, setBundle] = useState<RaceBundle | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeScreenId, setActiveScreenId] = useState<number>(1);
  const [captureType, setCaptureType] = useState<EventType>('finish');
  const [clockSync, setClockSync] = useState<ClockSyncState | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  // Estado del botón Deshacer (10 segundos)
  const [undoState, setUndoState] = useState<UndoBannerState | null>(null);
  const [undoRemainingSec, setUndoRemainingSec] = useState<number>(0);

  // Mensajes breves (toast)
  const [toast, setToast] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(
    null
  );

  // Modal de detalle / anulación por mantener presionado 3s (long-press)
  const [inspectedBib, setInspectedBib] = useState<number | null>(null);

  // Modal de "Buscar número" con teclado numérico
  const [showNumPadModal, setShowNumPadModal] = useState<boolean>(false);
  const [numPadInput, setNumPadInput] = useState<string>('');

  // Modal de Modo B: "Tiempos sin asignar"
  const [showUnassignedModal, setShowUnassignedModal] = useState<boolean>(false);
  const [selectedUnassignedId, setSelectedUnassignedId] = useState<string | null>(null);
  const [assignBibInput, setAssignBibInput] = useState<string>('');

  //Gestos de swipe horizontal, doble click y mantener presionado 3s (long-press)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef<boolean>(false);
  const [holdingBib, setHoldingBib] = useState<number | null>(null);
  const [armedBib, setArmedBib] = useState<number | null>(null);
  const armedBibRef = useRef<{ bib: number; armedAtMs: number } | null>(null);
  const armedBibTimerRef = useRef<number | null>(null);

  const showToast = useCallback((type: 'ok' | 'warn' | 'err', text: string) => {
    setToast({ type, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const loadLocalFast = useCallback(async () => {
    const data = await getLocalRaceBundleFast();
    setBundle(data);
    setLoading(false);
  }, []);

  const loadData = useCallback(async () => {
    const data = await getRaceBundle();
    setBundle(data);
    setLoading(false);
  }, []);

  // Posicionar inicialmente en la primera pantalla asignada al cronometrista
  useEffect(() => {
    if (profile?.assigned_screens?.length) {
      setActiveScreenId(profile.assigned_screens[0]);
    }
  }, [profile?.id]);

  // Sincronizar reloj con el servidor al abrir la app y suscribirse a cambios en tiempo real
  useEffect(() => {
    void loadData();
    void synchronizeServerClock(5);

    const unsubRemoteRealtime = startRealtimeRaceSync();
    const unsubRealtime = subscribeToLocalRealtime(() => {
      void loadLocalFast();
    });
    const unsubClock = subscribeClockSync((state) => {
      setClockSync(state);
    });

    const onOnline = () => {
      setIsOnline(true);
      void synchronizeServerClock(3);
    };
    const onOffline = () => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      unsubRemoteRealtime();
      unsubRealtime();
      unsubClock();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadData, loadLocalFast]);

  // Contador regresivo de 10 segundos para el botón "Deshacer"
  useEffect(() => {
    if (!undoState) {
      setUndoRemainingSec(0);
      return;
    }
    const tick = () => {
      const remMs = undoState.expiresAtMs - Date.now();
      if (remMs <= 0) {
        setUndoState(null);
        setUndoRemainingSec(0);
      } else {
        setUndoRemainingSec(Math.ceil(remMs / 1000));
      }
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [undoState]);

  // Mapas derivados para renderizado instantáneo
  const {
    screenGroups,
    currentScreenCategories,
    currentScreenEntries,
    validEventByBib,
    finishOrderByBib,
    unassignedEvents,
    deviceRecentEvents,
    pendingSyncCount,
    entryByBib,
    categoryById,
  } = useMemo(() => {
    if (!bundle) {
      return {
        screenGroups: [],
        currentScreenCategories: [] as Category[],
        currentScreenEntries: [] as Entry[],
        validEventByBib: new Map<number, FinishEvent>(),
        finishOrderByBib: new Map<number, number>(),
        unassignedEvents: [] as FinishEvent[],
        deviceRecentEvents: [] as FinishEvent[],
        pendingSyncCount: 0,
        entryByBib: new Map<number, Entry>(),
        categoryById: new Map<string, Category>(),
      };
    }

    const catMap = new Map(bundle.categories.map((c) => [c.id, c]));
    const entByBib = new Map(bundle.entries.map((e) => [e.bib, e]));

    const relevantEvents = bundle.finishEvents.filter(
      (ev) => ev.event_type === captureType
    );

    const validFinishes = relevantEvents
      .filter((ev) => ev.status === 'valid' && ev.bib !== null)
      .sort((a, b) => a.ts_utc_ms - b.ts_utc_ms);

    const valMap = new Map<number, FinishEvent>();
    const orderMap = new Map<number, number>();

    validFinishes.forEach((ev, idx) => {
      if (ev.bib !== null) {
        valMap.set(ev.bib, ev);
        orderMap.set(ev.bib, idx + 1);
      }
    });

    const unassigned = relevantEvents
      .filter((ev) => ev.status === 'unassigned')
      .sort((a, b) => a.ts_utc_ms - b.ts_utc_ms);

    const deviceEvents = bundle.finishEvents
      .filter((ev) => ev.device_id === deviceId && ev.status !== 'void')
      .sort((a, b) => b.ts_utc_ms - a.ts_utc_ms)
      .slice(0, 12);

    const pendingCount = bundle.finishEvents.filter(
      (ev) => ev.sync_state === 'pending' || ev.sync_state === 'syncing'
    ).length;

    const screenCats = bundle.categories.filter(
      (c) => c.screen_group === activeScreenId
    );
    const screenCatIds = new Set(screenCats.map((c) => c.id));

    const screenEntries = bundle.entries
      .filter((e) => e.active && screenCatIds.has(e.category_id))
      .sort((a, b) => a.bib - b.bib);

    return {
      screenGroups: bundle.race.screen_groups,
      currentScreenCategories: screenCats,
      currentScreenEntries: screenEntries,
      validEventByBib: valMap,
      finishOrderByBib: orderMap,
      unassignedEvents: unassigned,
      deviceRecentEvents: deviceEvents,
      pendingSyncCount: pendingCount,
      entryByBib: entByBib,
      categoryById: catMap,
    };
  }, [bundle, activeScreenId, captureType, deviceId]);

  const arrivedInCurrentScreenCount = useMemo(
    () =>
      currentScreenEntries.filter((e) => validEventByBib.has(e.bib)).length,
    [currentScreenEntries, validEventByBib]
  );

  const isClockPaused = parsePausedElapsedMs(bundle?.raceStart) !== null;
  const isRaceRunning = Boolean(bundle?.raceStart && !isClockPaused);

  // Registro con DOBLE CLICK / 2 TOQUES (ventana de 4s), bloqueo antes de largar y mantener presionado 3s para deshacer
  const handleSquarePointerDown = async (
    entry: Entry,
    e: React.PointerEvent<HTMLButtonElement>
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!profile || !bundle) return;

    // 1. Si la carrera todavía no se inició o está en pausa desde Administración, bloquear el toque
    if (!isRaceRunning) {
      showToast(
        'warn',
        isClockPaused
          ? 'El cronómetro está en pausa desde Administración. Reanudalo para registrar dorsales.'
          : 'La carrera todavía no fue iniciada desde Administración. Los dorsales se habilitan al largar.'
      );
      return;
    }

    const nowWallMs = Date.now();
    const exactCapturedTsMs = getCorrectedNowMs();
    const currentOffsetMs = getClockOffsetMs();

    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
    }

    // 2. Si el dorsal YA está registrado: mantener presionado 3 segundos (3000ms) abre la opción de Deshacer y que continúe el tiempo
    if (validEventByBib.has(entry.bib)) {
      setHoldingBib(entry.bib);
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        setHoldingBib(null);
        feedbackUndoOrVoid();
        setInspectedBib(entry.bib);
      }, 3000);
      return;
    }

    // 3. Si NO está registrado: 1° toque selecciona/arma el dorsal; 2° toque (hasta 4s después) detiene su tiempo al instante
    const currentArmed = armedBibRef.current;
    if (!currentArmed || currentArmed.bib !== entry.bib) {
      armedBibRef.current = { bib: entry.bib, armedAtMs: nowWallMs };
      setArmedBib(entry.bib);
      if (armedBibTimerRef.current) {
        window.clearTimeout(armedBibTimerRef.current);
      }
      armedBibTimerRef.current = window.setTimeout(() => {
        if (armedBibRef.current?.bib === entry.bib) {
          armedBibRef.current = null;
        }
        setArmedBib((prev) => (prev === entry.bib ? null : prev));
      }, 4000);
      return;
    }

    // Evitar rebote eléctrico fantasma menor a 30ms en pantallas táctiles
    if (nowWallMs - currentArmed.armedAtMs < 30) {
      return;
    }

    // Segundo toque confirmado -> Actualizar pantalla en 0ms y persistir en segundo plano
    if (armedBibTimerRef.current) {
      window.clearTimeout(armedBibTimerRef.current);
      armedBibTimerRef.current = null;
    }
    armedBibRef.current = null;
    setArmedBib(null);

    const eventId = crypto.randomUUID();
    const optimisticEvent: FinishEvent = {
      id: eventId,
      race_id: bundle.race.id,
      event_type: captureType,
      bib: entry.bib,
      ts_utc_ms: exactCapturedTsMs,
      clock_offset_ms: currentOffsetMs,
      device_id: deviceId,
      user_id: profile.id,
      status: 'valid',
      high_discrepancy: false,
      void_reason: null,
      voided_by: null,
      voided_at: null,
      assigned_by: null,
      assigned_at: null,
      created_at: new Date().toISOString(),
      synced_at: null,
      sync_state: 'pending',
    };

    feedbackFinishRecorded();

    setBundle((prev) =>
      prev
        ? {
            ...prev,
            finishEvents: [
              ...prev.finishEvents.filter((ev) => ev.id !== eventId),
              optimisticEvent,
            ],
          }
        : prev
    );

    setUndoState({
      event: optimisticEvent,
      entryName: entry.display_name,
      expiresAtMs: Date.now() + 8000,
    });

    try {
      const recorded = await recordFinishEvent({
        id: eventId,
        race_id: bundle.race.id,
        event_type: captureType,
        bib: entry.bib,
        ts_utc_ms: exactCapturedTsMs,
        clock_offset_ms: currentOffsetMs,
        device_id: deviceId,
        user_id: profile.id,
      });

      setBundle((prev) =>
        prev
          ? {
              ...prev,
              finishEvents: [
                ...prev.finishEvents.filter((ev) => ev.id !== recorded.id),
                recorded,
              ],
            }
          : prev
      );
    } catch (err) {
      showToast(
        'err',
        err instanceof Error ? err.message : 'No se pudo registrar el dorsal'
      );
    }
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setHoldingBib(null);
  };

  // Botón Deshacer rápido (8 segundos)
  const handleUndoLast = async () => {
    if (!undoState || !profile) return;
    try {
      feedbackUndoOrVoid();
      await undoOwnFinishEvent(undoState.event.id, deviceId, profile.id);
      const undoneBib = undoState.event.bib;
      setUndoState(null);
      await loadLocalFast();
      showToast('ok', `Registro de dorsal #${undoneBib} deshecho. El tiempo continúa.`);
    } catch (err) {
      showToast(
        'err',
        err instanceof Error ? err.message : 'Expiró el tiempo para deshacer'
      );
    }
  };

  // Modo B: "LLEGÓ (sin número)" capturado en pointerdown
  const handleModeBPointerDown = async (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!profile || !bundle) return;
    if (!isRaceRunning) {
      showToast(
        'warn',
        isClockPaused
          ? 'El cronómetro está en pausa desde Administración.'
          : 'La carrera todavía no fue iniciada desde Administración.'
      );
      return;
    }
    const exactCapturedTsMs = getCorrectedNowMs();
    const currentOffsetMs = getClockOffsetMs();

    try {
      feedbackUnassignedRecorded();
      const ev = await recordFinishEvent({
        race_id: bundle.race.id,
        event_type: captureType,
        bib: null,
        ts_utc_ms: exactCapturedTsMs,
        clock_offset_ms: currentOffsetMs,
        device_id: deviceId,
        user_id: profile.id,
      });
      await loadLocalFast();
      showToast(
        'ok',
        `Tiempo sin número capturado (${formatTimeOfDayAr(ev.ts_utc_ms)}). Asignalo en "Sin asignar".`
      );
    } catch (err) {
      showToast(
        'err',
        err instanceof Error ? err.message : 'Error al capturar tiempo sin número'
      );
    }
  };

  // Navegación por deslizamiento horizontal (Swipe) entre las 4 pantallas
  const handleTouchStartArea = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleTouchEndArea = (e: React.TouchEvent) => {
    if (!touchStartRef.current || !screenGroups.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    touchStartRef.current = null;

    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      const idx = screenGroups.findIndex((s) => s.id === activeScreenId);
      if (dx < 0 && idx < screenGroups.length - 1) {
        setActiveScreenId(screenGroups[idx + 1].id);
      } else if (dx > 0 && idx > 0) {
        setActiveScreenId(screenGroups[idx - 1].id);
      }
    }
  };

  // Registro desde el modal "Buscar número"
  const handleNumPadRegisterPointerDown = async (
    e: React.PointerEvent<HTMLButtonElement>
  ) => {
    e.preventDefault();
    if (!bundle || !profile) return;
    if (!isRaceRunning) {
      showToast('warn', 'La carrera todavía no fue iniciada desde Administración.');
      return;
    }
    const exactTs = getCorrectedNowMs();
    const bib = Number.parseInt(numPadInput, 10);
    const entry = entryByBib.get(bib);
    if (!entry) {
      showToast('err', `El dorsal #${bib} no existe en la carrera.`);
      return;
    }

    try {
      feedbackFinishRecorded();
      const recorded = await recordFinishEvent({
        race_id: bundle.race.id,
        event_type: captureType,
        bib,
        ts_utc_ms: exactTs,
        clock_offset_ms: getClockOffsetMs(),
        device_id: deviceId,
        user_id: profile.id,
      });

      setUndoState({
        event: recorded,
        entryName: entry.display_name,
        expiresAtMs: Date.now() + 8000,
      });
      setNumPadInput('');
      setShowNumPadModal(false);
      await loadLocalFast();
      showToast(
        recorded.status === 'duplicate' ? 'warn' : 'ok',
        recorded.status === 'duplicate'
          ? `Dorsal #${bib} guardado como DUPLICADO (ya tenía llegada previa).`
          : `Llegada de #${bib} (${entry.display_name}) registrada.`
      );
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Error al registrar');
    }
  };

  // Asignar dorsal a un evento de Modo B ("LLEGÓ sin número")
  const handleAssignBibToUnassigned = async (targetBib?: number) => {
    if (!profile || !selectedUnassignedId) return;
    const bib = targetBib ?? Number.parseInt(assignBibInput, 10);
    if (!Number.isFinite(bib) || bib <= 0) {
      showToast('err', 'Ingresá un número de pechera válido.');
      return;
    }

    try {
      feedbackFinishRecorded();
      const updated = await assignBibToUnassignedEvent(
        selectedUnassignedId,
        bib,
        profile.id
      );
      setAssignBibInput('');
      await loadLocalFast();
      const remaining = unassignedEvents.filter((u) => u.id !== selectedUnassignedId);
      setSelectedUnassignedId(remaining[0]?.id || null);
      showToast(
        'ok',
        `Tiempo asignado al dorsal #${bib} (${updated.status.toUpperCase()}).`
      );
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'No se pudo asignar el dorsal');
    }
  };

  if (loading || !bundle) {
    return (
      <div className="p-8 text-center text-slate-400 font-semibold">
        Cargando pantalla de cronometraje...
      </div>
    );
  }

  const raceStartTs = bundle.raceStart?.ts_utc_ms ?? null;
  const inspectedEntry = inspectedBib !== null ? entryByBib.get(inspectedBib) : null;
  const inspectedEvent = inspectedBib !== null ? validEventByBib.get(inspectedBib) : null;
  const inspectedCategory = inspectedEntry
    ? categoryById.get(inspectedEntry.category_id)
    : null;
  const numPadMatchedEntry = numPadInput
    ? entryByBib.get(Number.parseInt(numPadInput, 10))
    : undefined;

  return (
    <div className="max-w-5xl mx-auto pb-52 px-2.5 sm:px-4 pt-2 space-y-2.5 select-none">
      {/* 1. Cabecera compacta: Reloj de Largada + Botón LARGAR (si es admin) */}
      <RaceStartBanner
        race={bundle.race}
        raceStart={bundle.raceStart}
        profiles={bundle.profiles}
        currentUser={profile}
        onUpdated={loadLocalFast}
        compact
      />

      {/* 1.b Barra de Estado de Cola Offline y Sincronización con Backoff Exponencial */}
      <SyncStatusBar />

      {/* 2. Selector opcional de Tiempo Neto (solo si el Admin lo habilitó en la carrera) */}
      {bundle.race.net_time_enabled && (
        <div className="grid grid-cols-2 gap-2 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setCaptureType('finish')}
            className={`py-2 rounded-lg text-xs font-black uppercase flex items-center justify-center gap-1.5 transition ${
              captureType === 'finish'
                ? 'bg-emerald-500 text-slate-950'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Flag className="w-4 h-4" />
            <span>Llegada (Meta Oficial)</span>
          </button>
          <button
            type="button"
            onClick={() => setCaptureType('start_crossing')}
            className={`py-2 rounded-lg text-xs font-black uppercase flex items-center justify-center gap-1.5 transition ${
              captureType === 'start_crossing'
                ? 'bg-sky-500 text-slate-950'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Paso por Largada (Tiempo Neto)</span>
          </button>
        </div>
      )}

      {/* 3. Indicador superior de las 4 Pantallas (Pestañas) + Navegación Swipe */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-2 space-y-2">
        <div className="grid grid-cols-4 gap-1.5">
          {screenGroups.map((sg) => {
            const isActive = sg.id === activeScreenId;
            const isAssigned = profile?.assigned_screens?.includes(sg.id) ?? true;
            return (
              <button
                key={sg.id}
                type="button"
                onClick={() => setActiveScreenId(sg.id)}
                className={`px-2 py-2 rounded-xl text-left transition border relative ${
                  isActive
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20'
                    : isAssigned
                    ? 'bg-slate-950 text-slate-200 border-slate-800 hover:bg-slate-800'
                    : 'bg-slate-950/40 text-slate-500 border-slate-900'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-wider">
                    Pág {sg.id}
                  </span>
                  {profile?.assigned_screens?.[0] === sg.id && (
                    <span
                      className={`text-[9px] font-black px-1 rounded ${
                        isActive
                          ? 'bg-slate-950 text-amber-400'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      TUYA
                    </span>
                  )}
                </div>
                <div className="text-xs sm:text-sm font-black truncate mt-0.5">
                  {sg.title}
                </div>
              </button>
            );
          })}
        </div>

        {/* Leyenda de colores por categoría + Contador "Llegaron X / Y" */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-1 border-t border-slate-800/80">
          <div className="flex flex-wrap items-center gap-1.5">
            {currentScreenCategories.map((cat) => (
              <span
                key={cat.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-black text-white shadow-sm"
                style={{ backgroundColor: cat.color }}
              >
                <span className="w-2 h-2 rounded-full bg-white" />
                <span>{cat.name}</span>
                <span className="opacity-80 font-mono text-[10px]">
                  ({cat.bib_range_start}-{cat.bib_range_end})
                </span>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <span className="px-3 py-1 rounded-xl bg-slate-950 border border-slate-700 text-xs sm:text-sm font-black text-emerald-400">
              Llegaron {arrivedInCurrentScreenCount} / {currentScreenEntries.length}
            </span>
          </div>
        </div>
      </div>

      {/* Aviso Toast */}
      {toast && (
        <div
          className={`p-3 rounded-xl border text-xs sm:text-sm font-bold flex items-center justify-between shadow-lg ${
            toast.type === 'ok'
              ? 'bg-emerald-950/95 border-emerald-600 text-emerald-200'
              : toast.type === 'warn'
              ? 'bg-amber-950/95 border-amber-600 text-amber-200'
              : 'bg-rose-950/95 border-rose-600 text-rose-200'
          }`}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-3 text-xs underline"
          >
            OK
          </button>
        </div>
      )}

      {/* 4. Grilla Principal de CUADRADOS (Swipeable horizontalmente) */}
      <div
        onTouchStart={handleTouchStartArea}
        onTouchEnd={handleTouchEndArea}
        className="space-y-3"
      >
        {!isRaceRunning && (
          <div className="p-3.5 rounded-2xl bg-amber-500/15 border-2 border-amber-400/50 text-amber-300 text-xs sm:text-sm font-black flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
            <span>
              La carrera todavía no fue iniciada desde Administración. Los botones de dorsales se habilitarán automáticamente en cuanto se dispare la largada.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 px-1">
          <span className="flex items-center gap-1">
            <ChevronLeft className="w-3.5 h-3.5" />
            Deslizá para cambiar de pantalla · <strong>Doble click</strong> para registrar dorsal
            <ChevronRight className="w-3.5 h-3.5" />
          </span>
          <span>Mantené presionado <strong>3 seg</strong> un dorsal marcado para deshacer</span>
        </div>

        <div
          className={`grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-2.5 sm:gap-3 transition ${
            !isRaceRunning ? 'opacity-50 grayscale-[40%]' : ''
          }`}
        >
          {currentScreenEntries.map((entry) => {
            const cat = categoryById.get(entry.category_id);
            const validEvent = validEventByBib.get(entry.bib);
            const finishOrder = finishOrderByBib.get(entry.bib);
            const isRegistered = Boolean(validEvent);
            const isArmed = armedBib === entry.bib;
            const isHolding = holdingBib === entry.bib;

            const officialElapsedMs =
              validEvent && raceStartTs !== null
                ? validEvent.ts_utc_ms - raceStartTs
                : null;

            return (
              <button
                key={entry.id}
                type="button"
                onPointerDown={(e) => handleSquarePointerDown(entry, e)}
                onPointerUp={clearLongPressTimer}
                onPointerLeave={clearLongPressTimer}
                onPointerCancel={clearLongPressTimer}
                onContextMenu={(e) => {
                  e.preventDefault();
                }}
                style={
                  isRegistered
                    ? {
                        borderColor: isHolding ? '#B8F500' : cat?.color || '#475569',
                        backgroundColor: '#0F172A',
                      }
                    : {
                        backgroundColor: cat?.color || '#1D4ED8',
                      }
                }
                className={`touch-manipulation relative aspect-square rounded-2xl p-2 flex flex-col items-center justify-between transition select-none shadow-md ${
                  isRegistered
                    ? `border-2 opacity-80 text-slate-300 ${
                        isHolding ? 'ring-4 ring-amber-400 scale-95 animate-pulse' : ''
                      }`
                    : `dorsal-square-unregistered border-2 text-white active:scale-95 shadow-lg ${
                        isArmed
                          ? 'border-amber-400 ring-4 ring-amber-400 scale-[0.98]'
                          : 'border-white/25'
                      }`
                }`}
              >
                {/* Fila superior del cuadrado: Categoría corta o Posición de llegada */}
                <div className="w-full flex items-center justify-between text-[10px] font-black uppercase tracking-tight">
                  <span className="truncate max-w-[75%] opacity-90">
                    {cat?.short_name}
                  </span>
                  {isRegistered ? (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500 text-slate-950 font-black text-[11px]">
                      <Check className="w-3 h-3 stroke-[3]" />#{finishOrder}
                    </span>
                  ) : isArmed ? (
                    <span className="px-1.5 py-0.5 rounded bg-amber-400 text-slate-950 font-black text-[9px] animate-bounce">
                      2° CLICK
                    </span>
                  ) : (
                    <span className="opacity-75">{cat?.distance_km}K</span>
                  )}
                </div>

                {/* Número de pechera en tipografía ENORME */}
                <div
                  className={`font-black tracking-tighter leading-none ${
                    isRegistered
                      ? 'text-3xl sm:text-4xl text-emerald-400 line-through decoration-emerald-500/60'
                      : 'text-4xl sm:text-5xl text-white drop-shadow'
                  }`}
                >
                  {entry.bib}
                </div>

                {/* Fila inferior: Tiempo registrado o Nombre del equipo/atleta */}
                <div className="w-full text-center">
                  {isHolding ? (
                    <div className="text-[10px] font-black uppercase bg-amber-400 text-slate-950 rounded-lg py-0.5 px-1">
                      Mantené 3s...
                    </div>
                  ) : isRegistered && validEvent ? (
                    <div className="font-mono text-xs sm:text-sm font-black text-amber-300 bg-slate-950/90 rounded-lg py-0.5 px-1 border border-slate-800">
                      {officialElapsedMs !== null
                        ? formatDurationMs(officialElapsedMs, true)
                        : formatTimeOfDayAr(validEvent.ts_utc_ms)}
                    </div>
                  ) : isArmed ? (
                    <div className="text-[10px] font-black uppercase bg-amber-400 text-slate-950 rounded-lg py-0.5 px-1">
                      Tocá para parar
                    </div>
                  ) : (
                    <div className="text-[11px] font-bold truncate opacity-95 px-0.5">
                      {entry.display_name}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 5. Lista de Últimos Registros de este Dispositivo + Estado de Sincronización */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2.5 mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs sm:text-sm font-black">
              Últimos Registros de Este Celular ({deviceRecentEvents.length})
            </h3>
          </div>

          <div className="flex items-center gap-2 text-[11px] font-bold">
            <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-300 font-mono">
              Offset: {clockSync ? `${clockSync.offsetMs >= 0 ? '+' : ''}${clockSync.offsetMs} ms` : '0 ms'}
            </span>
            <span
              className={`px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                pendingSyncCount > 0
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              }`}
            >
              {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {pendingSyncCount > 0
                ? `${pendingSyncCount} Pendientes`
                : 'Todo Sincronizado'}
            </span>
          </div>
        </div>

        {deviceRecentEvents.length === 0 ? (
          <p className="text-xs text-slate-500 py-2 text-center">
            Todavía no registraste llegadas desde este dispositivo.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-44 overflow-y-auto">
            {deviceRecentEvents.map((ev) => {
              const entry = ev.bib ? entryByBib.get(ev.bib) : undefined;
              const elapsed =
                raceStartTs !== null ? ev.ts_utc_ms - raceStartTs : null;
              return (
                <div
                  key={ev.id}
                  onClick={() => {
                    if (ev.bib !== null) {
                      setInspectedBib(ev.bib);
                    } else {
                      setSelectedUnassignedId(ev.id);
                      setShowUnassignedModal(true);
                    }
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs cursor-pointer hover:border-slate-700"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded font-black ${
                        ev.bib === null
                          ? 'bg-amber-500 text-slate-950'
                          : ev.status === 'duplicate'
                          ? 'bg-rose-900 text-rose-200'
                          : 'bg-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {ev.bib !== null ? `#${ev.bib}` : 'SIN N°'}
                    </span>
                    <span className="truncate font-semibold text-slate-200">
                      {entry ? entry.display_name : 'Tocar para asignar dorsal'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono font-bold text-amber-300">
                      {elapsed !== null
                        ? formatDurationMs(elapsed, true)
                        : formatTimeOfDayAr(ev.ts_utc_ms)}
                    </span>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        ev.sync_state === 'synced' ? 'bg-emerald-400' : 'bg-amber-400'
                      }`}
                      title={
                        ev.sync_state === 'synced' ? 'Sincronizado' : 'Pendiente en cola'
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 6. Barra Flotante de "Deshacer (10s)" + Barra Inferior de Uso con Una Mano (Modo B + Buscar N°) */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur border-t border-slate-800 px-2.5 pt-2.5 pb-14 sm:pb-12 space-y-2">
        <div className="max-w-5xl mx-auto space-y-2">
          {/* Botón Deshacer visible durante 10 segundos tras cada toque */}
          {undoState && undoRemainingSec > 0 && (
            <div className="bg-amber-500 text-slate-950 rounded-xl px-3.5 py-2.5 flex items-center justify-between shadow-lg">
              <div className="text-xs sm:text-sm font-black truncate pr-2">
                Registrado #{undoState.event.bib} ({undoState.entryName})
              </div>
              <button
                type="button"
                onClick={handleUndoLast}
                className="px-3.5 py-1.5 rounded-lg bg-slate-950 text-amber-400 font-black text-xs uppercase flex items-center gap-1.5 shrink-0 active:scale-95"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Deshacer ({undoRemainingSec}s)</span>
              </button>
            </div>
          )}

          {/* Controles Principales Inferiores: Modo B Gigante + Sin Asignar + Buscar Número */}
          <div className="grid grid-cols-12 gap-2">
            {/* Botón Gigante Modo B: "LLEGÓ (sin número)" */}
            <button
              type="button"
              onPointerDown={handleModeBPointerDown}
              className="col-span-6 sm:col-span-6 h-14 rounded-2xl bg-amber-500 hover:bg-amber-400 active:bg-amber-300 text-slate-950 font-black text-xs sm:text-sm uppercase tracking-tight flex items-center justify-center gap-1.5 shadow-lg shadow-amber-500/20 active:scale-95 px-2"
            >
              <Zap className="w-5 h-5 fill-current shrink-0" />
              <div className="text-left leading-tight">
                <div>LLEGÓ (SIN NÚMERO)</div>
                <div className="text-[10px] font-bold opacity-80">
                  Modo B · Captura al instante
                </div>
              </div>
            </button>

            {/* Botón Cola de "Sin asignar (N)" */}
            <button
              type="button"
              onClick={() => {
                setSelectedUnassignedId(unassignedEvents[0]?.id || null);
                setShowUnassignedModal(true);
              }}
              className={`col-span-3 sm:col-span-3 h-14 rounded-2xl border font-black text-xs flex flex-col items-center justify-center transition ${
                unassignedEvents.length > 0
                  ? 'bg-rose-950/90 border-rose-600 text-rose-200 animate-pulse'
                  : 'bg-slate-900 border-slate-700 text-slate-300'
              }`}
            >
              <span className="text-base font-black">{unassignedEvents.length}</span>
              <span className="text-[10px] uppercase">Sin Asignar</span>
            </button>

            {/* Botón "Buscar número" con teclado numérico */}
            <button
              type="button"
              onClick={() => {
                setNumPadInput('');
                setShowNumPadModal(true);
              }}
              className="col-span-3 sm:col-span-3 h-14 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-sky-400 font-black text-xs flex flex-col items-center justify-center gap-0.5"
            >
              <Search className="w-4 h-4" />
              <span className="text-[10px] uppercase">Buscar N°</span>
            </button>
          </div>
        </div>
      </div>

      {/* =====================================================================
          MODAL 1: DETALLE / ANULAR (Al mantener presionado un cuadrado)
      ===================================================================== */}
      {inspectedBib !== null && inspectedEntry && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <span
                  className="px-3.5 py-2 rounded-xl font-black text-2xl text-white"
                  style={{ backgroundColor: inspectedCategory?.color || '#1D4ED8' }}
                >
                  #{inspectedEntry.bib}
                </span>
                <div>
                  <div className="text-xs font-bold uppercase text-amber-400">
                    {inspectedCategory?.name} ({inspectedCategory?.distance_km} km)
                  </div>
                  <h3 className="text-lg font-black text-white">
                    {inspectedEntry.display_name}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInspectedBib(null)}
                className="text-slate-400 hover:text-white text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {inspectedEntry.members.length > 0 && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs">
                <div className="text-slate-400 font-semibold mb-1">
                  Integrantes de la Dupla:
                </div>
                <div className="font-bold text-slate-100">
                  1. {inspectedEntry.members[0]} · 2. {inspectedEntry.members[1]}
                </div>
              </div>
            )}

            {inspectedEvent ? (
              <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-700/60 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-emerald-300 font-bold uppercase">
                    ✓ Tiempo Registrado (#{finishOrderByBib.get(inspectedEntry.bib)})
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    {inspectedEvent.sync_state === 'synced'
                      ? 'Sincronizado'
                      : 'Pendiente de sync'}
                  </span>
                </div>
                <div className="text-2xl font-mono font-black text-white">
                  {raceStartTs !== null
                    ? formatDurationMs(inspectedEvent.ts_utc_ms - raceStartTs, true)
                    : formatTimeOfDayAr(inspectedEvent.ts_utc_ms)}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">
                  Hora reloj: {formatTimeOfDayAr(inspectedEvent.ts_utc_ms)} · Offset:{' '}
                  {inspectedEvent.clock_offset_ms}ms · Disp: {inspectedEvent.device_id}
                </div>

                {/* Botón principal tras mantener presionado 3 segundos: Deshacer registro y que continúe el tiempo */}
                {profile && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        feedbackUndoOrVoid();
                        await undoFinishEventByLongPress(inspectedEvent.id, profile.id);
                        setInspectedBib(null);
                        setUndoState(null);
                        await loadLocalFast();
                        showToast(
                          'ok',
                          `Dorsal #${inspectedEntry.bib} deshecho. El cronómetro continúa corriendo.`
                        );
                      } catch (err) {
                        showToast(
                          'err',
                          err instanceof Error ? err.message : 'Error al deshacer'
                        );
                      }
                    }}
                    className="w-full mt-3 py-3 rounded-xl bg-amber-400 hover:bg-amber-500 text-slate-950 font-black text-xs sm:text-sm uppercase flex items-center justify-center gap-2 shadow-lg"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Deshacer registro y que continúe el tiempo</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-400">
                Este dorsal aún no registra paso por la línea.
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setInspectedBib(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-xs font-bold"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 2: BUSCAR NÚMERO CON TECLADO NUMÉRICO
      ===================================================================== */}
      {showNumPadModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-base">Buscar y Registrar N° de Pechera</h3>
              <button
                type="button"
                onClick={() => setShowNumPadModal(false)}
                className="text-slate-400 hover:text-white text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="bg-slate-950 border border-slate-700 rounded-xl p-3 text-center">
              <div className="text-3xl font-black font-mono text-amber-400 tracking-wider">
                {numPadInput ? `#${numPadInput}` : '---'}
              </div>
              <div className="text-xs font-bold mt-1 h-4">
                {numPadMatchedEntry ? (
                  <span className="text-emerald-400">
                    {numPadMatchedEntry.display_name} (
                    {categoryById.get(numPadMatchedEntry.category_id)?.short_name})
                  </span>
                ) : numPadInput ? (
                  <span className="text-rose-400">Dorsal no encontrado</span>
                ) : (
                  <span className="text-slate-500">Ingresá el número de dorsal</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setNumPadInput((p) => (p + d).slice(0, 5))}
                  className="h-14 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-2xl font-black"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setNumPadInput('')}
                className="h-14 rounded-xl bg-slate-950 text-xs font-bold uppercase text-slate-400 border border-slate-800"
              >
                Limpiar
              </button>
              <button
                type="button"
                onClick={() => setNumPadInput((p) => (p + '0').slice(0, 5))}
                className="h-14 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-2xl font-black"
              >
                0
              </button>
              <button
                type="button"
                onClick={() => setNumPadInput((p) => p.slice(0, -1))}
                className="h-14 rounded-xl bg-slate-950 flex items-center justify-center border border-slate-800"
              >
                <Delete className="w-5 h-5" />
              </button>
            </div>

            <button
              type="button"
              disabled={!numPadMatchedEntry}
              onPointerDown={handleNumPadRegisterPointerDown}
              className="w-full h-14 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 font-black text-base uppercase"
            >
              Registrar Llegada Ahora
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 3: COLA DE MODO B ("TIEMPOS SIN ASIGNAR")
      ===================================================================== */}
      {showUnassignedModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-base flex items-center gap-2 text-amber-400">
                <Zap className="w-5 h-5" />
                <span>Modo B · Tiempos Sin Asignar ({unassignedEvents.length})</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowUnassignedModal(false)}
                className="text-slate-400 hover:text-white text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {unassignedEvents.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">
                No hay tiempos pendientes de asignación de dorsal.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="text-xs text-slate-400">
                  1. Seleccioná el instante capturado y 2. Escribí o tocá el número de
                  pechera correspondiente:
                </div>

                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {unassignedEvents.map((ev, idx) => {
                    const isSelected = ev.id === selectedUnassignedId;
                    const elapsed =
                      raceStartTs !== null ? ev.ts_utc_ms - raceStartTs : null;
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => setSelectedUnassignedId(ev.id)}
                        className={`w-full p-3 rounded-xl border text-left flex items-center justify-between text-xs font-bold ${
                          isSelected
                            ? 'bg-amber-500/20 border-amber-400 text-white'
                            : 'bg-slate-950 border-slate-800 text-slate-300'
                        }`}
                      >
                        <span>
                          #{idx + 1} · Capturado a las {formatTimeOfDayAr(ev.ts_utc_ms)}
                        </span>
                        <span className="font-mono text-sm font-black text-amber-400">
                          {elapsed !== null ? formatDurationMs(elapsed, true) : 'Sin largada'}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {selectedUnassignedId && (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="numeric"
                        value={assignBibInput}
                        onChange={(e) => setAssignBibInput(e.target.value)}
                        placeholder="N° de dorsal (ej. 120)"
                        className="flex-1 rounded-xl bg-slate-900 border border-slate-700 px-3 py-2.5 text-base font-black text-amber-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleAssignBibToUnassigned()}
                        className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs uppercase"
                      >
                        Asignar Dorsal
                      </button>
                    </div>

                    <div>
                      <div className="text-[11px] font-bold text-slate-400 mb-1.5">
                        O tocá directamente un dorsal pendiente de la Pantalla {activeScreenId}:
                      </div>
                      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
                        {currentScreenEntries
                          .filter((e) => !validEventByBib.has(e.bib))
                          .map((e) => (
                            <button
                              key={e.id}
                              type="button"
                              onClick={() => handleAssignBibToUnassigned(e.bib)}
                              className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-amber-500 hover:text-slate-950 border border-slate-700 text-xs font-black transition"
                            >
                              #{e.bib}
                            </button>
                          ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
