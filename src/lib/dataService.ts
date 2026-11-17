import type {
  AuditLogEntry,
  Category,
  Entry,
  EventStatus,
  EventType,
  FinishEvent,
  Profile,
  Race,
  RaceStart,
} from '../types/domain';
import { getNextAvailableBib, matchCategoryByInput, type ParsedCsvEntryRow } from './csvUtils';
import { db, ensureLocalSeed, notifyLocalRealtimeChange } from './db';
import {
  DEFAULT_CATEGORIES,
  DEFAULT_PROFILES,
  DEFAULT_RACE,
  DEFAULT_RACE_ID,
  generateDefaultEntries,
} from './defaultSeed';
import { isSupabaseConfigured, supabase } from './supabase';
import { getClockOffsetMs, getCorrectedNowMs } from './timeSync';

export interface RaceBundle {
  race: Race;
  categories: Category[];
  entries: Entry[];
  profiles: Profile[];
  raceStart: RaceStart | null;
  finishEvents: FinishEvent[];
  auditLogs: AuditLogEntry[];
}

async function appendAuditLog(params: {
  race_id: string;
  actor_id: string;
  action: string;
  entity_table: string;
  entity_id: string;
  before_data?: Record<string, unknown> | null;
  after_data?: Record<string, unknown> | null;
  reason?: string | null;
}) {
  const entry: AuditLogEntry = {
    id: crypto.randomUUID(),
    race_id: params.race_id,
    actor_id: params.actor_id,
    action: params.action,
    entity_table: params.entity_table,
    entity_id: params.entity_id,
    before_data: params.before_data ?? null,
    after_data: params.after_data ?? null,
    reason: params.reason ?? null,
    created_at: new Date().toISOString(),
  };

  await db.audit_log.put(entry);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    try {
      await supabase.from('audit_log').insert({
        id: entry.id,
        race_id: entry.race_id,
        actor_id: entry.actor_id,
        action: entry.action,
        entity_table: entry.entity_table,
        entity_id: entry.entity_id,
        before_data: entry.before_data,
        after_data: entry.after_data,
        reason: entry.reason,
      });
    } catch {
      // Mantenido en IndexedDB
    }
  }
}

function doesUsernameMatchProfile(inputUsername: string | undefined, profile: Profile): boolean {
  if (!inputUsername) return true;
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const u = normalize(inputUsername);
  if (!u) return false;

  const full = normalize(profile.display_name);
  const baseBeforeParen = normalize(profile.display_name.split('(')[0] || '');
  const compactU = u.replace(/\s+/g, '');
  const compactFull = full.replace(/\s+/g, '');
  const compactBase = baseBeforeParen.replace(/\s+/g, '');

  if (profile.role === 'admin' && (u === 'admin' || u === 'administrador' || u === 'admin general')) {
    return true;
  }

  return (
    u === full ||
    u === baseBeforeParen ||
    compactU === compactFull ||
    compactU === compactBase
  );
}

/**
 * Login por Usuario + código PIN con control de Rate Limiting (máx 5 intentos fallidos en 5 minutos por device_id)
 * y verificación de cuenta revocada.
 */
export async function loginWithPin(
  pin: string,
  deviceId: string,
  username?: string
): Promise<Profile> {
  await ensureLocalSeed();
  const cleanPin = pin.trim();
  const nowMs = Date.now();
  const fiveMinutesAgoMs = nowMs - 5 * 60 * 1000;

  if (username !== undefined && !username.trim()) {
    throw new Error('Ingresá tu nombre de usuario.');
  }

  const recentAttempts = await db.login_attempts
    .where('device_id')
    .equals(deviceId)
    .filter((a) => !a.success && a.attempted_at_ms > fiveMinutesAgoMs)
    .count();

  if (recentAttempts >= 5) {
    throw new Error(
      'Demasiados intentos fallidos desde este dispositivo. Esperá 5 minutos por seguridad.'
    );
  }

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    const { data: rpcData, error: rpcError } = await supabase.rpc('resolve_pin_login', {
      p_pin: cleanPin,
      p_device_id: deviceId,
    });

    if (rpcError) {
      await db.login_attempts.add({
        device_id: deviceId,
        attempted_at_ms: nowMs,
        success: false,
      });
      throw new Error('Usuario o PIN inválido.');
    }

    const email = rpcData?.synthetic_email as string | undefined;
    if (email) {
      // Intentar sesión GoTrue opcional (si existe en auth.users); si falla o es un PIN nuevo, continúa con perfil validado por RPC
      await supabase.auth
        .signInWithPassword({
          email,
          password: cleanPin,
        })
        .catch(() => {});

      const { data: profData, error: profError } = await supabase
        .from('profiles')
        .select('*')
        .eq('pin_code', cleanPin)
        .maybeSingle();

      if (!profError && profData) {
        const remoteProfile = profData as Profile;
        if (!doesUsernameMatchProfile(username, remoteProfile)) {
          await db.login_attempts.add({
            device_id: deviceId,
            attempted_at_ms: nowMs,
            success: false,
          });
          throw new Error('El nombre de usuario no coincide con ese PIN.');
        }

        await db.profiles.put(remoteProfile);
        await db.login_attempts.add({
          device_id: deviceId,
          attempted_at_ms: nowMs,
          success: true,
        });
        return remoteProfile;
      }
    }
  }

  const profile = await db.profiles.where('pin_code').equals(cleanPin).first();

  if (!profile || !doesUsernameMatchProfile(username, profile)) {
    await db.login_attempts.add({
      device_id: deviceId,
      attempted_at_ms: nowMs,
      success: false,
    });
    const remaining = Math.max(0, 4 - recentAttempts);
    throw new Error(`Usuario o PIN incorrecto. Intentos restantes: ${remaining}.`);
  }

  if (profile.revoked) {
    throw new Error('Este usuario/PIN fue revocado por el administrador.');
  }

  await db.login_attempts.add({
    device_id: deviceId,
    attempted_at_ms: nowMs,
    success: true,
  });

  return profile;
}

export async function getLocalRaceBundleFast(
  raceId: string = DEFAULT_RACE_ID
): Promise<RaceBundle> {
  await ensureLocalSeed();
  const [race, categories, entries, profiles, raceStart, finishEvents, rawAuditLogs] =
    await Promise.all([
      db.races.get(raceId),
      db.categories.where('race_id').equals(raceId).sortBy('sort_order'),
      db.entries.where('race_id').equals(raceId).sortBy('bib'),
      db.profiles.toArray(),
      db.race_start.where('race_id').equals(raceId).first(),
      db.finish_events.where('race_id').equals(raceId).toArray(),
      db.audit_log.where('race_id').equals(raceId).toArray(),
    ]);

  const auditLogs = rawAuditLogs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const profileMap = new Map(profiles.map((p) => [p.id, p.display_name]));
  const enrichedLogs = auditLogs.map((l) => ({
    ...l,
    actor_name: profileMap.get(l.actor_id) || 'Sistema / Staff',
  }));

  return {
    race: race || DEFAULT_RACE,
    categories,
    entries,
    profiles,
    raceStart: raceStart || null,
    finishEvents,
    auditLogs: enrichedLogs,
  };
}

let activeBundleSyncPromise: Promise<void> | null = null;

