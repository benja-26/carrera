import './nodeEnvSetup';
import assert from 'node:assert/strict';
import {
  adminResolveFinishEvent,
  assignBibToUnassignedEvent,
  getRaceBundle,
  recordFinishEvent,
  resetDemoRaceData,
  saveTimekeeperProfile,
  triggerRaceStart,
  undoOwnFinishEvent,
} from '../src/lib/dataService';
import { DEFAULT_RACE_ID } from '../src/lib/defaultSeed';
import {
  flushOfflineQueue,
  getSyncQueueStats,
  setSimulatedOfflineMode,
} from '../src/lib/offlineSyncEngine';
import {
  exportOfficialResultsCsv,
  fetchLiveResults,
  formatPacePerKm,
} from '../src/lib/resultsEngine';
import { formatDurationMs } from '../src/lib/timeSync';

const ADMIN_ID = 'b0000000-0000-4000-8000-000000000001';

interface VirtualDevice {
  index: number;
  deviceId: string;
  profileId: string;
  name: string;
  pin: string;
  assignedScreen: number;
  clockOffsetMs: number;
  isOfflineMidRace: boolean;
  tapsRecorded: number;
}

// Generador pseudoaleatorio determinístico para reproducibilidad
function createRng(seed = 20261113) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function runSimulation() {
  console.log('======================================================================');
  console.log('🏃 SIMULACIÓN DE CARRERA COMPLETA: 120 ATLETAS Y 10 DISPOSITIVOS');
  console.log('======================================================================\n');

  const rng = createRng(4202026);
  await resetDemoRaceData(ADMIN_ID);

  // 1. Configurar 10 dispositivos virtuales (Cronometristas 01 a 10)
  const offsets = [-180, -95, -40, -12, +8, +25, +64, +110, +165, +230];
  const virtualDevices: VirtualDevice[] = [];

  for (let i = 1; i <= 10; i++) {
    const screenGroup = ((i - 1) % 4) + 1; // Distribuidos en las 4 pantallas (1..4)
    const pin = String(5000 + i);
    const name = `Crono Virtual #${String(i).padStart(2, '0')} (P${screenGroup})`;

    const prof = await saveTimekeeperProfile(
      {
        race_id: DEFAULT_RACE_ID,
        display_name: name,
        role: 'timekeeper',
        pin_code: pin,
        assigned_screens: [screenGroup, 1, 2, 3, 4],
      },
      ADMIN_ID
    );

    virtualDevices.push({
      index: i,
      deviceId: `cel-virtual-${String(i).padStart(2, '0')}`,
      profileId: prof.id,
      name,
      pin,
      assignedScreen: screenGroup,
      clockOffsetMs: offsets[i - 1],
      isOfflineMidRace: i >= 8, // Dispositivos 8, 9 y 10 sufren corte de señal en carrera
      tapsRecorded: 0,
    });
  }

  console.log('📱 10 Dispositivos virtuales creados y sincronizados:');
  for (const dev of virtualDevices) {
    console.log(
      `   • ${dev.deviceId} | ${dev.name.padEnd(28)} | Offset: ${(dev.clockOffsetMs >= 0 ? '+' : '') + dev.clockOffsetMs} ms | Red: ${
        dev.isOfflineMidRace ? 'Corte 4G temporal' : 'Online estable'
      }`
    );
  }

  // 2. Largada Única de la carrera (4 km Duplas + 6 km Individuales largan juntos)
  const raceStartTs = Date.now() - 3600000;
  await triggerRaceStart(DEFAULT_RACE_ID, ADMIN_ID, raceStartTs);
  console.log(`\n🔫 LARGADA ÚNICA DISPARADA (ts_utc_ms = ${raceStartTs})\n`);

  const bundleInitial = await getRaceBundle(DEFAULT_RACE_ID);
  const catMap = new Map(bundleInitial.categories.map((c) => [c.id, c]));
  const entries = bundleInitial.entries;
  assert.equal(entries.length, 120, 'Deben largar 120 atletas/duplas');

  // 3. Simular toques accidentales + Deshacer dentro de los 10s (4 casos)
  let undoneCount = 0;
  for (let i = 0; i < 4; i++) {
    const dev = virtualDevices[i];
    const targetBib = entries[i * 15].bib;
    const accidentalEvent = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: targetBib,
      ts_utc_ms: Date.now() - 2000,
      clock_offset_ms: dev.clockOffsetMs,
      device_id: dev.deviceId,
      user_id: dev.profileId,
    });
    await undoOwnFinishEvent(accidentalEvent.id, dev.deviceId, dev.profileId);
    undoneCount++;
  }

  // 4. Generar los tiempos reales de llegada de los 120 corredores
  const simulatedFinishes = entries.map((entry, idx) => {
    const cat = catMap.get(entry.category_id)!;
    // 4 km Duplas: entre 15m 20s (920.000 ms) y 27m 40s (1.660.000 ms)
    // 6 km Indiv.: entre 21m 10s (1.270.000 ms) y 38m 30s (2.310.000 ms)
    const minMs = cat.distance_km === 4 ? 920000 : 1270000;
    const spanMs = cat.distance_km === 4 ? 740000 : 1040000;
    const elapsedMs = Math.round(minMs + rng() * spanMs + idx * 130);
    return {
      entry,
      cat,
      trueFinishTsMs: raceStartTs + elapsedMs,
      elapsedMs,
    };
  });

  // Ordenar por orden real de llegada a la meta
  simulatedFinishes.sort((a, b) => a.trueFinishTsMs - b.trueFinishTsMs);

  const offlineDeferredQueue: Array<() => Promise<void>> = [];
  let modeBCount = 0;
  let duplicateInjectedCount = 0;

  for (let i = 0; i < simulatedFinishes.length; i++) {
    const item = simulatedFinishes[i];
    // Elegir un dispositivo asignado a la pantalla de la categoría
    const matchingDevices = virtualDevices.filter(
      (d) => d.assignedScreen === item.cat.screen_group
    );
    const primaryDev = matchingDevices[i % matchingDevices.length] || virtualDevices[i % 10];

    // Escenario A: Cada 15 llegadas, entra un pelotón y se usa Modo B ("LLEGÓ sin número")
    if (i % 15 === 7) {
      const unassignedEv = await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: null,
        ts_utc_ms: item.trueFinishTsMs,
        clock_offset_ms: primaryDev.clockOffsetMs,
        device_id: primaryDev.deviceId,
        user_id: primaryDev.profileId,
      });
      await assignBibToUnassignedEvent(
        unassignedEv.id,
        item.entry.bib,
        primaryDev.profileId
      );
      primaryDev.tapsRecorded++;
      modeBCount++;
      continue;
    }

    // Escenario B: Si el dispositivo primario está entre los que sufren corte de señal (dev 8, 9, 10),
    // primero otro cronometrista online lo registra 1.8s más tarde, y el dispositivo offline
    // sincroniza al final su timestamp más temprano.
    if (primaryDev.isOfflineMidRace && i % 3 === 0) {
      const backupOnlineDev = virtualDevices[(primaryDev.index % 7)];
      await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: item.entry.bib,
        ts_utc_ms: item.trueFinishTsMs + 1850, // Backup lo vio 1.85s después
        clock_offset_ms: backupOnlineDev.clockOffsetMs,
        device_id: backupOnlineDev.deviceId,
        user_id: backupOnlineDev.profileId,
      });
      backupOnlineDev.tapsRecorded++;
      duplicateInjectedCount++;

      offlineDeferredQueue.push(async () => {
        setSimulatedOfflineMode(true);
        await recordFinishEvent({
          race_id: DEFAULT_RACE_ID,
          bib: item.entry.bib,
          ts_utc_ms: item.trueFinishTsMs, // Timestamp real más temprano capturado offline
          clock_offset_ms: primaryDev.clockOffsetMs,
          device_id: primaryDev.deviceId,
          user_id: primaryDev.profileId,
        });
        primaryDev.tapsRecorded++;
      });
      continue;
    }

    // Escenario C: Registro normal en cuadrado
    await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: item.entry.bib,
      ts_utc_ms: item.trueFinishTsMs,
      clock_offset_ms: primaryDev.clockOffsetMs,
      device_id: primaryDev.deviceId,
      user_id: primaryDev.profileId,
    });
    primaryDev.tapsRecorded++;

    // Escenario D: En 10 corredores adicionales, un segundo dispositivo también toca el mismo dorsal
    if (i % 12 === 2) {
      const secondDev = virtualDevices[(primaryDev.index + 2) % 10];
      const deltaMs = i % 24 === 2 ? 750 : 3400; // Algunos <= 2s, otros > 2s (discrepancia alta)
      await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: item.entry.bib,
        ts_utc_ms: item.trueFinishTsMs + deltaMs,
        clock_offset_ms: secondDev.clockOffsetMs,
        device_id: secondDev.deviceId,
        user_id: secondDev.profileId,
      });
      secondDev.tapsRecorded++;
      duplicateInjectedCount++;
    }
  }

  // 5. Ejecutar los registros acumulados en los dispositivos sin señal y luego reconectar
  for (const job of offlineDeferredQueue) {
    await job();
  }
  const statsBeforeFlush = await getSyncQueueStats();
  console.log(
    `📡 Eventos acumulados en cola offline durante corte de señal: ${statsBeforeFlush.pendingCount}`
  );

  // Reconectar y drenar cola offline
  setSimulatedOfflineMode(false);
  const flushRes = await flushOfflineQueue();
  console.log(
    `🔄 Sincronización completada al recuperar señal: ${flushRes.flushed} sincronizados, ${flushRes.remaining} pendientes.\n`
  );

  // 6. Verificar estado final de resultados y rankings
  const { rows, bundle: finalBundle } = await fetchLiveResults(DEFAULT_RACE_ID);

  const validEvents = finalBundle.finishEvents.filter((e) => e.status === 'valid');
  const duplicateEvents = finalBundle.finishEvents.filter((e) => e.status === 'duplicate');
  const voidEvents = finalBundle.finishEvents.filter((e) => e.status === 'void');
  const unassignedRemaining = finalBundle.finishEvents.filter(
    (e) => e.status === 'unassigned'
  );

  assert.equal(
    validEvents.length,
    120,
    'Los 120 atletas/duplas deben tener exactamente 1 tiempo válido oficial'
  );
  assert.equal(unassignedRemaining.length, 0, 'No deben quedar tiempos sin asignar');

  console.log('📊 RESUMEN DE EVENTOS PROCESADOS:');
  console.log(`   • Atletas / Duplas clasificados (valid): ${validEvents.length} / 120`);
  console.log(`   • Registros duplicados detectados      : ${duplicateEvents.length} (${duplicateEvents.filter((d) => d.high_discrepancy).length} con alerta > 2s)`);
  console.log(`   • Tiempos capturados con Modo B        : ${modeBCount} (100% asignados)`);
  console.log(`   • Registros deshechos en ventana 10s   : ${undoneCount} (estado void=${voidEvents.length})`);
  console.log(`   • Entradas en audit_log inmutable      : ${finalBundle.auditLogs.length}\n`);

  // 7. Mostrar Top 3 General 4 km (Duplas) y Top 3 General 6 km (Individuales)
  const top4k = rows
    .filter((r) => r.distance_km === 4 && r.distance_rank !== null)
    .sort((a, b) => a.distance_rank! - b.distance_rank!)
    .slice(0, 3);

  console.log('🏆 PODIO GENERAL 4 KM (DUPLAS - 60 EQUIPOS):');
  for (const r of top4k) {
    console.log(
      `   ${r.distance_rank}° | #${String(r.bib).padEnd(4)} | ${r.display_name.padEnd(22)} (${r.members.join(' + ')}) | ${formatDurationMs(
        r.official_time_ms,
        true
      )} | ${formatPacePerKm(r.official_time_ms, 4)}`
    );
  }

  const top6k = rows
    .filter((r) => r.distance_km === 6 && r.distance_rank !== null)
    .sort((a, b) => a.distance_rank! - b.distance_rank!)
    .slice(0, 3);

  console.log('\n🏆 PODIO GENERAL 6 KM (INDIVIDUALES - 60 ATLETAS):');
  for (const r of top6k) {
    console.log(
      `   ${r.distance_rank}° | #${String(r.bib).padEnd(4)} | ${r.display_name.padEnd(22)} [${r.category_name}] | ${formatDurationMs(
        r.official_time_ms,
        true
      )} | ${formatPacePerKm(r.official_time_ms, 6)}`
    );
  }

  // 8. Mostrar el ganador (1°) de cada una de las 12 categorías
  console.log('\n🥇 GANADORES POR CADA UNA DE LAS 12 CATEGORÍAS:');
  for (const cat of finalBundle.categories) {
    const winner = rows.find(
      (r) => r.category_id === cat.id && r.category_rank === 1
    );
    if (winner) {
      console.log(
        `   • [P${cat.screen_group}] ${cat.name.padEnd(20)} (${cat.distance_km}K) -> #${String(
          winner.bib
        ).padEnd(4)} ${winner.display_name.padEnd(22)} | ${formatDurationMs(
          winner.official_time_ms,
          true
        )}`
      );
    }
  }

  // 9. Verificar exportación CSV completa
  const csvContent = exportOfficialResultsCsv(rows, false);
  const csvLines = csvContent.trim().split('\n');
  assert.equal(csvLines.length, 121, 'El CSV debe tener 1 encabezado + 120 filas de resultados');

  console.log('\n✅ SIMULACIÓN DE 120 ATLETAS Y 10 DISPOSITIVOS COMPLETADA CON ÉXITO.');
}

runSimulation().catch((err) => {
  console.error('❌ Error en la simulación:', err);
  process.exit(1);
});
