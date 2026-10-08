import { useSyncExternalStore } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const SERVER_SNAPSHOT = { installable: false, installed: false };
let snapshot = SERVER_SNAPSHOT;

const listeners = new Set<() => void>();

const computeSnapshot = () => ({
  installable: Boolean(deferredPrompt),
  installed: isPWARunningStandalone(),
});

const notify = () => {
  const nextSnapshot = computeSnapshot();
  if (
    nextSnapshot.installable !== snapshot.installable ||
    nextSnapshot.installed !== snapshot.installed
  ) {
    snapshot = nextSnapshot;
  }
  listeners.forEach((listener) => listener());
};

export function initializePWAInstallCapture(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });

  try {
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const handleDisplayModeChange = () => notify();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleDisplayModeChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(handleDisplayModeChange);
    }
  } catch {
    // Display-mode observation is optional; install events remain authoritative.
  }

  snapshot = computeSnapshot();
}

export function subscribePWAInstall(listener: () => void): () => void {
  initializePWAInstallCapture();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  initializePWAInstallCapture();
  return deferredPrompt;
}

export function isPWARunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mediaStandalone = window.matchMedia('(display-mode: standalone)').matches;
  const navigatorStandalone =
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return mediaStandalone || navigatorStandalone;
}

export async function promptPWAInstall(): Promise<boolean> {
  const promptEvent = getDeferredInstallPrompt();
  if (!promptEvent) return false;

  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;

  deferredPrompt = null;
  notify();

  return outcome === 'accepted';
}

export function usePWAInstallSnapshot() {
  return useSyncExternalStore(
    subscribePWAInstall,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}
