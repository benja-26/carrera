import * as XLSX from 'xlsx';
import type { Category, Entry } from '../types/domain';

export interface ParsedCsvEntryRow {
  rowNumber: number;
  bib: number | null;
  categorySlugOrName: string;
  displayName: string;
  teamName: string | null;
  members: string[];
  error?: string;
}

/**
 * Calcula el próximo número de pechera libre dentro del rango de la categoría
 * respetando el salto configurado (ej. 100, 110, 120...).
 */
export function getNextAvailableBib(
  category: Category,
  existingBibs: Set<number>
): number {
  const step = Math.max(1, category.bib_step || 10);
  for (let b = category.bib_range_start; b <= category.bib_range_end; b += step) {
    if (!existingBibs.has(b)) {
      return b;
    }
  }
  // Si se llenó con el salto estándar, buscar cualquier número libre dentro o después del rango
  for (let b = category.bib_range_start; b <= category.bib_range_end + 500; b++) {
    if (!existingBibs.has(b)) {
      return b;
    }
  }
  return category.bib_range_start;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function normalizeHeaderCell(cell: string): string {
  return String(cell || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Convierte una matriz de filas (desde CSV o desde Excel .xlsx/.xls) en filas validadas,
 * detectando automáticamente las columnas tanto del formato corto (5 columnas) como del exportado completo.
 */
export function parseRawGridRows(rawRows: unknown[][]): ParsedCsvEntryRow[] {
  const cleanRows = rawRows
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []))
    .filter((r) => r.some((c) => c.length > 0));

  if (cleanRows.length === 0) return [];

  const firstRowNorm = cleanRows[0].map(normalizeHeaderCell);
  const hasHeader = firstRowNorm.some((c) =>
    [
      'dorsal',
      'numero',
      'pechera',
      'bib',
      'categoria',
      'nombre',
      'nombre_o_equipo',
      'equipo',
      'atleta',
    ].includes(c)
  );

  // Índices por defecto: dorsal(0), categoria(1), nombre_o_equipo(2), integrante_1(3), integrante_2(4)
  let colBib = 0;
  let colCategory = 1;
  let colName = 2;
  let colMember1 = 3;
  let colMember2 = 4;

  if (hasHeader) {
    const findIdx = (names: string[], fallback: number): number => {
      const idx = firstRowNorm.findIndex((h) => names.includes(h));
      return idx !== -1 ? idx : fallback;
    };

    colBib = findIdx(['dorsal', 'numero', 'pechera', 'bib', 'nro'], 0);
    colCategory = findIdx(['categoria', 'category', 'cat'], 1);
    colName = findIdx(
      ['nombre_o_equipo', 'equipo_o_atleta', 'nombre', 'equipo', 'atleta', 'dupla', 'display_name'],
      firstRowNorm.includes('distancia_km') || firstRowNorm.includes('modalidad') ? 4 : 2
    );
    colMember1 = findIdx(
      ['integrante_1', 'integrante1', 'atleta_1', 'atleta1', 'miembro_1'],
      colName + 1
    );
    colMember2 = findIdx(
      ['integrante_2', 'integrante2', 'atleta_2', 'atleta2', 'miembro_2'],
      colName + 2
    );
  }

  const startIndex = hasHeader ? 1 : 0;
  const rows: ParsedCsvEntryRow[] = [];

  for (let i = startIndex; i < cleanRows.length; i++) {
    const cells = cleanRows[i];
    if (cells.every((c) => !c)) continue;

    const rawBib = (cells[colBib] || '').replace(/^#/, '').trim();
    const parsedBib = rawBib !== '' ? Number.parseInt(rawBib, 10) : null;
    const categoryKey = (cells[colCategory] || '').trim();
    const displayName = (cells[colName] || '').trim();
    const member1 = (cells[colMember1] || '').trim();
    const member2 = (cells[colMember2] || '').trim();

    const members = [member1, member2].filter(Boolean);

    let error: string | undefined;
    if (rawBib !== '' && (Number.isNaN(parsedBib!) || parsedBib! <= 0)) {
      error = `Dorsal inválido "${rawBib}"`;
    } else if (!categoryKey) {
      error = 'Falta categoría';
    } else if (!displayName && members.length === 0) {
      error = 'Falta nombre de atleta o equipo';
    }

    rows.push({
      rowNumber: i + 1,
      bib: parsedBib,
      categorySlugOrName: categoryKey,
      displayName: displayName || members.join(' + '),
      teamName: members.length > 0 ? displayName || null : null,
      members,
      error,
    });
  }

  return rows;
}

/**
 * Parsea un archivo CSV de atletas/duplas (soporta separador ',' o ';' típico de Excel en Argentina).
 */
export function parseEntriesCsv(csvText: string): ParsedCsvEntryRow[] {
  const cleanText = csvText.replace(/^\uFEFF/, '');
  const lines = cleanText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const firstLine = lines[0];
  const delimiter = firstLine.includes(';') ? ';' : ',';
  const grid = lines.map((line) => splitCsvLine(line, delimiter));
  return parseRawGridRows(grid);
}

/**
 * Parsea un archivo Excel (.xlsx / .xls) desde un ArrayBuffer.
 */
export function parseEntriesExcelBuffer(buffer: ArrayBuffer): ParsedCsvEntryRow[] {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawGrid = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: '',
  });
  return parseRawGridRows(rawGrid);
}