export async function getRaceBundle(raceId: string = DEFAULT_RACE_ID): Promise<RaceBundle> {
  await ensureLocalSeed();

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    if (!activeBundleSyncPromise) {
      activeBundleSyncPromise = (async () => {
        try {
          const [raceRes, catRes, entRes, profRes, startRes, evRes, audRes] = await Promise.all([
            supabase.from('races').select('*').eq('id', raceId).maybeSingle(),
            supabase.from('categories').select('*').eq('race_id', raceId).order('sort_order'),
            supabase.from('entries').select('*').eq('race_id', raceId).order('bib'),
            supabase.from('profiles').select('*'),
            supabase.from('race_start').select('*').eq('race_id', raceId).maybeSingle(),
            supabase.from('finish_events').select('*').eq('race_id', raceId),
            supabase
              .from('audit_log')
              .select('*')
              .eq('race_id', raceId)
              .order('created_at', { ascending: false })
              .limit(150),
          ]);

          const mutationLocked = Date.now() < localMutationLockUntilMs;

          await db.transaction(
            'rw',
            [
              db.races,
              db.categories,
              db.entries,
              db.profiles,
              db.race_start,
              db.finish_events,
              db.audit_log,
            ],
            async () => {
              if (!mutationLocked && raceRes.data) await db.races.put(raceRes.data as Race);
              if (!catRes.error && catRes.data?.length) {
                await db.categories.where('race_id').equals(raceId).delete();
                await db.categories.bulkPut(catRes.data as Category[]);
              }
              if (!entRes.error && entRes.data) {
                await db.entries.where('race_id').equals(raceId).delete();
                if (entRes.data.length) await db.entries.bulkPut(entRes.data as Entry[]);
              }
              if (profRes.data?.length) await db.profiles.bulkPut(profRes.data as Profile[]);
              if (!mutationLocked && !startRes.error) {
                await db.race_start.where('race_id').equals(raceId).delete();
                if (startRes.data) await db.race_start.put(startRes.data as RaceStart);
              }
              if (!mutationLocked && !evRes.error && evRes.data) {
                const activeRemote = (evRes.data as FinishEvent[])
                  .filter((ev) => ev.void_reason !== 'Reinicio de prueba por Admin' && ev.status !== 'void')
                  .map((ev) => ({
                    ...ev,
                    sync_state: 'synced' as const,
                  }));
                const localUnsynced = (
                  await db.finish_events.where('race_id').equals(raceId).toArray()
                ).filter((ev) => ev.sync_state !== 'synced');
                await db.finish_events.where('race_id').equals(raceId).delete();
                if (activeRemote.length) await db.finish_events.bulkPut(activeRemote);
                if (localUnsynced.length) await db.finish_events.bulkPut(localUnsynced);
              }
              if (audRes.data?.length) await db.audit_log.bulkPut(audRes.data as AuditLogEntry[]);
            }
          );
        } catch {
          // Operar 100% con IndexedDB si no hay red
        }
      })().finally(() => {
        activeBundleSyncPromise = null;
      });
    }
    await activeBundleSyncPromise;
  }

  return getLocalRaceBundleFast(raceId);
}

let lastClockSignature = '';
let lastEventsSignature = '';
let liveSyncInitialized = false;
let isSyncingLive = false;
let localMutationLockUntilMs = 0;
let liveRealtimeChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;

function markLocalMutationInFlight(durationMs: number = 3500) {
  localMutationLockUntilMs = Date.now() + durationMs;
  lastClockSignature = '';
  lastEventsSignature = '';
}

function broadcastLiveSignal(kind: string) {
  if (!liveRealtimeChannel) return;
  try {
    void liveRealtimeChannel.send({
      type: 'broadcast',
      event: 'skol_sync',
      payload: { kind, ts: Date.now() },
    });
  } catch {
    // Fallback por polling
  }
}

/**
 * Sincronización ultra-liviana cada 1s + WebSocket Broadcast/Realtime para que la largada, pausa,
 * reinicio y dorsales se reflejen automáticamente en todos los celulares del staff sin refrescar.
 */
export async function syncLiveRaceStateFromRemote(
  raceId: string = DEFAULT_RACE_ID,
  forceBypassLock: boolean = false
): Promise<boolean> {
  if (
    !isSupabaseConfigured ||
    !supabase ||
    (typeof navigator !== 'undefined' && navigator.onLine === false)
  ) {
    return false;
  }

  if (isSyncingLive) return false;
  if (!forceBypassLock && Date.now() < localMutationLockUntilMs) {
    return false;
  }

  isSyncingLive = true;
  try {
    const [raceRes, startRes, evRes] = await Promise.all([
      supabase.from('races').select('*').eq('id', raceId).maybeSingle(),
      supabase.from('race_start').select('*').eq('race_id', raceId).maybeSingle(),
      supabase.from('finish_events').select('*').eq('race_id', raceId),
    ]);

    if (!forceBypassLock && Date.now() < localMutationLockUntilMs) {
      return false;
    }

    if (raceRes.error || startRes.error || evRes.error) return false;

    const activeRemoteEvents = ((evRes.data as FinishEvent[]) || []).filter(
      (ev) => ev.void_reason !== 'Reinicio de prueba por Admin' && ev.status !== 'void'
    );

    const clockSig = JSON.stringify({
      rStatus: raceRes.data?.status ?? null,
      sId: startRes.data?.id ?? null,
      sTs: startRes.data?.ts_utc_ms ?? null,
      sReason: startRes.data?.reason ?? null,
    });

    const eventsSig = activeRemoteEvents
      .map((e) => `${e.id}:${e.status}:${e.bib ?? 'null'}:${e.ts_utc_ms}`)
      .sort()
      .join('|');

    const clockChanged = clockSig !== lastClockSignature;
    const eventsChanged = eventsSig !== lastEventsSignature;

    if (!clockChanged && !eventsChanged) {
      return false;
    }

    lastClockSignature = clockSig;
    lastEventsSignature = eventsSig;

    if (clockChanged) {
      await db.transaction('rw', [db.races, db.race_start], async () => {
        if (raceRes.data) {
          await db.races.put(raceRes.data as Race);
        }
        await db.race_start.where('race_id').equals(raceId).delete();
        if (startRes.data) {
          await db.race_start.put(startRes.data as RaceStart);
        }
      });
    }

    if (eventsChanged) {
      await db.transaction('rw', [db.finish_events], async () => {
        const localUnsynced = (
          await db.finish_events.where('race_id').equals(raceId).toArray()
        ).filter((ev) => ev.sync_state !== 'synced');
        await db.finish_events.where('race_id').equals(raceId).delete();
        if (activeRemoteEvents.length) {
          await db.finish_events.bulkPut(
            activeRemoteEvents.map((ev) => ({ ...ev, sync_state: 'synced' as const }))
          );
        }
        if (localUnsynced.length) {
          await db.finish_events.bulkPut(localUnsynced);
        }
      });
    }

    notifyLocalRealtimeChange('remote_live_sync');
    return true;
  } catch {
    return false;
  } finally {
    isSyncingLive = false;
  }
}

