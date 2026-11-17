import type { Category, Entry, Profile, Race } from '../types/domain';

export const DEFAULT_RACE_ID =
  (import.meta as { env?: Record<string, string> }).env?.VITE_DEFAULT_RACE_ID ||
  'a0000000-0000-4000-8000-000000000001';

export const DEFAULT_RACE: Race = {
  id: DEFAULT_RACE_ID,
  name: 'Desafío Skol Classic 2026 - 4K & 6K',
  location: 'Punto A - Circuito Principal',
  race_date: new Date().toISOString().slice(0, 10),
  status: 'pending',
  net_time_enabled: false,
  duplicate_threshold_ms: 2000,
  screen_groups: [
    { id: 1, title: 'Duplas Funcional', subtitle: '4 km (H-H · M-M)' },
    { id: 2, title: 'Duplas Scaled', subtitle: '4 km (H-H · M-M)' },
    { id: 3, title: 'Avanzado', subtitle: '6 km (H · M)' },
    { id: 4, title: 'RX', subtitle: '6 km (H · M)' },
  ],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export const DEFAULT_CATEGORIES: Category[] = [
  // PANTALLA 1: Duplas Funcional (4 km)
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    race_id: DEFAULT_RACE_ID,
    slug: 'funcional-hh',
    name: 'Funcional H-H',
    short_name: 'FUNC H-H',
    distance_km: 4,
    is_pair: true,
    bib_range_start: 100,
    bib_range_end: 290,
    bib_step: 10,
    color: '#0369A1',
    screen_group: 1,
    sort_order: 1,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    race_id: DEFAULT_RACE_ID,
    slug: 'funcional-mm',
    name: 'Funcional M-M',
    short_name: 'FUNC M-M',
    distance_km: 4,
    is_pair: true,
    bib_range_start: 300,
    bib_range_end: 490,
    bib_step: 10,
    color: '#6D28D9',
    screen_group: 1,
    sort_order: 2,
  },

  // PANTALLA 2: Duplas Scaled (4 km)
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    race_id: DEFAULT_RACE_ID,
    slug: 'scaled-hh',
    name: 'Scaled H-H',
    short_name: 'SCAL H-H',
    distance_km: 4,
    is_pair: true,
    bib_range_start: 1000,
    bib_range_end: 1190,
    bib_step: 10,
    color: '#15803D',
    screen_group: 2,
    sort_order: 3,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000004',
    race_id: DEFAULT_RACE_ID,
    slug: 'scaled-mm',
    name: 'Scaled M-M',
    short_name: 'SCAL M-M',
    distance_km: 4,
    is_pair: true,
    bib_range_start: 1200,
    bib_range_end: 1390,
    bib_step: 10,
    color: '#0F766E',
    screen_group: 2,
    sort_order: 4,
  },

  // PANTALLA 3: Avanzado Individual (6 km)
  {
    id: 'c0000000-0000-4000-8000-000000000005',
    race_id: DEFAULT_RACE_ID,
    slug: 'avanzado-h',
    name: 'Avanzado H',
    short_name: 'AVZ H',
    distance_km: 6,
    is_pair: false,
    bib_range_start: 2000,
    bib_range_end: 2190,
    bib_step: 10,
    color: '#A16207',
    screen_group: 3,
    sort_order: 5,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000006',
    race_id: DEFAULT_RACE_ID,
    slug: 'avanzado-m',
    name: 'Avanzado M',
    short_name: 'AVZ M',
    distance_km: 6,
    is_pair: false,
    bib_range_start: 2200,
    bib_range_end: 2390,
    bib_step: 10,
    color: '#C2410C',
    screen_group: 3,
    sort_order: 6,
  },

  // PANTALLA 4: RX Individual (6 km)
  {
    id: 'c0000000-0000-4000-8000-000000000007',
    race_id: DEFAULT_RACE_ID,
    slug: 'rx-h',
    name: 'RX H',
    short_name: 'RX H',
    distance_km: 6,
    is_pair: false,
    bib_range_start: 3000,
    bib_range_end: 3190,
    bib_step: 10,
    color: '#7E22CE',
    screen_group: 4,
    sort_order: 7,
  },
  {
    id: 'c0000000-0000-4000-8000-000000000008',
    race_id: DEFAULT_RACE_ID,
    slug: 'rx-m',
    name: 'RX M',
    short_name: 'RX M',
    distance_km: 6,
    is_pair: false,
    bib_range_start: 3200,
    bib_range_end: 3390,
    bib_step: 10,
    color: '#BE123C',
    screen_group: 4,
    sort_order: 8,
  },
];

