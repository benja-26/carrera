import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Profile } from '../types/domain';
import { loginWithPin } from '../lib/dataService';
import { db, ensureLocalSeed } from '../lib/db';
import { getOrCreateDeviceId, isSupabaseConfigured, supabase } from '../lib/supabase';

interface AuthContextValue {
  profile: Profile | null;
  deviceId: string;
  loading: boolean;
  highContrastSunMode: boolean;
  toggleSunMode: () => void;
  loginByPin: (pin: string, username?: string) => Promise<Profile>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const SESSION_STORAGE_KEY = 'skol_crono_active_profile_id';
const SUN_MODE_STORAGE_KEY = 'skol_crono_sun_mode';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [deviceId] = useState<string>(() => getOrCreateDeviceId());
  const [highContrastSunMode, setHighContrastSunMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SUN_MODE_STORAGE_KEY) === 'true';
  });

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('sun-mode', highContrastSunMode);
    }
  }, [highContrastSunMode]);

  const toggleSunMode = () => {
    setHighContrastSunMode((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SUN_MODE_STORAGE_KEY, String(next));
      }
      return next;
    });
  };

  const refreshProfile = async () => {
    await ensureLocalSeed();
    if (typeof window === 'undefined') return;
    const savedId = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!savedId) {
      setProfile(null);
      return;
    }
    const localProf = await db.profiles.get(savedId);
    if (!localProf || localProf.revoked) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      setProfile(null);
      return;
    }
    setProfile(localProf);
  };

  useEffect(() => {
    refreshProfile().finally(() => setLoading(false));
  }, []);

  const loginByPin = async (pin: string, username?: string): Promise<Profile> => {
    const resolved = await loginWithPin(pin, deviceId, username);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SESSION_STORAGE_KEY, resolved.id);
    }
    setProfile(resolved);
    return resolved;
  };

  const logout = async () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    if (isSupabaseConfigured && supabase) {
      await supabase.auth.signOut().catch(() => {});
    }
    setProfile(null);
  };

  return (
    <AuthContext.Provider
      value={{
        profile,
        deviceId,
        loading,
        highContrastSunMode,
        toggleSunMode,
        loginByPin,
        logout,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de un AuthProvider');
  }
  return ctx;
}
