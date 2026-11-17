import './nodeEnvSetup';
import assert from 'node:assert/strict';
import {
  adminResolveFinishEvent,
  assignBibToUnassignedEvent,
  correctRaceStart,
  getRaceBundle,
  loginWithPin,
  recordFinishEvent,
  resetDemoRaceData,
  toggleRevokeProfile,
  triggerRaceStart,
  undoOwnFinishEvent,
  updateRaceConfig,
} from '../src/lib/dataService';
import { DEFAULT_RACE_ID } from '../src/lib/defaultSeed';
import {
  computeExponentialBackoffMs,
  flushOfflineQueue,
  getSyncQueueStats,
  setSimulatedOfflineMode,
} from '../src/lib/offlineSyncEngine';
import { fetchLiveResults } from '../src/lib/resultsEngine';
import {
  getClockOffsetMs,
  getCorrectedNowMs,
  setSimulatedClockOffsetMs,
} from '../src/lib/timeSync';

const ADMIN_ID = 'b0000000-0000-4000-8000-000000000001';
const CRONO_1_ID = 'b0000000-0000-4000-8000-000000000011';
const CRONO_2_ID = 'b0000000-0000-4000-8000-000000000012';
const CRONO_3_ID = 'b0000000-0000-4000-8000-000000000013';

