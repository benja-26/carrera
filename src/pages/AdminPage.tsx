import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Database,
  Download,
  Edit3,
  FileSpreadsheet,
  GitCompare,
  History,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserCheck,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  downloadEntriesAsExcel,
  exportEntriesToCsv,
  generateSampleEntriesCsv,
  getNextAvailableBib,
  parseEntriesCsv,
  parseEntriesExcelBuffer,
  type ParsedCsvEntryRow,
} from '../lib/csvUtils';
import {
  bulkImportCsvEntries,
  clearRaceTimesOnly,
  deleteAllEntries,
  deleteCategory,
  deleteEntry,
  getLocalRaceBundleFast,
  getRaceBundle,
  reassignBibsWithStep,
  resetDemoRaceData,
  saveCategory,
  saveEntry,
  saveTimekeeperProfile,
  startRealtimeRaceSync,
  toggleRevokeProfile,
  updateRaceConfig,
  type RaceBundle,
} from '../lib/dataService';
import { subscribeToLocalRealtime } from '../lib/db';
import { exportFullDatabaseBackupJson } from '../lib/offlineSyncEngine';
import { runInBrowserRaceSimulation } from '../lib/browserSimulation';
import type { Category, Entry, RaceStatus } from '../types/domain';
import { RaceStartBanner } from '../components/RaceStartBanner';
import { SyncStatusBar } from '../components/SyncStatusBar';
import { DuplicatesResolutionPanel } from '../components/DuplicatesResolutionPanel';

type AdminTab = 'entries' | 'duplicates' | 'categories' | 'race' | 'staff' | 'audit';