export function startRealtimeRaceSync(raceId: string = DEFAULT_RACE_ID): () => void {
  if (liveSyncInitialized || typeof window === 'undefined') return () => {};
  liveSyncInitialized = true;

  if (isSupabaseConfigured && supabase) {
    try {
      liveRealtimeChannel = supabase
        .channel('skol-classic-live-channel', {
          config: { broadcast: { self: false } },
        })
        .on('broadcast', { event: 'skol_sync' }, (msg) => {
          const kind = (msg?.payload as { kind?: string } | undefined)?.kind;
          if (kind === 'entries_cleared' || kind === 'entries_imported') {
            void getRaceBundle(raceId).then(() => notifyLocalRealtimeChange('entries'));
          }
          void syncLiveRaceStateFromRemote(raceId, true);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'races' }, () => {
          void syncLiveRaceStateFromRemote(raceId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'race_start' }, () => {
          void syncLiveRaceStateFromRemote(raceId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'finish_events' }, () => {
          void syncLiveRaceStateFromRemote(raceId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, () => {
          void getRaceBundle(raceId).then(() => notifyLocalRealtimeChange('entries'));
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, () => {
          void getRaceBundle(raceId).then(() => notifyLocalRealtimeChange('categories'));
        })
        .subscribe();
    } catch {
      // Fallback por polling
    }

    window.setInterval(() => {
      void syncLiveRaceStateFromRemote(raceId);
    }, 1000);
  }
  return () => {};
}

export async function updateRaceConfig(
  raceId: string,
  patch: Partial<
    Pick<
      Race,
      | 'name'
      | 'location'
      | 'race_date'
      | 'status'
      | 'net_time_enabled'
      | 'duplicate_threshold_ms'
      | 'screen_groups'
    >
  >,
  actorId: string
): Promise<Race> {
  const existing = (await db.races.get(raceId)) || DEFAULT_RACE;
  const updated: Race = {
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  await db.races.put(updated);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('races').upsert(updated);
  }

  await appendAuditLog({
    race_id: raceId,
    actor_id: actorId,
    action: 'RACE_CONFIG_UPDATED',
    entity_table: 'races',
    entity_id: raceId,
    before_data: {
      name: existing.name,
      status: existing.status,
      net_time_enabled: existing.net_time_enabled,
    },
    after_data: {
      name: updated.name,
      status: updated.status,
      net_time_enabled: updated.net_time_enabled,
    },
    reason: 'Actualización de configuración de carrera desde panel Admin',
  });

  notifyLocalRealtimeChange('races');
  return updated;
}

export async function saveCategory(
  category: Omit<Category, 'id'> & { id?: string },
  actorId: string
): Promise<Category> {
  const isNew = !category.id;
  const saved: Category = {
    ...category,
    id: category.id || crypto.randomUUID(),
  };

  if (saved.bib_range_end < saved.bib_range_start) {
    throw new Error('El fin de rango de dorsales debe ser mayor o igual al inicio.');
  }

  await db.categories.put(saved);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('categories').upsert(saved);
  }

  await appendAuditLog({
    race_id: saved.race_id,
    actor_id: actorId,
    action: isNew ? 'CATEGORY_CREATED' : 'CATEGORY_UPDATED',
    entity_table: 'categories',
    entity_id: saved.id,
    after_data: {
      name: saved.name,
      distance_km: saved.distance_km,
      bib_range: `${saved.bib_range_start}-${saved.bib_range_end} (salto ${saved.bib_step})`,
      screen_group: saved.screen_group,
    },
  });

  notifyLocalRealtimeChange('categories');
  return saved;
}

export async function deleteCategory(
  categoryId: string,
  raceId: string,
  actorId: string
): Promise<void> {
  const count = await db.entries.where('category_id').equals(categoryId).count();
  if (count > 0) {
    throw new Error(
      `No se puede eliminar la categoría porque tiene ${count} inscriptos asociados.`
    );
  }

  const existing = await db.categories.get(categoryId);
  await db.categories.delete(categoryId);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('categories').delete().eq('id', categoryId);
  }

  await appendAuditLog({
    race_id: raceId,
    actor_id: actorId,
    action: 'CATEGORY_DELETED',
    entity_table: 'categories',
    entity_id: categoryId,
    before_data: existing ? { name: existing.name } : null,
  });

  notifyLocalRealtimeChange('categories');
}

export async function saveEntry(
  input: Omit<Entry, 'id' | 'created_at' | 'updated_at'> & { id?: string },
  actorId: string
): Promise<Entry> {
  const now = new Date().toISOString();

  const collision = await db.entries
    .where('[race_id+bib]')
    .equals([input.race_id, input.bib])
    .first();

  if (collision && collision.id !== input.id) {
    throw new Error(
      `El dorsal #${input.bib} ya está asignado a "${collision.display_name}".`
    );
  }

  const existing = input.id ? await db.entries.get(input.id) : undefined;
  const saved: Entry = {
    id: input.id || crypto.randomUUID(),
    race_id: input.race_id,
    category_id: input.category_id,
    bib: input.bib,
    display_name: input.display_name.trim(),
    team_name: input.team_name ? input.team_name.trim() : null,
    members: input.members.map((m) => m.trim()).filter(Boolean),
    active: input.active,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await db.entries.put(saved);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('entries').upsert(saved);
  }

  await appendAuditLog({
    race_id: saved.race_id,
    actor_id: actorId,
    action: existing ? 'ENTRY_UPDATED' : 'ENTRY_CREATED',
    entity_table: 'entries',
    entity_id: saved.id,
    before_data: existing ? { bib: existing.bib, display_name: existing.display_name } : null,
    after_data: { bib: saved.bib, display_name: saved.display_name, active: saved.active },
  });

  notifyLocalRealtimeChange('entries');
  return saved;
}

export async function deleteEntry(
  entryId: string,
  raceId: string,
  actorId: string
): Promise<void> {
  const existing = await db.entries.get(entryId);
  if (!existing) return;

  const hasEvents = await db.finish_events
    .where('[race_id+event_type+bib]')
    .equals([raceId, 'finish', existing.bib])
    .count();

  if (hasEvents > 0) {
    throw new Error(
      `El dorsal #${existing.bib} ya tiene tiempos registrados. Desactivalo (DNS) en lugar de borrarlo.`
    );
  }

  await db.entries.delete(entryId);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('entries').delete().eq('id', entryId);
  }

  await appendAuditLog({
    race_id: raceId,
    actor_id: actorId,
    action: 'ENTRY_DELETED',
    entity_table: 'entries',
    entity_id: entryId,
    before_data: { bib: existing.bib, display_name: existing.display_name },
  });

  notifyLocalRealtimeChange('entries');
}

export async function deleteAllEntries(
  raceId: string,
  actorId: string
): Promise<number> {
  markLocalMutationInFlight(5000);
  const nowIso = new Date().toISOString();
  const existingCount = await db.entries.where('race_id').equals(raceId).count();

  await db.transaction('rw', [db.races, db.entries, db.race_start, db.finish_events], async () => {
    await db.entries.where('race_id').equals(raceId).delete();
    await db.race_start.where('race_id').equals(raceId).delete();
    await db.finish_events.where('race_id').equals(raceId).delete();
    const race = await db.races.get(raceId);
    if (race) {
      await db.races.put({ ...race, status: 'pending', updated_at: nowIso });
    }
  });

  notifyLocalRealtimeChange('all');

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    await Promise.all([
      supabase.from('race_start').delete().eq('race_id', raceId),
      supabase
        .from('finish_events')
        .update({
          status: 'void',
          void_reason: 'Reinicio de prueba por Admin',
          voided_by: actorId,
          voided_at: nowIso,
        })
        .eq('race_id', raceId)
        .neq('status', 'void'),
      supabase.from('entries').delete().eq('race_id', raceId),
      supabase.from('races').update({ status: 'pending', updated_at: nowIso }).eq('id', raceId),
    ]);
    broadcastLiveSignal('entries_cleared');
  }

  await appendAuditLog({
    race_id: raceId,
    actor_id: actorId,
    action: 'ALL_ENTRIES_DELETED',
    entity_table: 'entries',
    entity_id: raceId,
    before_data: { deleted_count: existingCount },
    reason: 'Vaciado masivo del padrón de atletas/duplas por Admin',
  });

  notifyLocalRealtimeChange('all');
  return existingCount;
}

export async function bulkImportCsvEntries(
  raceId: string,
  rows: ParsedCsvEntryRow[],
  actorId: string
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const categories = await db.categories.where('race_id').equals(raceId).toArray();
  const currentEntries = await db.entries.where('race_id').equals(raceId).toArray();
  const usedBibs = new Set<number>(currentEntries.map((e) => e.bib));
  const bibToEntry = new Map<number, Entry>(currentEntries.map((e) => [e.bib, e]));

  const toUpsert: Entry[] = [];
  const errors: string[] = [];
  let skipped = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    if (row.error) {
      errors.push(`Fila ${row.rowNumber}: ${row.error}`);
      skipped++;
      continue;
    }

    const cat = matchCategoryByInput(row.categorySlugOrName, categories);
    if (!cat) {
      errors.push(
        `Fila ${row.rowNumber}: No se encontró la categoría "${row.categorySlugOrName}".`
      );
      skipped++;
      continue;
    }

    let bib = row.bib;
    if (bib === null) {
      bib = getNextAvailableBib(cat, usedBibs);
    }

    const existingForBib = bibToEntry.get(bib);
    usedBibs.add(bib);

    const entry: Entry = {
      id: existingForBib?.id || crypto.randomUUID(),
      race_id: raceId,
      category_id: cat.id,
      bib,
      display_name: row.displayName,
      team_name: cat.is_pair ? row.teamName || row.displayName : null,
      members: cat.is_pair ? row.members : [],
      active: true,
      created_at: existingForBib?.created_at || now,
      updated_at: now,
    };

    bibToEntry.set(bib, entry);
    toUpsert.push(entry);
  }

  if (toUpsert.length > 0) {
    markLocalMutationInFlight(5000);
    await db.entries.bulkPut(toUpsert);
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
      await supabase.from('entries').upsert(toUpsert);
      void broadcastLiveSignal('entries_imported');
    }
    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'CSV_BULK_IMPORT',
      entity_table: 'entries',
      entity_id: raceId,
      after_data: { imported: toUpsert.length, skipped },
      reason: `Importación masiva CSV/Excel (${toUpsert.length} atletas/duplas)`,
    });
    notifyLocalRealtimeChange('entries');
  }

  return { imported: toUpsert.length, skipped, errors };
}