export function matchCategoryByInput(
  input: string,
  categories: Category[]
): Category | undefined {
  const normalized = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bhombre\b/g, 'h')
    .replace(/\bmujer\b/g, 'm')
    .trim();

  return categories.find((c) => {
    const slug = c.slug.toLowerCase();
    const name = c.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const shortName = c.short_name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return slug === normalized || name === normalized || shortName === normalized;
  });
}

export function generateSampleEntriesCsv(): string {
  return [
    'dorsal;categoria;nombre_o_equipo;integrante_1;integrante_2',
    '100;Funcional H-H;Dupla Norte;Martín Gómez;Lucas Díaz',
    '300;Funcional M-M;Las Valkirias;Sofía Pérez;Camila López',
    '700;Scaled H-H;Los Cóndores;Nicolás Romero;Santiago Torres',
    '900;Scaled M-M;Las Espartanas;Valentina Sosa;Lucía Castro',
    '1300;Avanzado H;Matías Fernández;;',
    '1500;Avanzado M;Julieta Martínez;;',
    '1900;RX H;Facundo González;;',
    '2100;RX M;Micaela Rodríguez;;',
  ].join('\n');
}

export function exportEntriesToCsv(entries: Entry[], categories: Category[]): string {
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const header =
    'dorsal;categoria;nombre_o_equipo;integrante_1;integrante_2;distancia_km;modalidad;activo';
  const lines = entries
    .slice()
    .sort((a, b) => a.bib - b.bib)
    .map((e) => {
      const cat = catMap.get(e.category_id);
      const m1 = e.members[0] || '';
      const m2 = e.members[1] || '';
      return [
        e.bib,
        cat?.name || '',
        `"${(e.display_name || '').replace(/"/g, '""')}"`,
        `"${m1.replace(/"/g, '""')}"`,
        `"${m2.replace(/"/g, '""')}"`,
        cat?.distance_km || '',
        cat?.is_pair ? 'Dupla' : 'Individual',
        e.active ? 'SI' : 'NO',
      ].join(';');
    });

  return '\uFEFF' + [header, ...lines].join('\n');
}

export function downloadEntriesAsExcel(
  entries: Entry[],
  categories: Category[],
  filename: string = 'inscriptos-skol-2026.xlsx'
): void {
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const rows = entries
    .slice()
    .sort((a, b) => a.bib - b.bib)
    .map((e) => {
      const cat = catMap.get(e.category_id);
      return {
        dorsal: e.bib,
        categoria: cat?.name || '',
        nombre_o_equipo: e.display_name || '',
        integrante_1: e.members[0] || '',
        integrante_2: e.members[1] || '',
        distancia_km: cat?.distance_km || '',
        modalidad: cat?.is_pair ? 'Dupla' : 'Individual',
        activo: e.active ? 'SI' : 'NO',
      };
    });

  const worksheet = XLSX.utils.json_to_sheet(
    rows.length > 0
      ? rows
      : [
          {
            dorsal: 100,
            categoria: 'Funcional H-H',
            nombre_o_equipo: 'Dupla Ejemplo',
            integrante_1: 'Integrante 1',
            integrante_2: 'Integrante 2',
            distancia_km: 4,
            modalidad: 'Dupla',
            activo: 'SI',
          },
        ]
  );

  worksheet['!cols'] = [
    { wch: 10 },
    { wch: 18 },
    { wch: 28 },
    { wch: 24 },
    { wch: 24 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inscriptos SKOL');
  XLSX.writeFile(workbook, filename);
}
