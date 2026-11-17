import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LogOut,
  ShieldCheck,
  Sun,
  Moon,
  Timer,
  Trophy,
  Wifi,
  WifiOff,
  Database,
  CloudUpload,
  UserCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import {
  subscribeSyncQueueStats,
  type SyncQueueStats,
} from '../lib/offlineSyncEngine';

export const Navbar: React.FC = () => {
  const { profile, logout, highContrastSunMode, toggleSunMode } = useAuth();
  const location = useLocation();
  const [syncStats, setSyncStats] = useState<SyncQueueStats | null>(null);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    return subscribeSyncQueueStats((st) => setSyncStats(st));
  }, []);

  const isOnline = syncStats ? syncStats.isOnline : true;
  const pendingCount = syncStats?.pendingCount ?? 0;

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link
            to="/"
            className="flex items-center gap-2 font-black tracking-tight text-amber-400 text-base sm:text-lg shrink-0"
          >
            <img
              src="/skol-logo.jpg"
              alt="SKOL Classic"
              className="w-9 h-9 rounded-lg object-cover border border-amber-400/50 shadow-sm"
            />
            <div className="leading-none">
              <span className="block text-sm sm:text-base font-black tracking-wider text-amber-400">
                SKOL CLASSIC
              </span>
              <span className="block text-[9px] font-bold uppercase tracking-widest text-slate-400">
                Cronometraje Oficial
              </span>
            </div>
          </Link>

          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${
              isOnline
                ? 'bg-emerald-950/90 text-emerald-300 border border-emerald-700/60'
                : 'bg-rose-950/90 text-rose-300 border border-rose-700/60'
            }`}
            title={
              isSupabaseConfigured
                ? 'Conectado a Supabase + Cola Offline IndexedDB'
                : 'Modo Offline-First Local (IndexedDB)'
            }
          >
            {isOnline ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {isOnline ? 'Online' : 'Offline'}
            {!isSupabaseConfigured && (
              <span className="hidden sm:inline-flex items-center gap-0.5 text-amber-300 ml-1">
                · <Database className="w-2.5 h-2.5" /> LocalDB
              </span>
            )}
          </span>

          {pendingCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500 text-slate-950 text-[11px] font-black">
              <CloudUpload className="w-3 h-3" />
              <span>{pendingCount} pend.</span>
            </span>
          )}
        </div>

        <nav className="flex items-center gap-1.5 sm:gap-2">
          {profile?.role === 'admin' && (
            <Link
              to="/admin"
              className={`px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-1.5 transition ${
                location.pathname.startsWith('/admin')
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-slate-900 text-slate-200 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Admin</span>
            </Link>
          )}

          {profile && (
            <Link
              to="/crono"
              className={`px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-1.5 transition ${
                location.pathname.startsWith('/crono')
                  ? 'bg-amber-500 text-slate-950'
                  : 'bg-slate-900 text-slate-200 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              <Timer className="w-4 h-4" />
              <span>Crono</span>
            </Link>
          )}

          <Link
            to="/resultados"
            className={`px-2.5 py-1.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-1.5 transition ${
              location.pathname.startsWith('/resultados')
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-900 text-slate-200 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <Trophy className="w-4 h-4" />
            <span className="hidden sm:inline">Resultados</span>
          </Link>

          <button
            type="button"
            onClick={toggleSunMode}
            className="px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-700 flex items-center gap-1.5 text-xs font-bold transition"
            title={
              highContrastSunMode
                ? 'Cambiar a Modo Oscuro'
                : 'Cambiar a Modo Claro'
            }
          >
            {highContrastSunMode ? (
              <>
                <Moon className="w-4 h-4" />
                <span className="hidden sm:inline">Oscuro</span>
              </>
            ) : (
              <>
                <Sun className="w-4 h-4" />
                <span className="hidden sm:inline">Claro</span>
              </>
            )}
          </button>

          {profile && (
            <div className="flex items-center gap-1.5 pl-1 border-l border-slate-800">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(true)}
                className="p-2 rounded-lg bg-rose-950/70 hover:bg-rose-900 text-rose-200 border border-rose-800/60"
                title="Cerrar sesión"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </nav>
      </div>

      {/* Cartel de bienvenida superior para cada Staff / Admin que ingresa */}
      {profile && (
        <div className="bg-amber-500/15 border-t border-amber-500/30 px-3 py-1.5">
          <div className="max-w-7xl mx-auto flex items-center justify-between text-xs sm:text-sm">
            <div className="flex items-center gap-2 font-black text-amber-400">
              <UserCheck className="w-4 h-4 shrink-0" />
              <span>¡Hola, {profile.display_name}!</span>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-900/90 text-slate-300 border border-slate-700">
              {profile.role === 'admin' ? 'Administrador General' : 'Staff Cronometrista'}
            </span>
          </div>
        </div>
      )}

      {/* Modal de Confirmación al tocar la puertita de Salir */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border-2 border-slate-700 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400 shrink-0">
                <LogOut className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black text-white">
                  ¿Estás seguro que quieres salir?
                </h3>
                <p className="text-xs text-slate-400">
                  Se cerrará tu sesión actual ({profile?.display_name}).
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-black uppercase text-slate-200 border border-slate-700"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowLogoutConfirm(false);
                  await logout();
                }}
                className="py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-xs font-black uppercase text-white shadow-lg"
              >
                Sí, salir
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