export async function reassignBibsWithStep(
  raceId: string,
  categoryId: string | 'ALL',
  actorId: string
): Promise<number> {
  const categories = await db.categories.where('race_id').equals(raceId).sortBy('sort_order');
  const targetCategories =
    categoryId === 'ALL' ? categories : categories.filter((c) => c.id === categoryId);

  const allEntries = await db.entries.where('race_id').equals(raceId).sortBy('bib');
  const updatedEntries: Entry[] = [];
  const now = new Date().toISOString();

  for (const cat of targetCategories) {
    const catEntries = allEntries.filter((e) => e.category_id === cat.id);
    const step = Math.max(1, cat.bib_step || 10);
    catEntries.forEach((entry, idx) => {
      const newBib = cat.bib_range_start + idx * step;
      if (entry.bib !== newBib) {
        updatedEntries.push({
          ...entry,
          bib: newBib,
          updated_at: now,
        });
      }
    });
  }

  if (updatedEntries.length > 0) {
    await db.entries.bulkPut(updatedEntries);
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
      await supabase.from('entries').upsert(updatedEntries);
    }
    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'BIBS_REASSIGNED_WITH_STEP',
      entity_table: 'entries',
      entity_id: categoryId,
      after_data: { updated_count: updatedEntries.length },
      reason: 'Reasignación automática de dorsales con salto por categoría',
    });
    notifyLocalRealtimeChange('entries');
  }

  return updatedEntries.length;
}

export async function saveTimekeeperProfile(
  input: {
    id?: string;
    race_id: string;
    display_name: string;
    role: 'admin' | 'timekeeper';
    pin_code: string;
    assigned_screens: number[];
  },
  actorId: string
): Promise<Profile> {
  const cleanPin = input.pin_code.trim();
  if (!/^\d{4,8}$/.test(cleanPin)) {
    throw new Error('El PIN debe tener entre 4 y 8 dígitos numéricos.');
  }

  const collision = await db.profiles.where('pin_code').equals(cleanPin).first();
  if (collision && collision.id !== input.id) {
    throw new Error(`El PIN ${cleanPin} ya está asignado a "${collision.display_name}".`);
  }

  const existing = input.id ? await db.profiles.get(input.id) : undefined;
  const saved: Profile = {
    id: input.id || crypto.randomUUID(),
    race_id: input.race_id,
    display_name: input.display_name.trim(),
    role: input.role,
    pin_code: cleanPin,
    synthetic_email:
      input.role === 'admin'
        ? `admin_${cleanPin}@carrera.skol.local`
        : `crono_${cleanPin}@carrera.skol.local`,
    assigned_screens:
      input.assigned_screens.length > 0 ? input.assigned_screens : [1, 2, 3, 4],
    revoked: existing?.revoked ?? false,
    created_at: existing?.created_at || new Date().toISOString(),
  };

  await db.profiles.put(saved);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('profiles').upsert(saved);
  }

  await appendAuditLog({
    race_id: input.race_id,
    actor_id: actorId,
    action: existing ? 'PROFILE_UPDATED' : 'PROFILE_CREATED',
    entity_table: 'profiles',
    entity_id: saved.id,
    after_data: {
      display_name: saved.display_name,
      role: saved.role,
      assigned_screens: saved.assigned_screens,
    },
  });

  notifyLocalRealtimeChange('profiles');
  return saved;
}

export async function toggleRevokeProfile(
  profileId: string,
  revoked: boolean,
  raceId: string,
  actorId: string
): Promise<Profile> {
  const existing = await db.profiles.get(profileId);
  if (!existing) throw new Error('Perfil no encontrado.');

  if (existing.id === actorId && revoked) {
    throw new Error('No podés revocar tu propio usuario administrador en sesión.');
  }

  const updated: Profile = {
    ...existing,
    revoked,
  };

  await db.profiles.put(updated);

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    await supabase.from('profiles').update({ revoked }).eq('id', profileId);
  }

  await appendAuditLog({
    race_id: raceId,
    actor_id: actorId,
    action: revoked ? 'TIMEKEEPER_REVOKED' : 'TIMEKEEPER_RESTORED',
    entity_table: 'profiles',
    entity_id: profileId,
    before_data: { revoked: existing.revoked, display_name: existing.display_name },
    after_data: { revoked: updated.revoked, display_name: updated.display_name },
    reason: revoked ? 'Revocación de PIN de cronometrista' : 'Reactivación de PIN',
  });

  notifyLocalRealtimeChange('profiles');
  return updated;
}

export async function clearRaceTimesOnly(raceId: string, actorId: string): Promise<void> {
  markLocalMutationInFlight(4500);
  const nowIso = new Date().toISOString();

  await db.transaction('rw', [db.races, db.race_start, db.finish_events], async () => {
    await db.race_start.where('race_id').equals(raceId).delete();
    await db.finish_events.where('race_id').equals(raceId).delete();
    const race = await db.races.get(raceId);
    if (race) {
      await db.races.put({ ...race, status: 'pending', updated_at: nowIso });
    }
  });

  notifyLocalRealtimeChange('all');

  void (async () => {
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await Promise.all([
        supabase.from('race_start').delete().eq('race_id', raceId),
        supabase
          .from('finish_events')
          .update({
            status: 'void',
            void_reason: 'Reinicio de prueba por Admin',
            voided_by: actorId,
            voided_at: nowIso,
          })
          .eq('race_id', raceId)
          .neq('status', 'void'),
        supabase
          .from('races')
          .update({ status: 'pending', updated_at: nowIso })
          .eq('id', raceId),
      ]);
      broadcastLiveSignal('race_reset');
    }

    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'TEST_TIMES_CLEARED',
      entity_table: 'finish_events',
      entity_id: raceId,
      reason: 'Limpieza de largada y tiempos de prueba manteniendo inscriptos y categorías',
    });
  })();
}