const NOMBRES_H = [
  'Martín',
  'Lucas',
  'Nicolás',
  'Santiago',
  'Matías',
  'Joaquín',
  'Facundo',
  'Tomás',
  'Agustín',
  'Federico',
  'Gonzalo',
  'Ramiro',
  'Ignacio',
  'Sebastián',
  'Franco',
];

const NOMBRES_M = [
  'Sofía',
  'Camila',
  'Valentina',
  'Lucía',
  'Julieta',
  'Micaela',
  'Florencia',
  'Catalina',
  'Paula',
  'Antonella',
  'Agustina',
  'Martina',
  'Victoria',
  'Carolina',
  'Milagros',
];

const APELLIDOS = [
  'González',
  'Rodríguez',
  'Gómez',
  'Fernández',
  'López',
  'Díaz',
  'Martínez',
  'Pérez',
  'Sánchez',
  'Romero',
  'Sosa',
  'Torres',
  'Álvarez',
  'Ruiz',
  'Castro',
];

export function generateDefaultEntries(): Entry[] {
  const entries: Entry[] = [];
  const now = new Date().toISOString();

  for (const cat of DEFAULT_CATEGORIES) {
    // 15 inscriptos por cada una de las 8 categorías = 120 atletas/duplas en total
    for (let i = 0; i < 15; i++) {
      const bib = cat.bib_range_start + i * cat.bib_step;
      const entryId = `e0000000-0000-4000-8000-${String(bib).padStart(12, '0')}`;

      if (cat.is_pair) {
        const isFemalePair = cat.slug.endsWith('-mm');
        const member1 = isFemalePair
          ? `${NOMBRES_M[i % 15]} ${APELLIDOS[i % 15]}`
          : `${NOMBRES_H[i % 15]} ${APELLIDOS[i % 15]}`;
        const member2 = isFemalePair
          ? `${NOMBRES_M[(i + 4) % 15]} ${APELLIDOS[(i + 6) % 15]}`
          : `${NOMBRES_H[(i + 4) % 15]} ${APELLIDOS[(i + 6) % 15]}`;
        const teamName = `Dupla ${cat.short_name} #${bib}`;
        entries.push({
          id: entryId,
          race_id: DEFAULT_RACE_ID,
          category_id: cat.id,
          bib,
          display_name: teamName,
          team_name: teamName,
          members: [member1, member2],
          active: true,
          created_at: now,
          updated_at: now,
        });
      } else {
        const isFemale = cat.slug.endsWith('-m') || cat.slug.includes('mujer');
        const fullName = isFemale
          ? `${NOMBRES_M[i % 15]} ${APELLIDOS[i % 15]}`
          : `${NOMBRES_H[i % 15]} ${APELLIDOS[(i + 2) % 15]}`;
        entries.push({
          id: entryId,
          race_id: DEFAULT_RACE_ID,
          category_id: cat.id,
          bib,
          display_name: fullName,
          team_name: null,
          members: [],
          active: true,
          created_at: now,
          updated_at: now,
        });
      }
    }
  }

  return entries;
}

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: 'b0000000-0000-4000-8000-000000000001',
    race_id: DEFAULT_RACE_ID,
    display_name: 'Admin',
    role: 'admin',
    pin_code: '999999',
    synthetic_email: 'admin@carrera.skol.local',
    assigned_screens: [1, 2, 3, 4],
    revoked: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'b0000000-0000-4000-8000-000000000011',
    race_id: DEFAULT_RACE_ID,
    display_name: 'Crono 01',
    role: 'timekeeper',
    pin_code: '1111',
    synthetic_email: 'crono_1111@carrera.skol.local',
    assigned_screens: [1, 2, 3, 4],
    revoked: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'b0000000-0000-4000-8000-000000000012',
    race_id: DEFAULT_RACE_ID,
    display_name: 'Crono 02',
    role: 'timekeeper',
    pin_code: '2222',
    synthetic_email: 'crono_2222@carrera.skol.local',
    assigned_screens: [2, 1, 3, 4],
    revoked: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'b0000000-0000-4000-8000-000000000013',
    race_id: DEFAULT_RACE_ID,
    display_name: 'Crono 03',
    role: 'timekeeper',
    pin_code: '3333',
    synthetic_email: 'crono_3333@carrera.skol.local',
    assigned_screens: [3, 4, 1, 2],
    revoked: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'b0000000-0000-4000-8000-000000000014',
    race_id: DEFAULT_RACE_ID,
    display_name: 'Crono 04',
    role: 'timekeeper',
    pin_code: '4444',
    synthetic_email: 'crono_4444@carrera.skol.local',
    assigned_screens: [4, 3, 1, 2],
    revoked: false,
    created_at: new Date().toISOString(),
  },
];
