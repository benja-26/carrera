import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Download,
  Flag,
  Medal,
  RefreshCw,
  Search,
  Trophy,
  Users,
  User,
} from 'lucide-react';
import { subscribeToLocalRealtime } from '../lib/db';
import {
  exportOfficialResultsCsv,
  fetchLiveResults,
  formatPacePerKm,
} from '../lib/resultsEngine';
import { parsePausedElapsedMs, startRealtimeRaceSync } from '../lib/dataService';
import { formatDurationMs, getCorrectedNowMs } from '../lib/timeSync';
import type { Category, LiveResultRow, Race, RaceStart } from '../types/domain';

type RankingMode = 'category' | 'distance_4k' | 'distance_6k';
type StatusFilter = 'ALL' | 'FINISHED' | 'RUNNING';

export const ResultsPage: React.FC = () => {
  const [rows, setRows] = useState<LiveResultRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [race, setRace] = useState<Race | null>(null);
  const [raceStart, setRaceStart] = useState<RaceStart | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const [mode, setMode] = useState<RankingMode>('category');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [liveClockMs, setLiveClockMs] = useState<number>(0);

  const loadResults = useCallback(async () => {
    const { rows: nextRows, bundle } = await fetchLiveResults();
    setRows(nextRows);
    setCategories(bundle.categories);
    setRace(bundle.race);
    setRaceStart(bundle.raceStart);
    setSelectedCategoryId((prev) => prev || bundle.categories[0]?.id || '');
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadResults();
    const unsubRemote = startRealtimeRaceSync();
    const unsubLocal = subscribeToLocalRealtime(() => {
      void loadResults();
    });

    return () => {
      unsubRemote();
      unsubLocal();
    };
  }, [loadResults]);

  // Reloj en vivo de la carrera
  useEffect(() => {
    if (!raceStart) {
      setLiveClockMs(0);
      return;
    }
    const pausedMs = parsePausedElapsedMs(raceStart);
    if (pausedMs !== null) {
      setLiveClockMs(pausedMs);
      return;
    }
    const tick = () => {
      setLiveClockMs(Math.max(0, getCorrectedNowMs() - raceStart.ts_utc_ms));
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [raceStart]);

  // Estadísticas globales
  const stats = useMemo(() => {
    const activeRows = rows.filter((r) => r.active);
    const finishedAll = activeRows.filter((r) => r.runner_status === 'finished').length;
    const rows4k = activeRows.filter((r) => r.distance_km === 4);
    const fin4k = rows4k.filter((r) => r.runner_status === 'finished').length;
    const rows6k = activeRows.filter((r) => r.distance_km === 6);
    const fin6k = rows6k.filter((r) => r.runner_status === 'finished').length;

    return {
      totalActive: activeRows.length,
      finishedAll,
      total4k: rows4k.length,
      fin4k,
      total6k: rows6k.length,
      fin6k,
    };
  }, [rows]);

  // Filas filtradas y ordenadas según el modo de clasificación elegido
  const displayedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      if (!r.active) return false;
      if (mode === 'category' && selectedCategoryId && r.category_id !== selectedCategoryId) {
        return false;
      }
      if (mode === 'distance_4k' && r.distance_km !== 4) {
        return false;
      }
      if (mode === 'distance_6k' && r.distance_km !== 6) {
        return false;
      }
      if (statusFilter === 'FINISHED' && r.runner_status !== 'finished') {
        return false;
      }
      if (statusFilter === 'RUNNING' && r.runner_status === 'finished') {
        return false;
      }
      if (!q) return true;
      const matchBib = String(r.bib).includes(q);
      const matchName = r.display_name.toLowerCase().includes(q);
      const matchMembers = r.members.some((m) => m.toLowerCase().includes(q));
      const matchCat = r.category_name.toLowerCase().includes(q);
      return matchBib || matchName || matchMembers || matchCat;
    });

    return filtered.sort((a, b) => {
      const rankA = mode === 'category' ? a.category_rank : a.distance_rank;
      const rankB = mode === 'category' ? b.category_rank : b.distance_rank;

      if (rankA !== null && rankB !== null) return rankA - rankB;
      if (rankA !== null) return -1;
      if (rankB !== null) return 1;

      if (a.finish_ts_utc_ms !== null && b.finish_ts_utc_ms !== null) {
        return a.finish_ts_utc_ms - b.finish_ts_utc_ms;
      }
      if (a.finish_ts_utc_ms !== null) return -1;
      if (b.finish_ts_utc_ms !== null) return 1;

      return a.bib - b.bib;
    });
  }, [rows, mode, selectedCategoryId, statusFilter, searchQuery]);

  // Podio Top 3 de la vista actual
  const podiumTop3 = useMemo(
    () =>
      displayedRows
        .filter((r) => r.official_time_ms !== null && r.official_time_ms >= 0)
        .slice(0, 3),
    [displayedRows]
  );

  const handleExportCsv = () => {
    const csv = exportOfficialResultsCsv(displayedRows, race?.net_time_enabled ?? false);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix =
      mode === 'category'
        ? categories.find((c) => c.id === selectedCategoryId)?.slug || 'categoria'
        : mode;
    a.download = `resultados-skol-${suffix}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading || !race) {
    return (
      <div className="p-8 text-center text-slate-400 font-semibold">
        Cargando resultados en tiempo real...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-3 sm:p-6 space-y-5">
      {/* 1. Cabecera Pública de Resultados en Vivo */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider flex items-center gap-1.5 ${
                raceStart
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  raceStart ? 'bg-slate-950 animate-ping' : 'bg-amber-400'
                }`}
              />
              {raceStart ? 'Clasificación en Vivo' : 'Esperando Largada'}
            </span>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white">
              {race.name}
            </h1>
          </div>
          <p className="text-xs text-slate-400">
            Tiempo Oficial = Tiempo Bruto (Llegada − Largada Única) · Actualización en
            tiempo real
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {raceStart && (
            <div className="px-3.5 py-2 rounded-xl bg-slate-950 border border-emerald-700/60 flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-400" />
              <div>
                <div className="text-[10px] uppercase font-bold text-slate-400">
                  Reloj Oficial
                </div>
                <div className="font-mono text-lg font-black text-emerald-400 leading-none">
                  {formatDurationMs(liveClockMs, true)}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5 bg-slate-950 border border-slate-800 rounded-xl p-2 text-center text-xs">
            <div className="px-2">
              <div className="text-[10px] text-slate-400">Total Meta</div>
              <div className="font-black text-white">
                {stats.finishedAll}/{stats.totalActive}
              </div>
            </div>
            <div className="px-2 border-x border-slate-800">
              <div className="text-[10px] text-slate-400">4K Duplas</div>
              <div className="font-black text-amber-400">
                {stats.fin4k}/{stats.total4k}
              </div>
            </div>
            <div className="px-2">
              <div className="text-[10px] text-slate-400">6K Indiv.</div>
              <div className="font-black text-sky-400">
                {stats.fin6k}/{stats.total6k}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="px-3.5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/10"
          >
            <Download className="w-4 h-4" />
            <span>Exportar CSV</span>
          </button>
        </div>
      </div>

      {/* 2. Selector Principal de Vista: Por Categoría vs General 4 km vs General 6 km */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setMode('category')}
          className={`p-3 rounded-2xl border text-left transition flex items-center justify-between ${
            mode === 'category'
              ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-lg shadow-amber-500/15'
              : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800 font-bold'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Trophy className="w-5 h-5 shrink-0" />
            <div>
              <div className="text-sm font-black">Ranking por Categoría</div>
              <div className="text-[11px] opacity-80">12 categorías oficiales</div>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setMode('distance_4k')}
          className={`p-3 rounded-2xl border text-left transition flex items-center justify-between ${
            mode === 'distance_4k'
              ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-lg shadow-amber-500/15'
              : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800 font-bold'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 shrink-0" />
            <div>
              <div className="text-sm font-black">General 4 km (Duplas)</div>
              <div className="text-[11px] opacity-80">
                2K ida + 2K vuelta · Funcional y Scaled
              </div>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setMode('distance_6k')}
          className={`p-3 rounded-2xl border text-left transition flex items-center justify-between ${
            mode === 'distance_6k'
              ? 'bg-amber-500 text-slate-950 border-amber-400 font-black shadow-lg shadow-amber-500/15'
              : 'bg-slate-900 text-slate-200 border-slate-800 hover:bg-slate-800 font-bold'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <User className="w-5 h-5 shrink-0" />
            <div>
              <div className="text-sm font-black">General 6 km (Individuales)</div>
              <div className="text-[11px] opacity-80">
                3K ida + 3K vuelta · Avanzado y RX
              </div>
            </div>
          </div>
        </button>
      </div>

      {/* 3. Selector de las 12 Categorías cuando está en modo 'category' */}
      {mode === 'category' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Seleccioná la categoría:
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
            {categories.map((cat) => {
              const isSelected = cat.id === selectedCategoryId;
              const catFinished = rows.filter(
                (r) => r.category_id === cat.id && r.runner_status === 'finished'
              ).length;
              const catTotal = rows.filter(
                (r) => r.category_id === cat.id && r.active
              ).length;

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategoryId(cat.id)}
                  className={`p-2 rounded-xl border text-left transition flex flex-col justify-between ${
                    isSelected
                      ? 'bg-slate-950 border-2 border-amber-400 shadow-md'
                      : 'bg-slate-950/60 border-slate-800 hover:bg-slate-800/70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <span className="text-[10px] font-mono text-slate-400">
                      {cat.distance_km}K · {catFinished}/{catTotal}
                    </span>
                  </div>
                  <div
                    className={`text-xs font-black truncate mt-1 ${
                      isSelected ? 'text-amber-400' : 'text-slate-200'
                    }`}
                  >
                    {cat.name}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. Podio en Vivo (Top 3) */}
      {podiumTop3.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {podiumTop3.map((winner, idx) => {
            const medalColors = [
              'border-amber-400/80 bg-amber-500/10 text-amber-300',
              'border-slate-400/70 bg-slate-400/10 text-slate-200',
              'border-orange-500/70 bg-orange-500/10 text-orange-300',
            ];
            const medalLabels = ['🥇 1° PUESTO', '🥈 2° PUESTO', '🥉 3° PUESTO'];
            const gapMs =
              mode === 'category' ? winner.category_gap_ms : winner.distance_gap_ms;

            return (
              <div
                key={winner.entry_id}
                className={`rounded-2xl border-2 p-4 flex items-center justify-between gap-3 ${medalColors[idx]}`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-black uppercase tracking-wider flex items-center gap-1.5">
                    <Medal className="w-4 h-4" />
                    <span>{medalLabels[idx]}</span>
                    <span className="font-mono text-white bg-slate-950 px-1.5 py-0.5 rounded text-[11px]">
                      #{winner.bib}
                    </span>
                  </div>
                  <div className="text-base font-black text-white truncate mt-1">
                    {winner.display_name}
                  </div>
                  {winner.members.length > 0 ? (
                    <div className="text-[11px] text-slate-300 truncate">
                      {winner.members.join(' + ')}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      {winner.category_name}
                    </div>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <div className="font-mono text-lg sm:text-xl font-black text-white">
                    {formatDurationMs(winner.official_time_ms, true)}
                  </div>
                  <div className="text-[11px] font-mono opacity-80">
                    {idx === 0
                      ? formatPacePerKm(winner.official_time_ms, winner.distance_km)
                      : `+${formatDurationMs(gapMs, true)}`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 5. Buscador y Filtros de Estado */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar por N° de pechera, nombre de equipo o integrante..."
              className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-9 pr-3 py-2 text-xs font-semibold"
            />
          </div>

          <div className="flex items-center gap-1.5">
            {(
              [
                { id: 'ALL', label: 'Todos' },
                { id: 'FINISHED', label: 'En Meta' },
                { id: 'RUNNING', label: 'En Circuito' },
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => setStatusFilter(st.id)}
                className={`px-3 py-2 rounded-xl text-xs font-bold border ${
                  statusFilter === st.id
                    ? 'bg-amber-500 text-slate-950 border-amber-400 font-black'
                    : 'bg-slate-950 text-slate-300 border-slate-800'
                }`}
              >
                {st.label}
              </button>
            ))}

            <button
              type="button"
              onClick={loadResults}
              className="p-2 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-300"
              title="Actualizar ahora"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabla Oficial de Resultados */}
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-slate-950 text-slate-400 uppercase text-[11px]">
              <tr>
                <th className="py-3 px-3">Pos.</th>
                <th className="py-3 px-3">Dorsal</th>
                <th className="py-3 px-3">Atleta / Dupla</th>
                <th className="py-3 px-3">Categoría</th>
                <th className="py-3 px-3 text-right">Tiempo Oficial</th>
                <th className="py-3 px-3 text-right">Dif. 1°</th>
                <th className="py-3 px-3 text-right hidden sm:table-cell">Ritmo</th>
                {race.net_time_enabled && (
                  <th className="py-3 px-3 text-right">Tiempo Neto</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {displayedRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={race.net_time_enabled ? 8 : 7}
                    className="py-8 text-center text-slate-500"
                  >
                    No se encontraron corredores con los filtros actuales.
                  </td>
                </tr>
              ) : (
                displayedRows.map((row) => {
                  const rank =
                    mode === 'category' ? row.category_rank : row.distance_rank;
                  const gapMs =
                    mode === 'category' ? row.category_gap_ms : row.distance_gap_ms;
                  const isFinished = row.runner_status === 'finished';

                  return (
                    <tr
                      key={row.entry_id}
                      className={`hover:bg-slate-800/40 ${
                        rank === 1 ? 'bg-amber-500/5' : ''
                      }`}
                    >
                      <td className="py-2.5 px-3 font-black text-sm">
                        {rank !== null ? (
                          <span
                            className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${
                              rank === 1
                                ? 'bg-amber-400 text-slate-950'
                                : rank === 2
                                ? 'bg-slate-300 text-slate-950'
                                : rank === 3
                                ? 'bg-orange-400 text-slate-950'
                                : 'bg-slate-800 text-slate-200'
                            }`}
                          >
                            {rank}°
                          </span>
                        ) : (
                          <span className="text-slate-500 text-xs font-semibold">
                            —
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 px-3">
                        <span
                          className="inline-flex items-center justify-center px-2.5 py-1 rounded-lg font-black text-white text-xs"
                          style={{ backgroundColor: row.category_color }}
                        >
                          #{row.bib}
                        </span>
                      </td>

                      <td className="py-2.5 px-3">
                        <div className="font-black text-slate-100 text-xs sm:text-sm">
                          {row.display_name}
                        </div>
                        {row.members.length > 0 && (
                          <div className="text-[11px] text-slate-400">
                            {row.members.join(' · ')}
                          </div>
                        )}
                      </td>

                      <td className="py-2.5 px-3">
                        <div className="font-bold text-slate-200">
                          {row.category_short_name}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {row.distance_km} km ·{' '}
                          {row.overall_finish_order
                            ? `Meta #${row.overall_finish_order}`
                            : 'En carrera'}
                        </div>
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono font-black text-sm">
                        {isFinished && row.official_time_ms !== null ? (
                          <span className="text-emerald-400">
                            {formatDurationMs(row.official_time_ms, true)}
                          </span>
                        ) : row.runner_status === 'running' ? (
                          <span className="px-2 py-0.5 rounded bg-sky-950 text-sky-300 text-[10px] font-sans font-bold">
                            EN CIRCUITO
                          </span>
                        ) : (
                          <span className="text-slate-500 text-[11px] font-sans">
                            PENDIENTE
                          </span>
                        )}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-xs text-slate-400">
                        {gapMs !== null && gapMs > 0
                          ? `+${formatDurationMs(gapMs, true)}`
                          : rank === 1
                          ? 'Líder'
                          : '—'}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-xs text-slate-300 hidden sm:table-cell">
                        {formatPacePerKm(row.official_time_ms, row.distance_km)}
                      </td>

                      {race.net_time_enabled && (
                        <td className="py-2.5 px-3 text-right font-mono text-xs text-sky-300">
                          {row.net_time_ms !== null
                            ? formatDurationMs(row.net_time_ms, true)
                            : '—'}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