export async function resetDemoRaceData(actorId: string): Promise<void> {
  markLocalMutationInFlight(5000);
  const defaultEntries = generateDefaultEntries();
  await db.transaction(
    'rw',
    [db.races, db.categories, db.entries, db.profiles, db.race_start, db.finish_events, db.audit_log],
    async () => {
      await db.races.clear();
      await db.categories.clear();
      await db.entries.clear();
      await db.profiles.clear();
      await db.race_start.clear();
      await db.finish_events.clear();
      await db.audit_log.clear();

      await db.races.put(DEFAULT_RACE);
      await db.categories.bulkPut(DEFAULT_CATEGORIES);
      await db.entries.bulkPut(defaultEntries);
      await db.profiles.bulkPut(DEFAULT_PROFILES);
    }
  );

  notifyLocalRealtimeChange('all');

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    await supabase.from('race_start').delete().eq('race_id', DEFAULT_RACE_ID);
    await supabase
      .from('finish_events')
      .update({
        status: 'void',
        void_reason: 'Reinicio de prueba por Admin',
        voided_by: actorId,
        voided_at: new Date().toISOString(),
      })
      .eq('race_id', DEFAULT_RACE_ID)
      .neq('status', 'void');
    await supabase.from('entries').delete().eq('race_id', DEFAULT_RACE_ID);
    await supabase.from('categories').delete().eq('race_id', DEFAULT_RACE_ID);
    await supabase.from('races').upsert(DEFAULT_RACE);
    await supabase.from('categories').upsert(DEFAULT_CATEGORIES);
    await supabase.from('entries').upsert(defaultEntries);
    broadcastLiveSignal('demo_reset');
  }

  await appendAuditLog({
    race_id: DEFAULT_RACE_ID,
    actor_id: actorId,
    action: 'DEMO_DATA_RESET',
    entity_table: 'races',
    entity_id: DEFAULT_RACE_ID,
    reason: 'Restauración de datos iniciales (8 categorías oficiales, 120 inscriptos)',
  });

  notifyLocalRealtimeChange('all');
}

// ============================================================================
// ETAPA 3: LARGADA ÚNICA, REGISTRO DE CUADRADOS, DESHACER 10S Y MODO B
// ============================================================================

/**
 * Dispara la LARGADA ÚNICA de toda la carrera (4 km Duplas + 6 km Individuales).
 * Solo Admin. Respuesta local en 0ms y sincronización paralela inmediata.
 */
export async function triggerRaceStart(
  raceId: string,
  actorId: string,
  overrideTsUtcMs?: number
): Promise<RaceStart> {
  const actor = await db.profiles.get(actorId);
  if (!actor || actor.role !== 'admin' || actor.revoked) {
    throw new Error('Solo el administrador activo puede largar la carrera.');
  }

  markLocalMutationInFlight(4500);

  const existing = await db.race_start.where('race_id').equals(raceId).first();
  const tsUtcMs = overrideTsUtcMs ?? getCorrectedNowMs();
  const nowIso = new Date().toISOString();

  const startRecord: RaceStart = {
    id: existing?.id || crypto.randomUUID(),
    race_id: raceId,
    ts_utc_ms: tsUtcMs,
    user_id: actorId,
    corrected_by: null,
    reason: null,
    created_at: existing?.created_at || nowIso,
    updated_at: nowIso,
  };

  const race = (await db.races.get(raceId)) || DEFAULT_RACE;
  const updatedRace: Race = { ...race, status: 'running', updated_at: nowIso };

  await db.transaction('rw', [db.race_start, db.races], async () => {
    await db.race_start.where('race_id').equals(raceId).delete();
    await db.race_start.put(startRecord);
    await db.races.put(updatedRace);
  });

  notifyLocalRealtimeChange('race_start');

  void (async () => {
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await Promise.all([
        supabase.from('race_start').upsert(startRecord, { onConflict: 'race_id' }),
        supabase.from('races').upsert(updatedRace),
      ]);
      broadcastLiveSignal('race_started');
    }

    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'RACE_START',
      entity_table: 'race_start',
      entity_id: startRecord.id,
      before_data: null,
      after_data: { ts_utc_ms: tsUtcMs, user_id: actorId },
      reason: 'Largada única oficial de la carrera',
    });
  })();

  return startRecord;
}

/**
 * Corrección manual de la hora de largada (solo Admin, con motivo obligatorio y auditoría).
 */
export async function correctRaceStart(
  raceId: string,
  newTsUtcMs: number,
  reason: string,
  actorId: string
): Promise<RaceStart> {
  const actor = await db.profiles.get(actorId);
  if (!actor || actor.role !== 'admin' || actor.revoked) {
    throw new Error('Solo el administrador puede corregir la hora de largada.');
  }

  const cleanReason = reason.trim();
  if (cleanReason.length < 5) {
    throw new Error('Debés ingresar un motivo detallado (mínimo 5 caracteres) para auditar el cambio.');
  }

  const existing = await db.race_start.where('race_id').equals(raceId).first();
  if (!existing) {
    throw new Error('La carrera aún no fue largada.');
  }

  markLocalMutationInFlight(4500);

  const updated: RaceStart = {
    ...existing,
    ts_utc_ms: newTsUtcMs,
    corrected_by: actorId,
    reason: cleanReason,
    updated_at: new Date().toISOString(),
  };

  await db.race_start.put(updated);
  notifyLocalRealtimeChange('race_start');

  void (async () => {
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await supabase.from('race_start').upsert(updated, { onConflict: 'race_id' });
      broadcastLiveSignal('race_corrected');
    }

    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'RACE_START_CORRECTED',
      entity_table: 'race_start',
      entity_id: updated.id,
      before_data: { ts_utc_ms: existing.ts_utc_ms, reason: existing.reason },
      after_data: { ts_utc_ms: updated.ts_utc_ms, reason: updated.reason },
      reason: cleanReason,
    });
  })();

  return updated;
}

/**
 * Devuelve los milisegundos transcurridos congelados si el cronómetro está en pausa (`PAUSED:<ms>`),
 * o `null` si está corriendo normalmente.
 */
