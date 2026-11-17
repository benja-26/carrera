import type { LiveResultRow } from '../types/domain';
import { getRaceBundle, type RaceBundle } from './dataService';
import { DEFAULT_RACE_ID } from './defaultSeed';
import { isSupabaseConfigured, supabase } from './supabase';
import { formatDurationMs } from './timeSync';

/**
 * Replica exactamente la vista SQL `public.v_live_results` cuando se opera en modo Offline
 * o en pruebas locales sin conexión al servidor Postgres.
 */
export function computeLiveResultsFromBundle(bundle: RaceBundle): LiveResultRow[] {
  const { race, categories, entries, raceStart, finishEvents } = bundle;
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const startTs = raceStart?.ts_utc_ms ?? null;

  const validFinishByBib = new Map<number, { id: string; ts: number }>();
  const validStartCrossByBib = new Map<number, number>();
  const dupCountByBib = new Map<number, number>();
  const highDiscByBib = new Map<number, boolean>();

  for (const ev of finishEvents) {
    if (ev.bib === null) continue;
    if (ev.event_type === 'finish') {
      if (ev.status === 'valid') {
        validFinishByBib.set(ev.bib, { id: ev.id, ts: ev.ts_utc_ms });
      } else if (ev.status === 'duplicate') {
        dupCountByBib.set(ev.bib, (dupCountByBib.get(ev.bib) || 0) + 1);
        if (ev.high_discrepancy) {
          highDiscByBib.set(ev.bib, true);
        }
      }
    } else if (ev.event_type === 'start_crossing' && ev.status === 'valid') {
      validStartCrossByBib.set(ev.bib, ev.ts_utc_ms);
    }
  }

  const rows: LiveResultRow[] = entries.map((entry) => {
    const cat = catMap.get(entry.category_id)!;
    const vf = validFinishByBib.get(entry.bib);
    const vscTs = validStartCrossByBib.get(entry.bib) ?? null;

    const finishTs = vf?.ts ?? null;
    const officialTimeMs =
      finishTs !== null && startTs !== null ? finishTs - startTs : null;
    const netTimeMs =
      race.net_time_enabled && finishTs !== null && vscTs !== null
        ? finishTs - vscTs
        : null;

    const runnerStatus = !entry.active
      ? 'dns'
      : finishTs !== null
      ? 'finished'
      : startTs !== null
      ? 'running'
      : 'registered';

    return {
      entry_id: entry.id,
      race_id: race.id,
      race_name: race.name,
      race_status: race.status,
      net_time_enabled: race.net_time_enabled,
      bib: entry.bib,
      display_name: entry.display_name,
      team_name: entry.team_name,
      members: entry.members,
      active: entry.active,
      category_id: cat.id,
      category_slug: cat.slug,
      category_name: cat.name,
      category_short_name: cat.short_name,
      distance_km: cat.distance_km,
      is_pair: cat.is_pair,
      category_color: cat.color,
      screen_group: cat.screen_group,
      race_start_ts_utc_ms: startTs,
      finish_event_id: vf?.id ?? null,
      finish_ts_utc_ms: finishTs,
      start_crossing_ts_utc_ms: vscTs,
      official_time_ms: officialTimeMs,
      net_time_ms: netTimeMs,
      duplicate_count: dupCountByBib.get(entry.bib) || 0,
      has_high_discrepancy: highDiscByBib.get(entry.bib) || false,
      runner_status: runnerStatus,
      category_rank: null,
      distance_rank: null,
      overall_finish_order: null,
      category_gap_ms: null,
      distance_gap_ms: null,
    };
  });

  // 1. Orden global de llegada (overall_finish_order)
  const finishedByTs = rows
    .filter((r) => r.active && r.finish_ts_utc_ms !== null)
    .sort((a, b) => a.finish_ts_utc_ms! - b.finish_ts_utc_ms!);

  finishedByTs.forEach((r, idx) => {
    r.overall_finish_order = idx + 1;
  });

  // 2. Ranking y Gap por Categoría
  const byCategory = new Map<string, LiveResultRow[]>();
  for (const r of rows) {
    if (!r.active || r.official_time_ms === null || r.official_time_ms < 0) continue;
    const list = byCategory.get(r.category_id) || [];
    list.push(r);
    byCategory.set(r.category_id, list);
  }

  for (const list of byCategory.values()) {
    list.sort((a, b) => a.official_time_ms! - b.official_time_ms!);
    const leaderMs = list[0]?.official_time_ms ?? 0;
    list.forEach((r, idx) => {
      r.category_rank = idx + 1;
      r.category_gap_ms = r.official_time_ms! - leaderMs;
    });
  }

  // 3. Ranking y Gap General por Distancia (4 km Duplas vs 6 km Individuales)
  const byDistance = new Map<number, LiveResultRow[]>();
  for (const r of rows) {
    if (!r.active || r.official_time_ms === null || r.official_time_ms < 0) continue;
    const list = byDistance.get(r.distance_km) || [];
    list.push(r);
    byDistance.set(r.distance_km, list);
  }

  for (const list of byDistance.values()) {
    list.sort((a, b) => a.official_time_ms! - b.official_time_ms!);
    const leaderMs = list[0]?.official_time_ms ?? 0;
    list.forEach((r, idx) => {
      r.distance_rank = idx + 1;
      r.distance_gap_ms = r.official_time_ms! - leaderMs;
    });
  }

  return rows;
}

