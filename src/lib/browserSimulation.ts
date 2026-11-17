import {
  assignBibToUnassignedEvent,
  getRaceBundle,
  recordFinishEvent,
  resetDemoRaceData,
  saveTimekeeperProfile,
  triggerRaceStart,
} from './dataService';
import { DEFAULT_RACE_ID } from './defaultSeed';

export async function runInBrowserRaceSimulation(actorId: string): Promise<{
  totalClassified: number;
  duplicatesCreated: number;
  modeBAssigned: number;
}> {
  await resetDemoRaceData(actorId);

  const offsets = [-180, -95, -40, -12, +8, +25, +64, +110, +165, +230];
  const virtualDevices: Array<{
    deviceId: string;
    profileId: string;
    screen: number;
    offsetMs: number;
  }> = [];

  for (let i = 1; i <= 10; i++) {
    const screen = ((i - 1) % 4) + 1;
    const prof = await saveTimekeeperProfile(
      {
        race_id: DEFAULT_RACE_ID,
        display_name: `Crono Virtual #${String(i).padStart(2, '0')} (P${screen})`,
        role: 'timekeeper',
        pin_code: String(5000 + i),
        assigned_screens: [screen, 1, 2, 3, 4],
      },
      actorId
    );
    virtualDevices.push({
      deviceId: `cel-virtual-${String(i).padStart(2, '0')}`,
      profileId: prof.id,
      screen,
      offsetMs: offsets[i - 1],
    });
  }

  const raceStartTs = Date.now() - 2400000;
  await triggerRaceStart(DEFAULT_RACE_ID, actorId, raceStartTs);

  const bundle = await getRaceBundle(DEFAULT_RACE_ID);
  const catMap = new Map(bundle.categories.map((c) => [c.id, c]));

  let duplicatesCreated = 0;
  let modeBAssigned = 0;

  for (let i = 0; i < bundle.entries.length; i++) {
    const entry = bundle.entries[i];
    const cat = catMap.get(entry.category_id)!;
    const minMs = cat.distance_km === 4 ? 930000 : 1290000;
    const spanMs = cat.distance_km === 4 ? 650000 : 920000;
    const elapsedMs = minMs + ((i * 5393) % spanMs);
    const finishTs = raceStartTs + elapsedMs;

    const dev =
      virtualDevices.find((d) => d.screen === cat.screen_group) ||
      virtualDevices[i % 10];

    if (i % 20 === 5) {
      const unassigned = await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: null,
        ts_utc_ms: finishTs,
        clock_offset_ms: dev.offsetMs,
        device_id: dev.deviceId,
        user_id: dev.profileId,
      });
      await assignBibToUnassignedEvent(unassigned.id, entry.bib, dev.profileId);
      modeBAssigned++;
    } else {
      await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: entry.bib,
        ts_utc_ms: finishTs,
        clock_offset_ms: dev.offsetMs,
        device_id: dev.deviceId,
        user_id: dev.profileId,
      });
    }

    if (i % 15 === 3) {
      const dev2 = virtualDevices[(i + 3) % 10];
      const deltaMs = i % 30 === 3 ? 850 : 3900;
      await recordFinishEvent({
        race_id: DEFAULT_RACE_ID,
        bib: entry.bib,
        ts_utc_ms: finishTs + deltaMs,
        clock_offset_ms: dev2.offsetMs,
        device_id: dev2.deviceId,
        user_id: dev2.profileId,
      });
      duplicatesCreated++;
    }
  }

  return {
    totalClassified: bundle.entries.length,
    duplicatesCreated,
    modeBAssigned,
  };
}