export function parsePausedElapsedMs(raceStart: RaceStart | null | undefined): number | null {
  if (!raceStart?.reason || !raceStart.reason.startsWith('PAUSED:')) return null;
  const raw = Number(raceStart.reason.slice('PAUSED:'.length));
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * Pausa el cronómetro general de la carrera (solo Admin), congelando el tiempo transcurrido
 * en todos los dispositivos conectados en tiempo real.
 */
export async function pauseRaceClock(raceId: string, actorId: string): Promise<RaceStart> {
  const actor = await db.profiles.get(actorId);
  if (!actor || actor.role !== 'admin' || actor.revoked) {
    throw new Error('Solo el administrador puede pausar el cronómetro.');
  }

  const existing = await db.race_start.where('race_id').equals(raceId).first();
  if (!existing) {
    throw new Error('La carrera aún no fue largada.');
  }

  const alreadyPaused = parsePausedElapsedMs(existing);
  if (alreadyPaused !== null) return existing;

  markLocalMutationInFlight(4500);

  const elapsedMs = Math.max(0, Math.round(getCorrectedNowMs() - existing.ts_utc_ms));
  const nowIso = new Date().toISOString();
  const pauseReason = `PAUSED:${elapsedMs}`;

  const updated: RaceStart = {
    ...existing,
    corrected_by: actorId,
    reason: pauseReason,
    updated_at: nowIso,
  };

  await db.race_start.put(updated);
  notifyLocalRealtimeChange('race_start');

  void (async () => {
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await supabase.from('race_start').upsert(updated, { onConflict: 'race_id' });
      broadcastLiveSignal('race_paused');
    }

    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'RACE_CLOCK_PAUSED',
      entity_table: 'race_start',
      entity_id: updated.id,
      before_data: { ts_utc_ms: existing.ts_utc_ms, reason: existing.reason },
      after_data: { elapsed_paused_ms: elapsedMs, reason: pauseReason },
      reason: 'Pausa manual del cronómetro oficial por Admin',
    });
  })();

  return updated;
}

/**
 * Reanuda el cronómetro general de la carrera desde el tiempo donde fue pausado (solo Admin).
 */
export async function resumeRaceClock(raceId: string, actorId: string): Promise<RaceStart> {
  const actor = await db.profiles.get(actorId);
  if (!actor || actor.role !== 'admin' || actor.revoked) {
    throw new Error('Solo el administrador puede reanudar el cronómetro.');
  }

  const existing = await db.race_start.where('race_id').equals(raceId).first();
  if (!existing) {
    throw new Error('La carrera aún no fue largada.');
  }

  markLocalMutationInFlight(4500);

  const pausedMs = parsePausedElapsedMs(existing);
  const newTsUtcMs =
    pausedMs !== null ? Math.round(getCorrectedNowMs() - pausedMs) : existing.ts_utc_ms;
  const nowIso = new Date().toISOString();

  const updated: RaceStart = {
    ...existing,
    ts_utc_ms: newTsUtcMs,
    corrected_by: actorId,
    reason: null,
    updated_at: nowIso,
  };

  await db.race_start.put(updated);

  const race = await db.races.get(raceId);
  const updatedRace =
    race && race.status !== 'running'
      ? { ...race, status: 'running' as const, updated_at: nowIso }
      : null;

  if (updatedRace) {
    await db.races.put(updatedRace);
  }

  notifyLocalRealtimeChange('race_start');

  void (async () => {
    if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      await Promise.all([
        supabase.from('race_start').upsert(updated, { onConflict: 'race_id' }),
        updatedRace ? supabase.from('races').upsert(updatedRace) : Promise.resolve(),
      ]);
      broadcastLiveSignal('race_resumed');
    }

    await appendAuditLog({
      race_id: raceId,
      actor_id: actorId,
      action: 'RACE_CLOCK_RESUMED',
      entity_table: 'race_start',
      entity_id: updated.id,
      before_data: { ts_utc_ms: existing.ts_utc_ms, reason: existing.reason },
      after_data: { ts_utc_ms: updated.ts_utc_ms, reason: null },
      reason: 'Reanudación del cronómetro oficial por Admin',
    });
  })();

  return updated;
}

/**
 * Registra un evento de llegada (o paso por largada para tiempo neto) en modo Offline-First:
 * 1. Genera UUID en el cliente (idempotente).
 * 2. Evalúa en la transacción local IndexedDB si es 'valid', 'duplicate' o 'unassigned' (Modo B)
 *    conservando SIEMPRE el timestamp más temprano como 'valid'.
 * 3. Sincroniza en segundo plano con Supabase si hay conexión.
 */
export async function recordFinishEvent(params: {
  id?: string;
  race_id: string;
  event_type?: EventType;
  bib: number | null;
  ts_utc_ms?: number;
  clock_offset_ms?: number;
  device_id: string;
  user_id: string;
}): Promise<FinishEvent> {
  const actor = await db.profiles.get(params.user_id);
  if (!actor || actor.revoked) {
    throw new Error('Tu usuario o PIN fue revocado. No podés registrar tiempos.');
  }

  markLocalMutationInFlight(3500);

  const race = (await db.races.get(params.race_id)) || DEFAULT_RACE;
  const eventType: EventType = params.event_type || 'finish';
  const offsetMs = params.clock_offset_ms ?? getClockOffsetMs();
  const tsUtcMs = params.ts_utc_ms ?? getCorrectedNowMs();
  const nowIso = new Date().toISOString();
  const eventId = params.id || crypto.randomUUID();

  // Si tiene dorsal, verificar que exista en entries
  if (params.bib !== null) {
    const entry = await db.entries
      .where('[race_id+bib]')
      .equals([params.race_id, params.bib])
      .first();
    if (!entry) {
      throw new Error(`El dorsal #${params.bib} no existe en el padrón de esta carrera.`);
    }
  }

  let savedEvent!: FinishEvent;

  await db.transaction('rw', [db.finish_events, db.audit_log], async () => {
    // Idempotencia por UUID
    const alreadyById = await db.finish_events.get(eventId);
    if (alreadyById) {
      savedEvent = alreadyById;
      return;
    }

    if (params.bib === null) {
      savedEvent = {
        id: eventId,
        race_id: params.race_id,
        event_type: eventType,
        bib: null,
        ts_utc_ms: tsUtcMs,
        clock_offset_ms: offsetMs,
        device_id: params.device_id,
        user_id: params.user_id,
        status: 'unassigned',
        high_discrepancy: false,
        void_reason: null,
        voided_by: null,
        voided_at: null,
        assigned_by: null,
        assigned_at: null,
        created_at: nowIso,
        synced_at: null,
        sync_state: 'pending',
      };
      await db.finish_events.put(savedEvent);
      return;
    }

    const existingForBib = await db.finish_events
      .where('[race_id+event_type+bib]')
      .equals([params.race_id, eventType, params.bib])
      .toArray();

    const currentValid = existingForBib.find((e) => e.status === 'valid');
    const threshold = race.duplicate_threshold_ms || 2000;

    let status: EventStatus = 'valid';
    let highDiscrepancy = false;

    if (!currentValid) {
      status = 'valid';
      highDiscrepancy = false;
    } else if (tsUtcMs >= currentValid.ts_utc_ms) {
      status = 'duplicate';
      highDiscrepancy = tsUtcMs - currentValid.ts_utc_ms > threshold;
    } else {
      // El nuevo registro tiene un timestamp ANTERIOR al 'valid' actual -> promueve el más temprano
      await db.finish_events.put({
        ...currentValid,
        status: 'duplicate',
        high_discrepancy: currentValid.ts_utc_ms - tsUtcMs > threshold,
      });
      status = 'valid';
      highDiscrepancy = false;

      await db.audit_log.put({
        id: crypto.randomUUID(),
        race_id: params.race_id,
        actor_id: params.user_id,
        action: 'EARLIER_OFFLINE_SYNC_PROMOTED',
        entity_table: 'finish_events',
        entity_id: eventId,
        before_data: {
          previous_valid_event_id: currentValid.id,
          previous_ts_utc_ms: currentValid.ts_utc_ms,
        },
        after_data: {
          new_valid_event_id: eventId,
          new_ts_utc_ms: tsUtcMs,
          bib: params.bib,
        },
        reason: 'Registro con timestamp más temprano promovido automáticamente a válido',
        created_at: nowIso,
      });
    }

    savedEvent = {
      id: eventId,
      race_id: params.race_id,
      event_type: eventType,
      bib: params.bib,
      ts_utc_ms: tsUtcMs,
      clock_offset_ms: offsetMs,
      device_id: params.device_id,
      user_id: params.user_id,
      status,
      high_discrepancy: highDiscrepancy,
      void_reason: null,
      voided_by: null,
      voided_at: null,
      assigned_by: null,
      assigned_at: null,
      created_at: nowIso,
      synced_at: null,
      sync_state: 'pending',
    };

    await db.finish_events.put(savedEvent);
  });

  notifyLocalRealtimeChange('finish_events');

  // Sincronización inmediata en segundo plano
  void trySyncSingleEvent(savedEvent.id);

  return savedEvent;
}

