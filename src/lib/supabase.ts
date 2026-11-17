import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const envObj = (import.meta as { env?: Record<string, string | undefined> }).env;
const supabaseUrl = envObj?.VITE_SUPABASE_URL;
const supabaseAnonKey = envObj?.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('tu-proyecto.supabase.co') &&
    supabaseAnonKey !== 'tu-anon-key-publica'
);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

const DEVICE_ID_STORAGE_KEY = 'skol_crono_device_id';

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'srv-node-sim';
  }
  let id = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `dev-${crypto.randomUUID().slice(0, 8)}`
        : `dev-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}
