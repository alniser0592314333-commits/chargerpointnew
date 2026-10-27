import type { SyncEvent } from './syncEngine';

const STORAGE_KEY = 'cp_sync_diagnostic_events_v1';
const MAX_EVENTS = 500;

export type PersistedSyncDiagnosticEvent = {
  recordedAt: string;
  event: SyncEvent;
};

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Keep a bounded, local-only forensic journal. Never includes auth headers or credentials. */
export function recordSyncDiagnosticEvent(event: SyncEvent): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const events: PersistedSyncDiagnosticEvent[] = Array.isArray(parsed) ? parsed : [];
    events.push({ recordedAt: new Date().toISOString(), event });
    storage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Diagnostics must never interrupt business operations if storage is full/unavailable.
  }
}

export function clearSyncDiagnosticJournal(): void {
  const storage = safeStorage();
  try { storage?.removeItem(STORAGE_KEY); } catch { /* best-effort diagnostics cleanup */ }
}

export function getSyncDiagnosticJournal(): PersistedSyncDiagnosticEvent[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

export function installSyncDiagnosticGlobalHandlers(): void {
  if (typeof window === 'undefined') return;
  const marker = '__cpSyncDiagnosticHandlersInstalled';
  const target = window as Window & { [key: string]: unknown };
  if (target[marker]) return;
  target[marker] = true;

  window.addEventListener('error', (event) => {
    recordSyncDiagnosticEvent({
      type: 'command_failed',
      commandId: 'runtime-unhandled-error',
      error: String(event.message || 'Uncaught JavaScript error').slice(0, 2000),
      timestamp: new Date().toISOString(),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'Unhandled promise rejection');
    recordSyncDiagnosticEvent({
      type: 'command_failed',
      commandId: 'runtime-unhandled-rejection',
      error: message.slice(0, 2000),
      timestamp: new Date().toISOString(),
    });
  });
}
