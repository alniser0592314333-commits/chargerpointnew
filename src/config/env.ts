/**
 * Centralized Configuration & Environment Variables
 * Strict separation of development and production configurations.
 * No secrets exposed on frontend.
 */

export interface AppConfig {
  appName: string;
  env: 'development' | 'production' | 'test';
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiTimeoutMs: number;
  enableOfflineSync: boolean;
}

export const config: AppConfig = {
  appName: 'Order & Customer Management System',
  env: ((typeof import.meta !== 'undefined' && import.meta.env?.MODE) || (typeof process !== 'undefined' && process.env?.MODE) || 'development') as AppConfig['env'],
  supabaseUrl: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_URL) || '',
  supabaseAnonKey: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) || (typeof process !== 'undefined' && process.env?.VITE_SUPABASE_ANON_KEY) || '',
  apiTimeoutMs: 15000,
  enableOfflineSync: true,
};

// Validate required configuration stubs in production
export function validateConfig(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (config.env === 'production') {
    if (!config.supabaseUrl) errors.push('VITE_SUPABASE_URL is missing in production configuration.');
    if (!config.supabaseAnonKey) errors.push('VITE_SUPABASE_ANON_KEY is missing in production configuration.');
  }
  return {
    isValid: errors.length === 0,
    errors,
  };
}