export const AdminPage: React.FC = () => {
  const { profile } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>('entries');
  const [bundle, setBundle] = useState<RaceBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Filtros de Atletas/Duplas
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL');
  const [selectedScreenFilter, setSelectedScreenFilter] = useState<number | 'ALL'>('ALL');

  // Formulario de Atleta / Dupla
  const [editingEntryId, setEditingEntryId] = useState<string | undefined>(undefined);
  const [entryCategoryId, setEntryCategoryId] = useState<string>('');
  const [entryBib, setEntryBib] = useState<number>(100);
  const [entryDisplayName, setEntryDisplayName] = useState<string>('');
  const [entryMember1, setEntryMember1] = useState<string>('');
  const [entryMember2, setEntryMember2] = useState<string>('');
  const [entryActive, setEntryActive] = useState<boolean>(true);

  // Importador CSV / Excel y Borrado Masivo
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvRawText, setCsvRawText] = useState('');
  const [csvPreviewRows, setCsvPreviewRows] = useState<ParsedCsvEntryRow[]>([]);
  const [importedFileName, setImportedFileName] = useState<string>('');
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Formulario de Categoría
  const [editingCatId, setEditingCatId] = useState<string | undefined>(undefined);
  const [catName, setCatName] = useState('');
  const [catShortName, setCatShortName] = useState('');
  const [catSlug, setCatSlug] = useState('');
  const [catDistance, setCatDistance] = useState<4 | 6>(4);
  const [catIsPair, setCatIsPair] = useState<boolean>(true);
  const [catRangeStart, setCatRangeStart] = useState<number>(100);
  const [catRangeEnd, setCatRangeEnd] = useState<number>(290);
  const [catStep, setCatStep] = useState<number>(10);
  const [catColor, setCatColor] = useState<string>('#1D4ED8');
  const [catScreenGroup, setCatScreenGroup] = useState<number>(1);
  const [catSortOrder, setCatSortOrder] = useState<number>(1);

  // Formulario de Cronometrista
  const [editingStaffId, setEditingStaffId] = useState<string | undefined>(undefined);
  const [staffName, setStaffName] = useState('');
  const [staffPin, setStaffPin] = useState('');
  const [staffRole, setStaffRole] = useState<'timekeeper' | 'admin'>('timekeeper');
  const [staffScreens, setStaffScreens] = useState<number[]>([1, 2, 3, 4]);

  const loadLocalFast = async () => {
    const data = await getLocalRaceBundleFast();
    setBundle(data);
    setLoading(false);
  };

  const loadData = async () => {
    const data = await getRaceBundle();
    setBundle(data);
    if (!entryCategoryId && data.categories.length > 0) {
      const firstCat = data.categories[0];
      setEntryCategoryId(firstCat.id);
      const used = new Set(data.entries.map((e) => e.bib));
      setEntryBib(getNextAvailableBib(firstCat, used));
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadData();
    const unsubRemote = startRealtimeRaceSync();
    const unsub = subscribeToLocalRealtime(() => {
      void loadLocalFast();
    });
    return () => {
      unsubRemote();
      unsub();
    };
  }, []);

  const notify = (type: 'ok' | 'err', text: string) => {
    setFeedback({ type, text });
    window.setTimeout(() => {
      setFeedback((prev) => (prev?.text === text ? null : prev));
    }, 4500);
  };

  const selectedEntryCategory = useMemo(
    () => bundle?.categories.find((c) => c.id === entryCategoryId),
    [bundle?.categories, entryCategoryId]
  );

  const handleCategoryChangeForEntry = (newCatId: string) => {
    setEntryCategoryId(newCatId);
    if (!bundle || editingEntryId) return;
    const cat = bundle.categories.find((c) => c.id === newCatId);
    if (cat) {
      const used = new Set(bundle.entries.map((e) => e.bib));
      setEntryBib(getNextAvailableBib(cat, used));
    }
  };

  const resetEntryForm = (nextEntries?: Entry[]) => {
    setEditingEntryId(undefined);
    setEntryDisplayName('');
    setEntryMember1('');
    setEntryMember2('');
    setEntryActive(true);
    if (bundle) {
      const cat =
        bundle.categories.find((c) => c.id === entryCategoryId) || bundle.categories[0];
      if (cat) {
        const list = nextEntries || bundle.entries;
        const used = new Set(list.map((e) => e.bib));
        setEntryBib(getNextAvailableBib(cat, used));
      }
    }
  };

  const handleSaveEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bundle || !profile) return;
    const cat = bundle.categories.find((c) => c.id === entryCategoryId);
    if (!cat) {
      notify('err', 'Seleccioná una categoría válida.');
      return;
    }

    const members = cat.is_pair
      ? [entryMember1.trim(), entryMember2.trim()].filter(Boolean)
      : [];

    if (cat.is_pair && members.length < 2) {
      notify('err', 'Las categorías de Duplas requieren los nombres de los 2 integrantes.');
      return;
    }

    const finalDisplayName =
      entryDisplayName.trim() ||
      (cat.is_pair ? `Dupla #${entryBib}` : members[0] || `Atleta #${entryBib}`);

    try {
      await saveEntry(
        {
          id: editingEntryId,
          race_id: bundle.race.id,
          category_id: cat.id,
          bib: Number(entryBib),
          display_name: finalDisplayName,
          team_name: cat.is_pair ? finalDisplayName : null,
          members,
          active: entryActive,
        },
        profile.id
      );
      const refreshed = await getRaceBundle(bundle.race.id);
      setBundle(refreshed);
      resetEntryForm(refreshed.entries);
      notify(
        'ok',
        editingEntryId
          ? `Dorsal #${entryBib} actualizado correctamente.`
          : `Dorsal #${entryBib} registrado correctamente.`
      );
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Error al guardar inscripto');
    }
  };

  const handleEditEntry = (entry: Entry) => {
    setEditingEntryId(entry.id);
    setEntryCategoryId(entry.category_id);
    setEntryBib(entry.bib);
    setEntryDisplayName(entry.display_name);
    setEntryMember1(entry.members[0] || '');
    setEntryMember2(entry.members[1] || '');
    setEntryActive(entry.active);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteEntry = async (entry: Entry) => {
    if (!bundle || !profile) return;
    if (!window.confirm(`¿Eliminar el dorsal #${entry.bib} (${entry.display_name})?`)) {
      return;
    }
    try {
      await deleteEntry(entry.id, bundle.race.id, profile.id);
      await loadData();
      notify('ok', `Dorsal #${entry.bib} eliminado.`);
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'No se pudo eliminar');
    }
  };

  const handleCsvTextChange = (text: string) => {
    setImportedFileName('');
    setCsvRawText(text);
    setCsvPreviewRows(parseEntriesCsv(text));
  };

  const handleCsvFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    setImportedFileName(file.name);

    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseEntriesExcelBuffer(buffer);
        setCsvRawText(
          `[Archivo Excel cargado: ${file.name} — ${parsed.length} filas detectadas]`
        );
        setCsvPreviewRows(parsed);
      } catch (err) {
        notify(
          'err',
          err instanceof Error ? err.message : 'No se pudo leer el archivo Excel.'
        );
      }
    } else {
      const text = await file.text();
      setCsvRawText(text);
      setCsvPreviewRows(parseEntriesCsv(text));
    }
    e.target.value = '';
  };

  const handleConfirmCsvImport = async () => {
    if (!bundle || !profile) return;
    try {
      const res = await bulkImportCsvEntries(bundle.race.id, csvPreviewRows, profile.id);
      await loadLocalFast();
      setShowCsvModal(false);
      setCsvRawText('');
      setCsvPreviewRows([]);
      setImportedFileName('');
      notify(
        'ok',
        `Importación finalizada: ${res.imported} atletas/duplas guardados, ${res.skipped} omitidos.`
      );
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Error en importación CSV/Excel');
    }
  };

  const handleDownloadEntriesCsv = () => {
    if (!bundle) return;
    const csv = exportEntriesToCsv(bundle.entries, bundle.categories);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inscriptos-skol-${bundle.race.race_date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadEntriesExcel = () => {
    if (!bundle) return;
    downloadEntriesAsExcel(
      bundle.entries,
      bundle.categories,
      `inscriptos-skol-${bundle.race.race_date}.xlsx`
    );
  };

  const handleConfirmDeleteAllEntries = async () => {
    if (!bundle || !profile) return;
    setDeletingAll(true);
    try {
      const removed = await deleteAllEntries(bundle.race.id, profile.id);
      await loadLocalFast();
      resetEntryForm([]);
      setShowDeleteAllModal(false);
      notify(
        'ok',
        `Se eliminaron de forma masiva los ${removed} atletas/duplas. El padrón está vacío y listo para importar.`
      );
    } catch (err) {
      notify(
        'err',
        err instanceof Error ? err.message : 'Error al vaciar el padrón de atletas'
      );
    } finally {
      setDeletingAll(false);
    }
  };

  const handleReassignBibs = async (catId: string | 'ALL') => {
    if (!bundle || !profile) return;
    const count = await reassignBibsWithStep(bundle.race.id, catId, profile.id);
    await loadData();
    notify('ok', `Se reenumeraron ${count} dorsales respetando los rangos y saltos.`);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bundle || !profile) return;
    try {
      const slug =
        catSlug.trim() ||
        catName
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-');

      await saveCategory(
        {
          id: editingCatId,
          race_id: bundle.race.id,
          slug,
          name: catName.trim(),
          short_name: catShortName.trim() || catName.trim().slice(0, 10).toUpperCase(),
          distance_km: catDistance,
          is_pair: catIsPair,
          bib_range_start: Number(catRangeStart),
          bib_range_end: Number(catRangeEnd),
          bib_step: Number(catStep),
          color: catColor,
          screen_group: Number(catScreenGroup),
          sort_order: Number(catSortOrder),
        },
        profile.id
      );
      setEditingCatId(undefined);
      setCatName('');
      setCatShortName('');
      setCatSlug('');
      await loadData();
      notify('ok', 'Categoría guardada correctamente.');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Error al guardar categoría');
    }
  };

  const handleEditCategory = (c: Category) => {
    setEditingCatId(c.id);
    setCatName(c.name);
    setCatShortName(c.short_name);
    setCatSlug(c.slug);
    setCatDistance(c.distance_km);
    setCatIsPair(c.is_pair);
    setCatRangeStart(c.bib_range_start);
    setCatRangeEnd(c.bib_range_end);
    setCatStep(c.bib_step);
    setCatColor(c.color);
    setCatScreenGroup(c.screen_group);
    setCatSortOrder(c.sort_order);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSaveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bundle || !profile) return;
    try {
      await saveTimekeeperProfile(
        {
          id: editingStaffId,
          race_id: bundle.race.id,
          display_name: staffName,
          role: staffRole,
          pin_code: staffPin,
          assigned_screens: staffScreens,
        },
        profile.id
      );
      setEditingStaffId(undefined);
      setStaffName('');
      setStaffPin('');
      setStaffRole('timekeeper');
      setStaffScreens([1, 2, 3, 4]);
      await loadData();
      notify('ok', 'Perfil de staff y PIN guardados.');
    } catch (err) {
      notify('err', err instanceof Error ? err.message : 'Error al guardar PIN');
    }
  };

  const filteredEntries = useMemo(() => {
    if (!bundle) return [];
    const catMap = new Map(bundle.categories.map((c) => [c.id, c]));
    const q = searchQuery.trim().toLowerCase();

    return bundle.entries.filter((e) => {
      const cat = catMap.get(e.category_id);
      if (selectedCategoryFilter !== 'ALL' && e.category_id !== selectedCategoryFilter) {
        return false;
      }
      if (selectedScreenFilter !== 'ALL' && cat?.screen_group !== selectedScreenFilter) {
        return false;
      }
      if (!q) return true;
      const matchBib = String(e.bib).includes(q);
      const matchName = e.display_name.toLowerCase().includes(q);
      const matchMembers = e.members.some((m) => m.toLowerCase().includes(q));
      return matchBib || matchName || matchMembers;
    });
  }, [bundle, searchQuery, selectedCategoryFilter, selectedScreenFilter]);

  if (loading || !bundle) {
    return (
      <div className="p-8 text-center text-slate-400 font-semibold">
        Cargando panel de administración...
      </div>
    );
  }

  const catMap = new Map(bundle.categories.map((c) => [c.id, c]));

  return (
    <div className="max-w-7xl mx-auto p-3 sm:p-6 space-y-5">
      {/* Cabecera de Carrera */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-black uppercase tracking-wider ${
                bundle.race.status === 'running'
                  ? 'bg-emerald-500 text-slate-950'
                  : bundle.race.status === 'finished'
                  ? 'bg-sky-500 text-slate-950'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}
            >
              {bundle.race.status === 'pending'
                ? 'Pendiente de Largada'
                : bundle.race.status === 'running'
                ? 'En Curso'
                : 'Finalizada'}
            </span>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">
              {bundle.race.name}
            </h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {bundle.categories.length} categorías · {bundle.entries.length} inscriptos (
            {bundle.entries.filter((e) => catMap.get(e.category_id)?.is_pair).length} duplas
            4K /{' '}
            {bundle.entries.filter((e) => !catMap.get(e.category_id)?.is_pair).length}{' '}
            individuales 6K) · {bundle.profiles.filter((p) => !p.revoked).length} PINs
            activos
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadEntriesCsv}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold flex items-center gap-1.5 border border-slate-700"
          >
            <Download className="w-4 h-4 text-emerald-400" />
            <span>Exportar CSV (.csv)</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadEntriesExcel}
            className="px-3 py-2 rounded-xl bg-emerald-950/60 hover:bg-emerald-900/70 text-emerald-200 text-xs font-bold flex items-center gap-1.5 border border-emerald-700/60"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            <span>Exportar Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              const json = await exportFullDatabaseBackupJson();
              const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `backup-skol-${bundle.race.race_date}-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold flex items-center gap-1.5 border border-slate-700"
          >
            <Database className="w-4 h-4 text-sky-400" />
            <span>Backup Completo JSON</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!profile) return;
              const res = await runInBrowserRaceSimulation(profile.id);
              await loadData();
              notify(
                'ok',
                `Simulación completada: ${res.totalClassified} clasificados con 10 dispositivos, ${res.duplicatesCreated} duplicados y ${res.modeBAssigned} por Modo B.`
              );
            }}
            className="px-3 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-xs font-bold text-amber-300 flex items-center gap-1.5 border border-amber-500/40"
          >
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Simular Carrera (120 · 10 Disp.)</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!profile || !bundle) return;
              if (
                window.confirm(
                  '¿Reiniciar únicamente la largada y los tiempos de prueba (conservando todos tus atletas, categorías y PINs actuales)?'
                )
              ) {
                await clearRaceTimesOnly(bundle.race.id, profile.id);
                await loadLocalFast();
                notify(
                  'ok',
                  'Largada y tiempos de prueba reiniciados. Tus atletas y categorías siguen intactos.'
                );
              }
            }}
            className="px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-xs font-bold text-rose-300 flex items-center gap-1.5 border border-rose-500/40"
          >
            <RotateCcw className="w-4 h-4 text-rose-400" />
            <span>Limpiar Tiempos (Mantener Atletas)</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (!profile) return;
              if (
                window.confirm(
                  '¿Restaurar los datos de demostración originales (8 categorías oficiales, 120 atletas, sin tiempos)?'
                )
              ) {
                await resetDemoRaceData(profile.id);
                await loadLocalFast();
                notify('ok', 'Datos iniciales restaurados (8 categorías oficiales, 120 atletas).');
              }
            }}
            className="px-3 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-xs font-bold text-slate-300 flex items-center gap-1.5 border border-slate-800"
          >
            <RotateCcw className="w-4 h-4 text-amber-400" />
            <span>Restaurar Seed (8 Cat · 120)</span>
          </button>
        </div>
      </div>

      {/* Control de Largada Única (Confirmación en 2 pasos y Corrección Auditada) */}
      <RaceStartBanner
        race={bundle.race}
        raceStart={bundle.raceStart}
        profiles={bundle.profiles}
        currentUser={profile}
        onUpdated={loadLocalFast}
      />

      {/* Estado de Cola Offline y Reintentos Exponenciales */}
      <SyncStatusBar />

      {feedback && (
        <div
          className={`p-3.5 rounded-xl border text-xs sm:text-sm font-bold flex items-center justify-between ${
            feedback.type === 'ok'
              ? 'bg-emerald-950/90 border-emerald-700 text-emerald-200'
              : 'bg-rose-950/90 border-rose-700 text-rose-200'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs underline ml-4"
          >
            Cerrar
          </button>
        </div>
      )}

      {/* Pestañas del Panel Admin */}
      <div className="flex overflow-x-auto gap-1.5 pb-1">
        {[
          {
            id: 'entries' as const,
            label: `Atletas y Duplas (${bundle.entries.length})`,
            icon: Users,
          },
          {
            id: 'duplicates' as const,
            label: `Duplicados y Cola (${
              bundle.finishEvents.filter(
                (e) => e.status === 'duplicate' || e.status === 'unassigned'
              ).length
            })`,
            icon: GitCompare,
          },
          {
            id: 'categories' as const,
            label: `Categorías y Rangos (${bundle.categories.length})`,
            icon: Layers,
          },
          {
            id: 'race' as const,
            label: 'Carrera y 4 Pantallas',
            icon: Sparkles,
          },
          {
            id: 'staff' as const,
            label: `Cronometristas y PINs (${bundle.profiles.length})`,
            icon: UserCheck,
          },
          {
            id: 'audit' as const,
            label: `Auditoría (${bundle.auditLogs.length})`,
            icon: History,
          },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2.5 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-2 shrink-0 transition ${
                active
                  ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/10'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* =====================================================================
          PESTAÑA ESPECIAL: RESOLUCIÓN DE DUPLICADOS Y TIEMPOS SIN ASIGNAR
      ===================================================================== */}
      {activeTab === 'duplicates' && profile && (
        <DuplicatesResolutionPanel
          race={bundle.race}
          raceStart={bundle.raceStart}
          categories={bundle.categories}
          entries={bundle.entries}
          profiles={bundle.profiles}
          finishEvents={bundle.finishEvents}
          currentAdmin={profile}
          onUpdated={loadData}
          onNotify={notify}
        />
      )}

      {/* =====================================================================
          PESTAÑA 1: ATLETAS Y DUPLAS + CSV + AUTO-NUMERACIÓN CON SALTO
      ===================================================================== */}
      {activeTab === 'entries' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Columna izquierda: Alta / Edición manual */}
          <div className="lg:col-span-4 space-y-4">
            <form
              onSubmit={handleSaveEntry}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3.5"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-black text-base flex items-center gap-2">
                  <Plus className="w-4 h-4 text-amber-400" />
                  <span>
                    {editingEntryId ? `Editar Dorsal #${entryBib}` : 'Cargar Atleta / Dupla'}
                  </span>
                </h2>
                {editingEntryId && (
                  <button
                    type="button"
                    onClick={() => resetEntryForm()}
                    className="text-xs text-slate-400 hover:text-white underline"
                  >
                    Cancelar edición
                  </button>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Categoría
                </label>
                <select
                  value={entryCategoryId}
                  onChange={(e) => handleCategoryChangeForEntry(e.target.value)}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-sm font-semibold"
                >
                  {bundle.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      [P{c.screen_group}] {c.name} ({c.distance_km}K · Rango{' '}
                      {c.bib_range_start}-{c.bib_range_end})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    N° de Pechera (Dorsal)
                  </label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={entryBib}
                    onChange={(e) => setEntryBib(Number(e.target.value))}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-lg font-black text-amber-400"
                  />
                </div>
                <div className="flex flex-col justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedEntryCategory) return;
                      const used = new Set(bundle.entries.map((e) => e.bib));
                      setEntryBib(getNextAvailableBib(selectedEntryCategory, used));
                    }}
                    className="h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700 px-2"
                  >
                    Sugerir libre (+{selectedEntryCategory?.bib_step || 10})
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {selectedEntryCategory?.is_pair
                    ? 'Nombre del Equipo / Dupla'
                    : 'Nombre y Apellido del Atleta'}
                </label>
                <input
                  type="text"
                  required
                  value={entryDisplayName}
                  onChange={(e) => setEntryDisplayName(e.target.value)}
                  placeholder={
                    selectedEntryCategory?.is_pair
                      ? 'Ej: Equipo Los Cóndores'
                      : 'Ej: Martín González'
                  }
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              </div>

              {selectedEntryCategory?.is_pair && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 rounded-xl bg-slate-950/70 border border-slate-800">
                  <div className="sm:col-span-2 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                    Integrantes de la Dupla (4 km · 1 solo dorsal)
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Integrante 1
                    </label>
                    <input
                      type="text"
                      required
                      value={entryMember1}
                      onChange={(e) => setEntryMember1(e.target.value)}
                      placeholder="Nombre Integrante 1"
                      className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                      Integrante 2
                    </label>
                    <input
                      type="text"
                      required
                      value={entryMember2}
                      onChange={(e) => setEntryMember2(e.target.value)}
                      placeholder="Nombre Integrante 2"
                      className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={entryActive}
                  onChange={(e) => setEntryActive(e.target.checked)}
                  className="rounded border-slate-700"
                />
                <span>Habilitado para largar (desmarcar si es DNS / Baja)</span>
              </label>

              <button
                type="submit"
                className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" />
                <span>{editingEntryId ? 'Guardar Cambios' : 'Agregar al Padrón'}</span>
              </button>
            </form>

            {/* Herramientas masivas: CSV, Excel, Reasignación de saltos y Borrado Masivo */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
                <span>Planillas (CSV / Excel) y Acciones Masivas</span>
              </h3>
              <p className="text-xs text-slate-400">
                1° Descargá una copia en <strong>CSV</strong> o <strong>Excel (.xlsx)</strong>{' '}
                · 2° Editá con tus atletas reales · 3° Borrá de forma masiva el ejemplo · 4°
                Importá tu archivo.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleDownloadEntriesCsv}
                  className="py-2 px-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-xs flex items-center justify-center gap-1.5 border border-slate-700"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Descargar CSV</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadEntriesExcel}
                  className="py-2 px-2.5 rounded-xl bg-emerald-950/70 hover:bg-emerald-900/80 text-emerald-200 font-bold text-xs flex items-center justify-center gap-1.5 border border-emerald-700/60"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Descargar Excel</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const sample = generateSampleEntriesCsv();
                  handleCsvTextChange(sample);
                  setShowCsvModal(true);
                }}
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm"
              >
                <Upload className="w-4 h-4" />
                <span>Importar Atletas desde CSV o Excel (.xlsx)</span>
              </button>

              <button
                type="button"
                onClick={() => handleReassignBibs(selectedCategoryFilter)}
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center gap-2 border border-slate-700"
              >
                <RefreshCw className="w-4 h-4 text-amber-400" />
                <span>
                  Reenumerar con Salto (
                  {selectedCategoryFilter === 'ALL'
                    ? 'Todas las categorías'
                    : 'Categoría filtrada'}
                  )
                </span>
              </button>

              <div className="pt-2 border-t border-slate-800">
                <button
                  type="button"
                  disabled={bundle.entries.length === 0}
                  onClick={() => setShowDeleteAllModal(true)}
                  className="w-full py-2.5 rounded-xl bg-rose-950/80 hover:bg-rose-900 disabled:opacity-40 disabled:pointer-events-none text-rose-200 font-black text-xs flex items-center justify-center gap-2 border border-rose-700/70 transition"
                >
                  <Trash2 className="w-4 h-4 text-rose-400" />
                  <span>
                    Borrar Todos los Atletas de Forma Masiva ({bundle.entries.length})
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* Columna derecha: Listado y Filtros */}
          <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar dorsal, equipo o atleta..."
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 pl-9 pr-3 py-2 text-xs font-semibold"
                />
              </div>

              <select
                value={selectedScreenFilter}
                onChange={(e) =>
                  setSelectedScreenFilter(
                    e.target.value === 'ALL' ? 'ALL' : Number(e.target.value)
                  )
                }
                className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-semibold"
              >
                <option value="ALL">Todas las Pantallas (1 a 4)</option>
                {bundle.race.screen_groups.map((sg) => (
                  <option key={sg.id} value={sg.id}>
                    Pantalla {sg.id}: {sg.title}
                  </option>
                ))}
              </select>

              <select
                value={selectedCategoryFilter}
                onChange={(e) => setSelectedCategoryFilter(e.target.value)}
                className="rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-semibold"
              >
                <option value="ALL">
                  Todas las Categorías ({bundle.categories.length})
                </option>
                {bundle.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.distance_km}K)
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-400 flex flex-wrap items-center justify-between gap-2">
              <span>
                Mostrando <strong>{filteredEntries.length}</strong> de{' '}
                <strong>{bundle.entries.length}</strong> inscriptos · Ordenados por N° de
                Pechera
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleDownloadEntriesCsv}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-[11px] flex items-center gap-1 border border-slate-700"
                >
                  <Download className="w-3 h-3 text-emerald-400" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadEntriesExcel}
                  className="px-2.5 py-1 rounded-lg bg-emerald-950/70 hover:bg-emerald-900 text-emerald-200 font-bold text-[11px] flex items-center gap-1 border border-emerald-700/60"
                >
                  <FileSpreadsheet className="w-3 h-3 text-emerald-400" />
                  <span>Excel (.xlsx)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const sample = generateSampleEntriesCsv();
                    handleCsvTextChange(sample);
                    setShowCsvModal(true);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] flex items-center gap-1"
                >
                  <Upload className="w-3 h-3" />
                  <span>Importar</span>
                </button>
                {bundle.entries.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteAllModal(true)}
                    className="px-2.5 py-1 rounded-lg bg-rose-950 hover:bg-rose-900 text-rose-200 font-bold text-[11px] flex items-center gap-1 border border-rose-700/70"
                  >
                    <Trash2 className="w-3 h-3 text-rose-400" />
                    <span>Vaciar Todos ({bundle.entries.length})</span>
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto max-h-[580px] overflow-y-auto rounded-xl border border-slate-800">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-950 text-slate-400 sticky top-0 z-10">
                  <tr>
                    <th className="py-2.5 px-3">Dorsal</th>
                    <th className="py-2.5 px-3">Categoría / Pantalla</th>
                    <th className="py-2.5 px-3">Equipo / Atleta</th>
                    <th className="py-2.5 px-3">Integrantes (Dupla)</th>
                    <th className="py-2.5 px-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {filteredEntries.map((entry) => {
                    const cat = catMap.get(entry.category_id);
                    return (
                      <tr
                        key={entry.id}
                        className={`hover:bg-slate-800/50 ${
                          !entry.active ? 'opacity-50' : ''
                        }`}
                      >
                        <td className="py-2 px-3">
                          <span
                            className="inline-flex items-center justify-center px-2.5 py-1 rounded-lg font-black text-sm text-white"
                            style={{ backgroundColor: cat?.color || '#334155' }}
                          >
                            #{entry.bib}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <div className="font-bold text-slate-200">{cat?.name}</div>
                          <div className="text-[11px] text-slate-400">
                            Pantalla {cat?.screen_group} · {cat?.distance_km} km ·{' '}
                            {cat?.is_pair ? 'Dupla' : 'Individual'}
                          </div>
                        </td>
                        <td className="py-2 px-3 font-bold text-slate-100">
                          {entry.display_name}
                          {!entry.active && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 text-[10px]">
                              DNS
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-slate-300">
                          {entry.members.length > 0 ? entry.members.join(' + ') : '—'}
                        </td>
                        <td className="py-2 px-3 text-right space-x-1">
                          <button
                            type="button"
                            onClick={() => handleEditEntry(entry)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300"
                            title="Editar"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteEntry(entry)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900 text-rose-300"
                            title="Eliminar"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          PESTAÑA 2: CATEGORÍAS (DISTANCIA, COLOR, RANGO DE NÚMEROS, PANTALLA)
      ===================================================================== */}
      {activeTab === 'categories' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form
            onSubmit={handleSaveCategory}
            className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 h-fit"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-black text-base">
                {editingCatId ? 'Editar Categoría' : 'Nueva Categoría'}
              </h2>
              {editingCatId && (
                <button
                  type="button"
                  onClick={() => setEditingCatId(undefined)}
                  className="text-xs text-slate-400 underline"
                >
                  Cancelar
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="col-span-2">
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Nombre de Categoría
                </label>
                <input
                  type="text"
                  required
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  placeholder="Ej: Funcional Dupla"
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Etiqueta Corta
                </label>
                <input
                  type="text"
                  required
                  value={catShortName}
                  onChange={(e) => setCatShortName(e.target.value)}
                  placeholder="Ej: FUNC DUPLA"
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold uppercase"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Color (Alto Contraste)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={catColor}
                    onChange={(e) => setCatColor(e.target.value)}
                    className="h-9 w-12 rounded bg-slate-950 border border-slate-700 cursor-pointer"
                  />
                  <input
                    type="text"
                    value={catColor}
                    onChange={(e) => setCatColor(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-2 py-2 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Distancia
                </label>
                <select
                  value={catDistance}
                  onChange={(e) => {
                    const d = Number(e.target.value) as 4 | 6;
                    setCatDistance(d);
                    setCatIsPair(d === 4);
                  }}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
                >
                  <option value={4}>4 km (2 ida + 2 vuelta)</option>
                  <option value={6}>6 km (3 ida + 3 vuelta)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Modalidad
                </label>
                <select
                  value={catIsPair ? 'pair' : 'ind'}
                  onChange={(e) => setCatIsPair(e.target.value === 'pair')}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
                >
                  <option value="pair">Dupla (2 integrantes)</option>
                  <option value="ind">Individual</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-bold text-slate-300 mb-1">
                  Dorsal Inicial
                </label>
                <input
                  type="number"
                  required
                  value={catRangeStart}
                  onChange={(e) => setCatRangeStart(Number(e.target.value))}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-2.5 py-2 text-xs font-bold"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-300 mb-1">
                  Dorsal Final
                </label>
                <input
                  type="number"
                  required
                  value={catRangeEnd}
                  onChange={(e) => setCatRangeEnd(Number(e.target.value))}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-2.5 py-2 text-xs font-bold"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-300 mb-1">
                  Salto (Step)
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={catStep}
                  onChange={(e) => setCatStep(Number(e.target.value))}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-2.5 py-2 text-xs font-bold text-amber-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">
                Pantalla del Cronometrista (Swipe 1 a 4)
              </label>
              <select
                value={catScreenGroup}
                onChange={(e) => setCatScreenGroup(Number(e.target.value))}
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
              >
                {bundle.race.screen_groups.map((sg) => (
                  <option key={sg.id} value={sg.id}>
                    Pantalla {sg.id}: {sg.title}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm"
            >
              {editingCatId ? 'Actualizar Categoría' : 'Crear Categoría'}
            </button>
          </form>

          <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {bundle.categories.map((cat) => {
              const count = bundle.entries.filter((e) => e.category_id === cat.id).length;
              return (
                <div
                  key={cat.id}
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-5 h-10 rounded-lg shrink-0 border border-white/20"
                        style={{ backgroundColor: cat.color }}
                      />
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-slate-800 text-amber-300">
                          Pantalla {cat.screen_group} · {cat.distance_km} KM ·{' '}
                          {cat.is_pair ? 'DUPLA' : 'INDIVIDUAL'}
                        </span>
                        <h3 className="font-black text-base text-white mt-0.5">
                          {cat.name}
                        </h3>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleEditCategory(cat)}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300"
                        title="Editar categoría"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!profile) return;
                          try {
                            await deleteCategory(cat.id, bundle.race.id, profile.id);
                            await loadData();
                            notify('ok', 'Categoría eliminada.');
                          } catch (err) {
                            notify(
                              'err',
                              err instanceof Error ? err.message : 'No se pudo eliminar'
                            );
                          }
                        }}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900 text-rose-300"
                        title="Eliminar categoría"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center bg-slate-950/80 rounded-xl p-2 border border-slate-800/80 text-xs">
                    <div>
                      <div className="text-[10px] text-slate-400">Rango Dorsales</div>
                      <div className="font-black text-slate-200">
                        {cat.bib_range_start} – {cat.bib_range_end}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">Salto</div>
                      <div className="font-black text-amber-400">de {cat.bib_step} en {cat.bib_step}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">Inscriptos</div>
                      <div className="font-black text-emerald-400">{count}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* =====================================================================
          PESTAÑA 3: CONFIGURACIÓN DE CARRERA Y 4 PANTALLAS DESLIZABLES
      ===================================================================== */}
      {activeTab === 'race' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
            <h2 className="font-black text-base">Parámetros Generales de la Carrera</h2>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Nombre del Evento
                </label>
                <input
                  type="text"
                  value={bundle.race.name}
                  onChange={(e) =>
                    setBundle({
                      ...bundle,
                      race: { ...bundle.race, name: e.target.value },
                    })
                  }
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm font-bold"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Estado de la Carrera
                  </label>
                  <select
                    value={bundle.race.status}
                    onChange={(e) =>
                      setBundle({
                        ...bundle,
                        race: { ...bundle.race, status: e.target.value as RaceStatus },
                      })
                    }
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
                  >
                    <option value="pending">Pendiente</option>
                    <option value="running">En Curso</option>
                    <option value="finished">Finalizada</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-300 mb-1">
                    Umbral Alerta Duplicado (ms)
                  </label>
                  <input
                    type="number"
                    min={500}
                    step={500}
                    value={bundle.race.duplicate_threshold_ms}
                    onChange={(e) =>
                      setBundle({
                        ...bundle,
                        race: {
                          ...bundle.race,
                          duplicate_threshold_ms: Number(e.target.value),
                        },
                      })
                    }
                    className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-xs font-bold"
                  />
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <div className="text-xs font-bold text-slate-200">
                      Habilitar pantalla opcional de "Tiempo Neto" (Paso por Largada)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      El tiempo oficial sigue siendo el Tiempo Bruto (Gun Time = llegada −
                      largada única). Al activarlo se habilita el modo de captura de cruce de
                      salida.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={bundle.race.net_time_enabled}
                    onChange={(e) =>
                      setBundle({
                        ...bundle,
                        race: { ...bundle.race, net_time_enabled: e.target.checked },
                      })
                    }
                    className="w-5 h-5 accent-amber-500"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={async () => {
                  if (!profile) return;
                  await updateRaceConfig(
                    bundle.race.id,
                    {
                      name: bundle.race.name,
                      status: bundle.race.status,
                      net_time_enabled: bundle.race.net_time_enabled,
                      duplicate_threshold_ms: bundle.race.duplicate_threshold_ms,
                      screen_groups: bundle.race.screen_groups,
                    },
                    profile.id
                  );
                  notify('ok', 'Configuración de carrera actualizada.');
                }}
                className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm flex items-center justify-center gap-2"
              >
                <Save className="w-4 h-4" />
                <span>Guardar Configuración General</span>
              </button>
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
            <h2 className="font-black text-base">
              Agrupación en 4 Pantallas Deslizables (Swipe)
            </h2>
            <p className="text-xs text-slate-400">
              Personalizá el título de cada una de las 4 páginas por las que deslizan los
              cronometristas:
            </p>
            <div className="space-y-2.5">
              {bundle.race.screen_groups.map((sg, idx) => {
                const catsInScreen = bundle.categories.filter(
                  (c) => c.screen_group === sg.id
                );
                return (
                  <div
                    key={sg.id}
                    className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-amber-400 uppercase">
                        Pantalla {sg.id}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {catsInScreen.map((c) => c.short_name).join(' · ')}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={sg.title}
                        onChange={(e) => {
                          const next = [...bundle.race.screen_groups];
                          next[idx] = { ...sg, title: e.target.value };
                          setBundle({
                            ...bundle,
                            race: { ...bundle.race, screen_groups: next },
                          });
                        }}
                        className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs font-bold"
                        placeholder="Título de pestaña"
                      />
                      <input
                        type="text"
                        value={sg.subtitle}
                        onChange={(e) => {
                          const next = [...bundle.race.screen_groups];
                          next[idx] = { ...sg, subtitle: e.target.value };
                          setBundle({
                            ...bundle,
                            race: { ...bundle.race, screen_groups: next },
                          });
                        }}
                        className="rounded-lg bg-slate-900 border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300"
                        placeholder="Subtítulo"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          PESTAÑA 4: CRONOMETRISTAS, PIN PERSONAL Y ASIGNACIÓN DE PANTALLAS
      ===================================================================== */}
      {activeTab === 'staff' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form
            onSubmit={handleSaveStaff}
            className="lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3.5 h-fit"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-black text-base">
                {editingStaffId ? 'Editar Cronometrista' : 'Nuevo Cronometrista / PIN'}
              </h2>
              {editingStaffId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingStaffId(undefined);
                    setStaffName('');
                    setStaffPin('');
                  }}
                  className="text-xs text-slate-400 underline"
                >
                  Cancelar
                </button>
              )}
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">
                Nombre / Puesto del Cronometrista
              </label>
              <input
                type="text"
                required
                value={staffName}
                onChange={(e) => setStaffName(e.target.value)}
                placeholder="Ej: Crono 05 -Llegada Duplas"
                className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  Código PIN (4-8 dígitos)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={staffPin}
                  onChange={(e) =>
                    setStaffPin(e.target.value.replace(/\D/g, '').slice(0, 8))
                  }
                  placeholder="Ej: 5555"
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2 text-base font-black tracking-widest text-amber-400"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">Rol</label>
                <select
                  value={staffRole}
                  onChange={(e) =>
                    setStaffRole(e.target.value as 'timekeeper' | 'admin')
                  }
                  className="w-full rounded-xl bg-slate-950 border border-slate-700 px-3 py-2.5 text-xs font-bold"
                >
                  <option value="timekeeper">Cronometrista</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                Pantallas Asignadas (la primera será su pantalla inicial)
              </label>
              <div className="grid grid-cols-2 gap-2">
                {bundle.race.screen_groups.map((sg) => {
                  const checked = staffScreens.includes(sg.id);
                  return (
                    <button
                      key={sg.id}
                      type="button"
                      onClick={() => {
                        setStaffScreens((prev) =>
                          prev.includes(sg.id)
                            ? prev.filter((id) => id !== sg.id)
                            : [...prev, sg.id]
                        );
                      }}
                      className={`p-2 rounded-xl border text-left text-xs font-bold flex items-center justify-between ${
                        checked
                          ? 'bg-amber-500/20 border-amber-500 text-amber-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400'
                      }`}
                    >
                      <span className="truncate">
                        P{sg.id}: {sg.title}
                      </span>
                      {checked && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-sm"
            >
              {editingStaffId ? 'Guardar Cambios' : 'Crear PIN de Acceso'}
            </button>
          </form>

          <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {bundle.profiles.map((p) => (
              <div
                key={p.id}
                className={`bg-slate-900 border rounded-2xl p-4 flex flex-col justify-between gap-3 ${
                  p.revoked ? 'border-rose-800/70 opacity-60' : 'border-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                          p.role === 'admin'
                            ? 'bg-amber-500 text-slate-950'
                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        }`}
                      >
                        {p.role === 'admin' ? 'ADMIN' : 'CRONOMETRISTA'}
                      </span>
                      {p.revoked && (
                        <span className="px-2 py-0.5 rounded bg-rose-950 text-rose-300 text-[10px] font-black uppercase">
                          REVOCADO
                        </span>
                      )}
                    </div>
                    <h3 className="font-black text-base text-white mt-1">
                      {p.display_name}
                    </h3>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Pantallas habilitadas:{' '}
                      <span className="font-bold text-slate-200">
                        {p.assigned_screens.map((s) => `P${s}`).join(', ')}
                      </span>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-[10px] uppercase text-slate-400">PIN</div>
                    <div className="font-mono font-black text-lg text-amber-400 bg-slate-950 px-2.5 py-1 rounded-xl border border-slate-800">
                      {p.pin_code || '—'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingStaffId(p.id);
                      setStaffName(p.display_name);
                      setStaffPin(p.pin_code || '');
                      setStaffRole(p.role);
                      setStaffScreens(p.assigned_screens);
                    }}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 flex items-center gap-1"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Editar</span>
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      if (!profile) return;
                      try {
                        await toggleRevokeProfile(
                          p.id,
                          !p.revoked,
                          bundle.race.id,
                          profile.id
                        );
                        await loadData();
                        notify(
                          'ok',
                          !p.revoked
                            ? `PIN de ${p.display_name} revocado.`
                            : `PIN de ${p.display_name} reactivado.`
                        );
                      } catch (err) {
                        notify(
                          'err',
                          err instanceof Error ? err.message : 'Error al cambiar estado'
                        );
                      }
                    }}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${
                      p.revoked
                        ? 'bg-emerald-900/60 hover:bg-emerald-800 text-emerald-200'
                        : 'bg-rose-950 hover:bg-rose-900 text-rose-200'
                    }`}
                  >
                    {p.revoked ? (
                      <>
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Reactivar PIN</span>
                      </>
                    ) : (
                      <>
                        <ShieldBan className="w-3.5 h-3.5" />
                        <span>Revocar PIN</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* =====================================================================
          PESTAÑA 5: AUDITORÍA INMUTABLE
      ===================================================================== */}
      {activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h2 className="font-black text-base flex items-center gap-2">
            <History className="w-4 h-4 text-amber-400" />
            <span>Registro de Auditoría Inmutable (audit_log)</span>
          </h2>
          {bundle.auditLogs.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center">
              Aún no hay eventos de auditoría registrados en esta sesión.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto rounded-xl border border-slate-800">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-slate-950 text-slate-400 sticky top-0">
                  <tr>
                    <th className="py-2.5 px-3">Fecha / Hora</th>
                    <th className="py-2.5 px-3">Usuario</th>
                    <th className="py-2.5 px-3">Acción</th>
                    <th className="py-2.5 px-3">Detalle / Motivo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {bundle.auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-2 px-3 font-mono text-[11px] text-slate-400">
                        {new Date(log.created_at).toLocaleTimeString('es-AR')}
                      </td>
                      <td className="py-2 px-3 font-bold text-slate-200">
                        {log.actor_name}
                      </td>
                      <td className="py-2 px-3">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-amber-300 font-mono text-[11px]">
                          {log.action}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-slate-300">
                        <div>{log.reason || '—'}</div>
                        {log.after_data && (
                          <div className="font-mono text-[10px] text-slate-400 truncate max-w-md">
                            {JSON.stringify(log.after_data)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal de Importación CSV / Excel */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-lg flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-emerald-400" />
                <span>Importar Atletas y Duplas (CSV o Excel .xlsx)</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="text-xs text-slate-400 hover:text-white"
              >
                Cerrar ✕
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-1.5">
              <p>
                Podés subir directamente un archivo <strong>Excel (.xlsx / .xls)</strong> o{' '}
                <strong>CSV (.csv)</strong> descargado desde esta misma app y editado con
                tus competidores reales, o pegar filas manualmente:
              </p>
              <code className="block bg-slate-950 p-2 rounded border border-slate-800 text-amber-300 font-mono">
                dorsal;categoria;nombre_o_equipo;integrante_1;integrante_2
              </code>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black cursor-pointer flex items-center gap-1.5 shadow-sm">
                <Upload className="w-4 h-4" />
                <span>Elegir archivo CSV o Excel (.xlsx)</span>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  onChange={handleCsvFileUpload}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={handleDownloadEntriesExcel}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-emerald-300 border border-slate-700 flex items-center gap-1.5"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Descargar padrón actual (.xlsx)</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadEntriesCsv}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700 flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Descargar padrón actual (.csv)</span>
              </button>

              <button
                type="button"
                onClick={() => handleCsvTextChange(generateSampleEntriesCsv())}
                className="px-3 py-2 rounded-xl bg-slate-950 hover:bg-slate-800 text-xs font-semibold text-amber-300 border border-slate-800"
              >
                Cargar ejemplo de prueba
              </button>
            </div>

            {importedFileName && (
              <div className="px-3 py-2 rounded-xl bg-emerald-950/70 border border-emerald-700/70 text-emerald-200 text-xs font-bold flex items-center justify-between">
                <span>Archivo cargado: {importedFileName}</span>
                <span>{csvPreviewRows.length} filas listas</span>
              </div>
            )}

            <textarea
              rows={5}
              value={csvRawText}
              onChange={(e) => handleCsvTextChange(e.target.value)}
              className="w-full rounded-xl bg-slate-950 border border-slate-700 p-3 font-mono text-xs"
              placeholder="Subí un archivo CSV / Excel (.xlsx) arriba o pegá aquí las filas de tu CSV..."
            />

            <div className="bg-slate-950 rounded-xl p-3 border border-slate-800 max-h-48 overflow-y-auto space-y-1 text-xs">
              <div className="font-bold text-slate-400 mb-1">
                Vista previa ({csvPreviewRows.length} filas detectadas):
              </div>
              {csvPreviewRows.map((r) => (
                <div
                  key={r.rowNumber}
                  className={`flex items-center justify-between py-1 border-b border-slate-900 ${
                    r.error ? 'text-rose-400' : 'text-slate-200'
                  }`}
                >
                  <span>
                    Fila {r.rowNumber}:{' '}
                    <strong>{r.bib ? `#${r.bib}` : '[Auto-Salto]'}</strong> ·{' '}
                    {r.categorySlugOrName} · {r.displayName}
                    {r.members.length > 0 ? ` (${r.members.join(' + ')})` : ''}
                  </span>
                  {r.error && (
                    <span className="inline-flex items-center gap-1 text-rose-400 font-bold">
                      <ShieldAlert className="w-3.5 h-3.5" /> {r.error}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCsvModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-xs font-bold"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmCsvImport}
                disabled={csvPreviewRows.length === 0}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-xs font-black"
              >
                Confirmar e Importar ({csvPreviewRows.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmación para Borrado Masivo de Todos los Atletas */}
      {showDeleteAllModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-rose-700/80 rounded-2xl max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-xl bg-rose-950 border border-rose-800 text-rose-400 shrink-0">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-black text-base sm:text-lg text-white">
                  ¿Borrar de forma masiva a todos los atletas?
                </h3>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                  Estás por eliminar los{' '}
                  <strong className="text-rose-300">
                    {bundle.entries.length} atletas y duplas
                  </strong>{' '}
                  cargados actualmente (y cualquier tiempo de prueba asociado). Las{' '}
                  <strong>8 categorías oficiales</strong> y los <strong>PINs de staff</strong>{' '}
                  se mantendrán intactos para que puedas importar tu archivo CSV o Excel
                  limpio.
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                ¿Todavía no guardaste copia?
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleDownloadEntriesCsv}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-bold text-slate-200 border border-slate-700"
                >
                  Bajar CSV
                </button>
                <button
                  type="button"
                  onClick={handleDownloadEntriesExcel}
                  className="px-2.5 py-1 rounded-lg bg-emerald-950 hover:bg-emerald-900 text-[11px] font-bold text-emerald-200 border border-emerald-800"
                >
                  Bajar Excel
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deletingAll}
                onClick={() => setShowDeleteAllModal(false)}
                className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletingAll}
                onClick={handleConfirmDeleteAllEntries}
                className="px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-black flex items-center gap-1.5 shadow-lg shadow-rose-600/20"
              >
                <Trash2 className="w-4 h-4" />
                <span>
                  {deletingAll
                    ? 'Borrando padrón...'
                    : `Sí, borrar los ${bundle.entries.length} atletas`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