export async function trySyncSingleEvent(eventId: string): Promise<boolean> {
  const ev = await db.finish_events.get(eventId);
  if (!ev || ev.sync_state === 'synced') return true;

  const isSimOffline =
    typeof window !== 'undefined' &&
    window.localStorage.getItem('skol_crono_simulated_offline') === 'true';
  const isOnline =
    !isSimOffline &&
    (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  if (!isOnline) return false;

  if (!isSupabaseConfigured || !supabase) {
    // En Modo Local sin backend remoto, una vez persistido en IndexedDB con conexión activa pasa a 'synced'
    const syncedIso = new Date().toISOString();
    await db.finish_events.update(eventId, {
      sync_state: 'synced',
      synced_at: syncedIso,
      last_sync_error: null,
    });
    notifyLocalRealtimeChange('finish_events');
    return true;
  }

  try {
    await db.finish_events.update(eventId, { sync_state: 'syncing' });
    const { data, error } = await supabase
      .from('finish_events')
      .upsert(
        {
          id: ev.id,
          race_id: ev.race_id,
          event_type: ev.event_type,
          bib: ev.bib,
          ts_utc_ms: ev.ts_utc_ms,
          clock_offset_ms: ev.clock_offset_ms,
          device_id: ev.device_id,
          user_id: ev.user_id,
          status: ev.status,
          void_reason: ev.void_reason,
          created_at: ev.created_at,
        },
        { onConflict: 'id' }
      )
      .select('*')
      .single();

    if (error) throw error;

    await db.finish_events.put({
      ...(data as FinishEvent),
      sync_state: 'synced',
      last_sync_error: null,
    });
    broadcastLiveSignal('finish_event');
    notifyLocalRealtimeChange('finish_events');
    return true;
  } catch (err) {
    await db.finish_events.update(eventId, {
      sync_state: 'pending',
      last_sync_error: err instanceof Error ? err.message : 'Error de red',
    });
    notifyLocalRealtimeChange('finish_events');
    return false;
  }
}

/**
 * Deshacer rápido (ventana de 10 segundos en UI / 15 segundos en servidor con holgura)
 * por el propio cronometrista que capturó el toque.
 */
export async function undoOwnFinishEvent(
  eventId: string,
  deviceId: string,
  actorId: string
): Promise<FinishEvent> {
  const ev = await db.finish_events.get(eventId);
  if (!ev) throw new Error('El registro no existe.');

  if (ev.user_id !== actorId || ev.device_id !== deviceId) {
    throw new Error('Solo podés deshacer registros tomados por tu propio usuario y dispositivo.');
  }

  const elapsedMs = getCorrectedNowMs() - ev.ts_utc_ms;
  if (elapsedMs > 15000) {
    throw new Error(
      'Pasaron más de 10 segundos. Solo el administrador puede anularlo definitivamente.'
    );
  }

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    const { data, error } = await supabase.rpc('undo_own_finish_event', {
      p_event_id: eventId,
      p_device_id: deviceId,
    });
    if (!error && data) {
      await db.finish_events.put({ ...(data as FinishEvent), sync_state: 'synced' });
      notifyLocalRealtimeChange('finish_events');
      return data as FinishEvent;
    }
  }

  const nowIso = new Date().toISOString();
  let updatedEvent!: FinishEvent;
  let promotedId: string | null = null;

  await db.transaction('rw', [db.finish_events, db.audit_log], async () => {
    const wasValid = ev.status === 'valid';
    updatedEvent = {
      ...ev,
      status: 'void',
      void_reason: 'Deshacer rápido (8s) por el cronometrista',
      voided_by: actorId,
      voided_at: nowIso,
      sync_state: 'pending',
    };
    await db.finish_events.put(updatedEvent);

    // Si era 'valid' y había duplicados para ese dorsal, promover el más temprano a 'valid'
    if (wasValid && ev.bib !== null) {
      const candidates = await db.finish_events
        .where('[race_id+event_type+bib]')
        .equals([ev.race_id, ev.event_type, ev.bib])
        .filter((item) => item.status === 'duplicate')
        .sortBy('ts_utc_ms');

      if (candidates.length > 0) {
        const earliest = candidates[0];
        promotedId = earliest.id;
        await db.finish_events.put({
          ...earliest,
          status: 'valid',
          high_discrepancy: false,
          sync_state: 'pending',
        });
      }
    }
  });

  await appendAuditLog({
    race_id: ev.race_id,
    actor_id: actorId,
    action: 'EVENT_UNDO_8S',
    entity_table: 'finish_events',
    entity_id: ev.id,
    before_data: { status: ev.status, bib: ev.bib, ts_utc_ms: ev.ts_utc_ms },
    after_data: { status: 'void', promoted_duplicate_id: promotedId },
    reason: 'Deshacer rápido (8s) por el cronometrista',
  });

  notifyLocalRealtimeChange('finish_events');
  void trySyncSingleEvent(updatedEvent.id);
  if (promotedId) void trySyncSingleEvent(promotedId);
  return updatedEvent;
}

/**
 * Deshacer un registro manteniendo presionado 3 segundos sobre el dorsal (cualquier staff activo o admin),
 * permitiendo que el tiempo continúe corriendo para ese atleta/dupla.
 */
export async function undoFinishEventByLongPress(
  eventId: string,
  actorId: string
): Promise<FinishEvent> {
  const ev = await db.finish_events.get(eventId);
  if (!ev) throw new Error('El registro no existe.');

  const actor = await db.profiles.get(actorId);
  if (!actor || actor.revoked) {
    throw new Error('No tenés permisos activos para deshacer este registro.');
  }

  const nowIso = new Date().toISOString();
  let updatedEvent!: FinishEvent;
  let promotedId: string | null = null;

  await db.transaction('rw', [db.finish_events, db.audit_log], async () => {
    const wasValid = ev.status === 'valid';
    updatedEvent = {
      ...ev,
      status: 'void',
      void_reason: 'Deshacer manteniendo 3s (continúa el tiempo)',
      voided_by: actorId,
      voided_at: nowIso,
      sync_state: 'pending',
    };
    await db.finish_events.put(updatedEvent);

    if (wasValid && ev.bib !== null) {
      const candidates = await db.finish_events
        .where('[race_id+event_type+bib]')
        .equals([ev.race_id, ev.event_type, ev.bib])
        .filter((item) => item.status === 'duplicate')
        .sortBy('ts_utc_ms');

      if (candidates.length > 0) {
        const earliest = candidates[0];
        promotedId = earliest.id;
        await db.finish_events.put({
          ...earliest,
          status: 'valid',
          high_discrepancy: false,
          sync_state: 'pending',
        });
      }
    }
  });

  await appendAuditLog({
    race_id: ev.race_id,
    actor_id: actorId,
    action: 'EVENT_UNDO_HOLD_3S',
    entity_table: 'finish_events',
    entity_id: ev.id,
    before_data: { status: ev.status, bib: ev.bib, ts_utc_ms: ev.ts_utc_ms },
    after_data: { status: 'void', promoted_duplicate_id: promotedId },
    reason: 'Deshacer manteniendo presionado 3s (el tiempo continúa corriendo)',
  });

  notifyLocalRealtimeChange('finish_events');
  void trySyncSingleEvent(updatedEvent.id);
  if (promotedId) void trySyncSingleEvent(promotedId);
  return updatedEvent;
}