async function runAllTests() {
  console.log('======================================================================');
  console.log('🧪 EJECUTANDO SUITE DE TESTS: LÓGICA DE TIEMPOS, SEGURIDAD Y OFFLINE');
  console.log('======================================================================\n');

  await resetDemoRaceData(ADMIN_ID);

  // --------------------------------------------------------------------------
  // TEST 1: Semilla inicial (12 categorías, 4 pantallas, 120 atletas con salto 10)
  // --------------------------------------------------------------------------
  {
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    assert.equal(bundle.categories.length, 12, 'Deben existir exactamente 12 categorías');
    assert.equal(bundle.entries.length, 120, 'Deben existir exactamente 120 inscriptos');

    const pairCategories = bundle.categories.filter((c) => c.distance_km === 4 && c.is_pair);
    const indCategories = bundle.categories.filter((c) => c.distance_km === 6 && !c.is_pair);
    assert.equal(pairCategories.length, 6, '6 categorías de duplas (4 km)');
    assert.equal(indCategories.length, 6, '6 categorías individuales (6 km)');

    // Verificar saltos de 10 en la categoría Funcional Dupla (100, 110, 120... 190)
    const funcDuplaBibs = bundle.entries
      .filter((e) => e.category_id === pairCategories[0].id)
      .map((e) => e.bib);
    assert.deepEqual(
      funcDuplaBibs,
      [100, 110, 120, 130, 140, 150, 160, 170, 180, 190],
      'Los dorsales deben asignarse con salto de 10 en 10'
    );
    console.log('✅ [PASS] Test 1: 12 categorías (4K Duplas / 6K Indiv.) y 120 dorsales con salto 10.');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Login por PIN, Revocación en Vivo y Rate Limiting (5 intentos)
  // --------------------------------------------------------------------------
  {
    const tk1 = await loginWithPin('1111', 'test-dev-auth-1');
    assert.equal(tk1.id, CRONO_1_ID);
    assert.equal(tk1.role, 'timekeeper');

    // Revocar PIN y comprobar rechazo inmediato
    await toggleRevokeProfile(CRONO_1_ID, true, DEFAULT_RACE_ID, ADMIN_ID);
    await assert.rejects(
      () => loginWithPin('1111', 'test-dev-auth-1'),
      /revocado/i,
      'Un PIN revocado no debe poder iniciar sesión ni registrar tiempos'
    );
    // Reactivar PIN
    await toggleRevokeProfile(CRONO_1_ID, false, DEFAULT_RACE_ID, ADMIN_ID);

    // Rate limiting: 5 intentos fallidos desde el mismo dispositivo bloquean el 6° intento
    const bruteDeviceId = 'test-dev-brute-force';
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => loginWithPin('0000', bruteDeviceId));
    }
    await assert.rejects(
      () => loginWithPin('1111', bruteDeviceId),
      /Demasiados intentos fallidos/i,
      'El 6° intento desde el mismo dispositivo debe bloquearse aunque el PIN sea válido'
    );
    console.log('✅ [PASS] Test 2: Login por PIN, revocación instantánea y Rate Limiting (5 intentos).');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Largada Única (Solo Admin) + Corrección Manual con Motivo y Auditoría
  // --------------------------------------------------------------------------
  {
    const initialStartTs = 1763060000000;

    // Un cronometrista NO puede largar la carrera
    await assert.rejects(
      () => triggerRaceStart(DEFAULT_RACE_ID, CRONO_1_ID, initialStartTs),
      /Solo el administrador/i
    );

    // El Admin larga la carrera
    const startRec = await triggerRaceStart(DEFAULT_RACE_ID, ADMIN_ID, initialStartTs);
    assert.equal(startRec.ts_utc_ms, initialStartTs);

    // No se puede largar por segunda vez
    await assert.rejects(
      () => triggerRaceStart(DEFAULT_RACE_ID, ADMIN_ID, initialStartTs + 5000),
      /ya fue largada/i
    );

    // Corregir hora de largada sin motivo debe fallar
    await assert.rejects(
      () => correctRaceStart(DEFAULT_RACE_ID, initialStartTs - 2000, 'abc', ADMIN_ID),
      /motivo detallado/i
    );

    // Corregir hora de largada (-2.0s) con motivo válido
    const correctedStartTs = initialStartTs - 2000;
    const corrected = await correctRaceStart(
      DEFAULT_RACE_ID,
      correctedStartTs,
      'Ajuste oficial por sincronización con bocina de largada (-2.0s)',
      ADMIN_ID
    );
    assert.equal(corrected.ts_utc_ms, correctedStartTs);
    assert.equal(corrected.corrected_by, ADMIN_ID);

    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const hasAudit = bundle.auditLogs.some((l) => l.action === 'RACE_START_CORRECTED');
    assert.equal(hasAudit, true, 'La corrección de largada debe quedar en audit_log');
    console.log('✅ [PASS] Test 3: Largada única por Admin, bloqueo de doble largada y corrección auditada.');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Offset de Reloj (clock_offset_ms) e Idempotencia por UUID de Cliente
  // --------------------------------------------------------------------------
  {
    setSimulatedClockOffsetMs(-145);
    assert.equal(getClockOffsetMs(), -145);
    const before = Date.now();
    const corrected = getCorrectedNowMs();
    assert.ok(
      Math.abs(corrected - (before - 145)) <= 20,
      'getCorrectedNowMs() debe aplicar el offset calculado contra el servidor'
    );

    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const startTs = bundle.raceStart!.ts_utc_ms;
    const fixedUuid = crypto.randomUUID();

    const ev1 = await recordFinishEvent({
      id: fixedUuid,
      race_id: DEFAULT_RACE_ID,
      bib: 100,
      ts_utc_ms: startTs + 1020000, // 17:00.0
      clock_offset_ms: -145,
      device_id: 'dev-crono-01',
      user_id: CRONO_1_ID,
    });

    // Reintento de red con el mismo UUID desde la cola offline
    const ev2 = await recordFinishEvent({
      id: fixedUuid,
      race_id: DEFAULT_RACE_ID,
      bib: 100,
      ts_utc_ms: startTs + 1020000,
      clock_offset_ms: -145,
      device_id: 'dev-crono-01',
      user_id: CRONO_1_ID,
    });

    assert.equal(ev1.id, ev2.id);
    const afterBundle = await getRaceBundle(DEFAULT_RACE_ID);
    const eventsFor100 = afterBundle.finishEvents.filter((e) => e.bib === 100);
    assert.equal(eventsFor100.length, 1, 'El reintento con el mismo UUID no debe duplicar filas');
    setSimulatedClockOffsetMs(0);
    console.log('✅ [PASS] Test 4: Aplicación de clock_offset_ms e idempotencia estricta por UUID.');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Regla de Duplicados (±2s vs >2s Discrepancia Alta) y Sync Offline más temprano
  // --------------------------------------------------------------------------
  {
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const startTs = bundle.raceStart!.ts_utc_ms;

    // Dorsal #100 ya tiene un registro 'valid' en startTs + 1020000 (17:00.0)
    // Caso 5A: Segundo dispositivo registra #100 con +1100 ms (dentro de tolerancia <= 2000 ms)
    const dupNear = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 100,
      ts_utc_ms: startTs + 1021100,
      clock_offset_ms: 12,
      device_id: 'dev-crono-02',
      user_id: CRONO_2_ID,
    });
    assert.equal(dupNear.status, 'duplicate');
    assert.equal(dupNear.high_discrepancy, false, 'Diferencia <= 2000ms no marca discrepancia alta');

    // Caso 5B: Tercer dispositivo registra #100 con +5800 ms (> 2000 ms)
    const dupFar = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 100,
      ts_utc_ms: startTs + 1025800,
      clock_offset_ms: -20,
      device_id: 'dev-crono-03',
      user_id: CRONO_3_ID,
    });
    assert.equal(dupFar.status, 'duplicate');
    assert.equal(dupFar.high_discrepancy, true, 'Diferencia > 2000ms debe alertar high_discrepancy');

    // Caso 5C: Un dispositivo offline sincroniza tarde un toque tomado ANTES (startTs + 1018500)
    const earlierOffline = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 100,
      ts_utc_ms: startTs + 1018500, // 1.5s ANTES que el primer registro
      clock_offset_ms: 5,
      device_id: 'dev-crono-offline',
      user_id: CRONO_2_ID,
    });
    assert.equal(
      earlierOffline.status,
      'valid',
      'El registro más temprano debe promoverse automáticamente a valid'
    );

    const updatedBundle = await getRaceBundle(DEFAULT_RACE_ID);
    const validFor100 = updatedBundle.finishEvents.filter(
      (e) => e.bib === 100 && e.status === 'valid'
    );
    assert.equal(validFor100.length, 1, 'Siempre debe existir UN SOLO valid por dorsal');
    assert.equal(validFor100[0].id, earlierOffline.id);
    console.log('✅ [PASS] Test 5: Duplicados cercanos (<=2s), discrepancia alta (>2s) y promoción de offline más temprano.');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Deshacer Rápido (10s) y Promoción Automática del Duplicado
  // --------------------------------------------------------------------------
  {
    const nowTs = getCorrectedNowMs();
    // Registrar dorsal #110 ahora mismo con Crono 1 y un duplicado +400ms con Crono 2
    const firstTap = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 110,
      ts_utc_ms: nowTs - 1000,
      device_id: 'dev-crono-01',
      user_id: CRONO_1_ID,
    });
    const secondTap = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 110,
      ts_utc_ms: nowTs - 600,
      device_id: 'dev-crono-02',
      user_id: CRONO_2_ID,
    });

    assert.equal(firstTap.status, 'valid');
    assert.equal(secondTap.status, 'duplicate');

    // Crono 2 NO puede deshacer el registro de Crono 1
    await assert.rejects(
      () => undoOwnFinishEvent(firstTap.id, 'dev-crono-02', CRONO_2_ID),
      /propio usuario/i
    );

    // Crono 1 deshace su propio registro dentro de los 10s
    const undone = await undoOwnFinishEvent(firstTap.id, 'dev-crono-01', CRONO_1_ID);
    assert.equal(undone.status, 'void');

    // Verificar que secondTap fue promovido automáticamente a 'valid'
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const promoted = bundle.finishEvents.find((e) => e.id === secondTap.id);
    assert.equal(
      promoted?.status,
      'valid',
      'Al deshacer el valid, el duplicado más temprano debe promoverse a valid'
    );
    console.log('✅ [PASS] Test 6: Deshacer rápido (10s) con validación de autoría y promoción de duplicado.');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Modo B ("LLEGÓ sin número") y Asignación Posterior de Dorsal
  // --------------------------------------------------------------------------
  {
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const startTs = bundle.raceStart!.ts_utc_ms;

    const unassigned = await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: null,
      ts_utc_ms: startTs + 1085400, // 18:05.4
      device_id: 'dev-crono-01',
      user_id: CRONO_1_ID,
    });
    assert.equal(unassigned.status, 'unassigned');
    assert.equal(unassigned.bib, null);

    const assigned = await assignBibToUnassignedEvent(unassigned.id, 120, CRONO_1_ID);
    assert.equal(assigned.bib, 120);
    assert.equal(assigned.status, 'valid');
    assert.equal(assigned.ts_utc_ms, startTs + 1085400, 'Debe conservar el timestamp exacto del toque original');
    console.log('✅ [PASS] Test 7: Modo B ("LLEGÓ sin número") conserva el instante original al asignar dorsal.');
  }

  // --------------------------------------------------------------------------
  // TEST 8: Cola Offline en IndexedDB, Backoff Exponencial y Drenaje al Reconectar
  // --------------------------------------------------------------------------
  {
    // Verificar progresión exponencial de backoff
    const b0 = computeExponentialBackoffMs(0);
    const b1 = computeExponentialBackoffMs(1);
    const b2 = computeExponentialBackoffMs(2);
    assert.ok(b0 >= 1000 && b0 < 1500);
    assert.ok(b1 >= 2000 && b1 < 2500);
    assert.ok(b2 >= 4000 && b2 < 4500);

    // Simular corte de señal 4G
    setSimulatedOfflineMode(true);
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const startTs = bundle.raceStart!.ts_utc_ms;

    await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 130,
      ts_utc_ms: startTs + 1100000,
      device_id: 'dev-offline-1',
      user_id: CRONO_1_ID,
    });
    await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      bib: 140,
      ts_utc_ms: startTs + 1115000,
      device_id: 'dev-offline-1',
      user_id: CRONO_1_ID,
    });

    const statsWhileOffline = await getSyncQueueStats();
    assert.equal(statsWhileOffline.isOnline, false);
    assert.ok(
      statsWhileOffline.pendingCount >= 2,
      'Los eventos registrados sin conexión deben permanecer en estado pending en IndexedDB'
    );

    // Reconectar red y vaciar cola
    setSimulatedOfflineMode(false);
    const flushResult = await flushOfflineQueue();
    assert.equal(flushResult.remaining, 0, 'Al reconectar la red, la cola offline debe quedar en 0 pendientes');
    console.log('✅ [PASS] Test 8: Cola Offline en IndexedDB, backoff exponencial y drenaje completo al reconectar.');
  }

  // --------------------------------------------------------------------------
  // TEST 9: Tiempo Oficial (Gun Time) vs. Tiempo Neto Opcional (Paso por Largada)
  // --------------------------------------------------------------------------
  {
    await updateRaceConfig(DEFAULT_RACE_ID, { net_time_enabled: true }, ADMIN_ID);
    const bundle = await getRaceBundle(DEFAULT_RACE_ID);
    const startTs = bundle.raceStart!.ts_utc_ms;

    // Dorsal #2000 (6K Avanzado Individual) cruza el arco de largada 6.5s después del disparo
    await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      event_type: 'start_crossing',
      bib: 2000,
      ts_utc_ms: startTs + 6500,
      device_id: 'dev-largada',
      user_id: CRONO_3_ID,
    });

    // Y cruza la meta a los 24m 06.5s del disparo oficial
    await recordFinishEvent({
      race_id: DEFAULT_RACE_ID,
      event_type: 'finish',
      bib: 2000,
      ts_utc_ms: startTs + 1446500,
      device_id: 'dev-meta',
      user_id: CRONO_3_ID,
    });

    const { rows } = await fetchLiveResults(DEFAULT_RACE_ID);
    const runner2000 = rows.find((r) => r.bib === 2000)!;
    assert.equal(
      runner2000.official_time_ms,
      1446500,
      'El tiempo oficial debe ser el Tiempo Bruto (Gun Time = llegada - largada)'
    );
    assert.equal(
      runner2000.net_time_ms,
      1440000,
      'El tiempo neto debe ser llegada - paso por largada (1446500 - 6500 = 1440000)'
    );

    // También verificar que el Admin puede resolver un duplicado definitivamente
    const dupEvents = bundle.finishEvents.filter(
      (e) => e.bib === 100 && e.status === 'duplicate'
    );
    for (const d of dupEvents) {
      await adminResolveFinishEvent(
        d.id,
        'void',
        'Resuelto en test automatizado por Admin',
        ADMIN_ID
      );
    }

    console.log('✅ [PASS] Test 9: Cálculo de Tiempo Oficial (Gun Time) y Tiempo Neto opcional en rankings.');
  }

  console.log('\n🎉 TODOS LOS TESTS PASARON EXITOSAMENTE (9 / 9 suites verificadas).');
}

runAllTests().catch((err) => {
  console.error('❌ Error en los tests:', err);
  process.exit(1);
});
