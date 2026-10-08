import { useSyncExternalStore } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<() => void>();

const notify = () => {
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

  // The browser owns the prompt lifecycle. Do not retain a consumed event.
  deferredPrompt = null;
  notify();

  return outcome === 'accepted';
}

export function usePWAInstallSnapshot() {
  return useSyncExternalStore(
    subscribePWAInstall,
    () => ({
      installable: Boolean(deferredPrompt),
      installed: isPWARunningStandalone(),
    }),
    () => ({ installable: false, installed: false }),
  );
}