/**
 * Asigna un número de pechera (bib) a un tiempo capturado en Modo B ("LLEGÓ sin número").
 * Ejecutable por el mismo cronometrista que lo capturó o por un administrador.
 */
export async function assignBibToUnassignedEvent(
  eventId: string,
  bib: number,
  actorId: string
): Promise<FinishEvent> {
  const ev = await db.finish_events.get(eventId);
  if (!ev) throw new Error('Registro sin asignar no encontrado.');

  const actor = await db.profiles.get(actorId);
  if (!actor || actor.revoked) throw new Error('Usuario sin permisos.');

  if (ev.user_id !== actorId && actor.role !== 'admin') {
    throw new Error('Solo el cronometrista que capturó este tiempo o el Admin pueden asignarle dorsal.');
  }

  if (ev.status !== 'unassigned') {
    throw new Error('Este registro ya tiene dorsal asignado o fue anulado.');
  }

  const entry = await db.entries
    .where('[race_id+bib]')
    .equals([ev.race_id, bib])
    .first();

  if (!entry) {
    throw new Error(`El dorsal #${bib} no existe en la carrera.`);
  }

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    const { data, error } = await supabase.rpc('assign_bib_to_event', {
      p_event_id: eventId,
      p_bib: bib,
    });
    if (!error && data) {
      await db.finish_events.put({ ...(data as FinishEvent), sync_state: 'synced' });
      notifyLocalRealtimeChange('finish_events');
      return data as FinishEvent;
    }
  }

  const race = (await db.races.get(ev.race_id)) || DEFAULT_RACE;
  const threshold = race.duplicate_threshold_ms || 2000;
  const nowIso = new Date().toISOString();
  let updatedEvent!: FinishEvent;

  await db.transaction('rw', [db.finish_events], async () => {
    const existingForBib = await db.finish_events
      .where('[race_id+event_type+bib]')
      .equals([ev.race_id, ev.event_type, bib])
      .toArray();

    const currentValid = existingForBib.find((item) => item.status === 'valid');
    let nextStatus: EventStatus = 'valid';
    let highDisc = false;

    if (!currentValid) {
      nextStatus = 'valid';
    } else if (ev.ts_utc_ms >= currentValid.ts_utc_ms) {
      nextStatus = 'duplicate';
      highDisc = ev.ts_utc_ms - currentValid.ts_utc_ms > threshold;
    } else {
      await db.finish_events.put({
        ...currentValid,
        status: 'duplicate',
        high_discrepancy: currentValid.ts_utc_ms - ev.ts_utc_ms > threshold,
      });
      nextStatus = 'valid';
    }

    updatedEvent = {
      ...ev,
      bib,
      status: nextStatus,
      high_discrepancy: highDisc,
      assigned_by: actorId,
      assigned_at: nowIso,
    };

    await db.finish_events.put(updatedEvent);
  });

  await appendAuditLog({
    race_id: ev.race_id,
    actor_id: actorId,
    action: 'UNASSIGNED_BIB_ASSIGNED',
    entity_table: 'finish_events',
    entity_id: ev.id,
    before_data: { bib: null, status: 'unassigned' },
    after_data: { bib, status: updatedEvent.status, ts_utc_ms: ev.ts_utc_ms },
    reason: `Asignación de dorsal #${bib} a tiempo capturado en Modo B`,
  });

  notifyLocalRealtimeChange('finish_events');
  void trySyncSingleEvent(updatedEvent.id);
  return updatedEvent;
}

/**
 * Anulación o resolución definitiva de un registro por el Administrador, con motivo obligatorio.
 */
export async function adminResolveFinishEvent(
  eventId: string,
  targetStatus: EventStatus,
  reason: string,
  actorId: string
): Promise<FinishEvent> {
  const actor = await db.profiles.get(actorId);
  if (!actor || actor.role !== 'admin' || actor.revoked) {
    throw new Error('Solo el administrador puede anular o resolver registros definitivamente.');
  }

  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new Error('Debés indicar un motivo (mínimo 3 caracteres) para el registro de auditoría.');
  }

  const ev = await db.finish_events.get(eventId);
  if (!ev) throw new Error('Evento no encontrado.');

  if (isSupabaseConfigured && supabase && (typeof navigator === 'undefined' || navigator.onLine)) {
    const { data, error } = await supabase.rpc('admin_resolve_finish_event', {
      p_event_id: eventId,
      p_target_status: targetStatus,
      p_reason: cleanReason,
    });
    if (!error && data) {
      await db.finish_events.put({ ...(data as FinishEvent), sync_state: 'synced' });
      notifyLocalRealtimeChange('finish_events');
      return data as FinishEvent;
    }
  }

  const nowIso = new Date().toISOString();
  let updated!: FinishEvent;

  await db.transaction('rw', [db.finish_events], async () => {
    if (targetStatus === 'valid') {
      if (ev.bib === null) {
        throw new Error('No se puede validar un registro sin número de pechera.');
      }
      const existingValid = await db.finish_events
        .where('[race_id+event_type+bib]')
        .equals([ev.race_id, ev.event_type, ev.bib])
        .filter((item) => item.status === 'valid' && item.id !== ev.id)
        .toArray();

      for (const oldVal of existingValid) {
        await db.finish_events.put({ ...oldVal, status: 'duplicate' });
      }

      updated = {
        ...ev,
        status: 'valid',
        high_discrepancy: false,
        void_reason: null,
        voided_by: null,
        voided_at: null,
      };
      await db.finish_events.put(updated);
    } else if (targetStatus === 'void') {
      const wasValid = ev.status === 'valid';
      updated = {
        ...ev,
        status: 'void',
        void_reason: cleanReason,
        voided_by: actorId,
        voided_at: nowIso,
      };
      await db.finish_events.put(updated);

      if (wasValid && ev.bib !== null) {
        const nextDuplicates = await db.finish_events
          .where('[race_id+event_type+bib]')
          .equals([ev.race_id, ev.event_type, ev.bib])
          .filter((item) => item.status === 'duplicate')
          .sortBy('ts_utc_ms');

        if (nextDuplicates.length > 0) {
          await db.finish_events.put({
            ...nextDuplicates[0],
            status: 'valid',
            high_discrepancy: false,
          });
        }
      }
    } else {
      updated = {
        ...ev,
        status: targetStatus,
        void_reason: cleanReason,
      };
      await db.finish_events.put(updated);
    }
  });

  await appendAuditLog({
    race_id: ev.race_id,
    actor_id: actorId,
    action: 'ADMIN_EVENT_RESOLUTION',
    entity_table: 'finish_events',
    entity_id: ev.id,
    before_data: { status: ev.status, bib: ev.bib, ts_utc_ms: ev.ts_utc_ms },
    after_data: { status: updated.status, bib: updated.bib, reason: cleanReason },
    reason: cleanReason,
  });

  notifyLocalRealtimeChange('finish_events');
  void trySyncSingleEvent(updated.id);
  return updated;
}