/**
 * Obtiene los resultados en vivo calculados en el servidor (vista `v_live_results`)
 * con fallback transparente al motor determinístico sobre IndexedDB cuando está offline.
 */
export async function fetchLiveResults(
  raceId: string = DEFAULT_RACE_ID
): Promise<{ rows: LiveResultRow[]; bundle: RaceBundle }> {
  const bundle = await getRaceBundle(raceId);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    try {
      const { data, error } = await supabase
        .from('v_live_results')
        .select('*')
        .eq('race_id', raceId);

      if (!error && data && data.length > 0) {
        return { rows: data as LiveResultRow[], bundle };
      }
    } catch {
      // Fallback al cálculo local si hay corte de señal
    }
  }

  const rows = computeLiveResultsFromBundle(bundle);
  return { rows, bundle };
}

/**
 * Calcula el ritmo promedio en min/km (ej. "04:32 /km")
 */
export function formatPacePerKm(
  officialTimeMs: number | null,
  distanceKm: number
): string {
  if (officialTimeMs === null || officialTimeMs <= 0 || distanceKm <= 0) return '—';
  const msPerKm = officialTimeMs / distanceKm;
  const totalSec = Math.round(msPerKm / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} /km`;
}

/**
 * Exporta los resultados oficiales a CSV (con BOM UTF-8 y punto y coma para Excel en Argentina).
 */
export function exportOfficialResultsCsv(
  rows: LiveResultRow[],
  netTimeEnabled = false
): string {
  const headers = [
    'pos_categoria',
    'pos_general_distancia',
    'orden_meta',
    'dorsal',
    'categoria',
    'distancia_km',
    'modalidad',
    'equipo_o_atleta',
    'integrantes_dupla',
    'estado',
    'tiempo_oficial_gun',
    'tiempo_oficial_ms',
    'dif_lider_categoria',
    'dif_lider_distancia',
    'ritmo_min_km',
    ...(netTimeEnabled ? ['tiempo_neto'] : []),
  ];

  const sorted = rows.slice().sort((a, b) => {
    const aFin = a.official_time_ms !== null ? 0 : 1;
    const bFin = b.official_time_ms !== null ? 0 : 1;
    if (aFin !== bFin) return aFin - bFin;
    if (a.official_time_ms !== null && b.official_time_ms !== null) {
      return a.official_time_ms - b.official_time_ms;
    }
    return a.bib - b.bib;
  });

  const lines = sorted.map((r) => {
    const membersText = r.members?.length ? r.members.join(' / ') : '';
    const officialFormatted =
      r.official_time_ms !== null ? formatDurationMs(r.official_time_ms, true) : '';
    const catGapFormatted =
      r.category_gap_ms !== null && r.category_gap_ms > 0
        ? `+${formatDurationMs(r.category_gap_ms, true)}`
        : r.category_rank === 1
        ? '00:00.0'
        : '';
    const distGapFormatted =
      r.distance_gap_ms !== null && r.distance_gap_ms > 0
        ? `+${formatDurationMs(r.distance_gap_ms, true)}`
        : r.distance_rank === 1
        ? '00:00.0'
        : '';
    const pace = formatPacePerKm(r.official_time_ms, r.distance_km);

    const cols = [
      r.category_rank ?? '',
      r.distance_rank ?? '',
      r.overall_finish_order ?? '',
      r.bib,
      `"${r.category_name.replace(/"/g, '""')}"`,
      r.distance_km,
      r.is_pair ? 'Dupla' : 'Individual',
      `"${r.display_name.replace(/"/g, '""')}"`,
      `"${membersText.replace(/"/g, '""')}"`,
      r.runner_status.toUpperCase(),
      officialFormatted,
      r.official_time_ms ?? '',
      catGapFormatted,
      distGapFormatted,
      pace === '—' ? '' : pace,
    ];

    if (netTimeEnabled) {
      cols.push(r.net_time_ms !== null ? formatDurationMs(r.net_time_ms, true) : '');
    }

    return cols.join(';');
  });

  return [headers.join(';'), ...lines].join('\n');
}
