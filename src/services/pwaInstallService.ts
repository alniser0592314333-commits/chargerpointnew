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

export function getPWAInstallState() {
  return {
    installable: Boolean(deferredPrompt),
    installed: isPWARunningStandalone(),
  };
}

export function isPWARunningStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  let mediaStandalone = false;
  try {
    if (typeof window.matchMedia === 'function') {
      mediaStandalone = window.matchMedia('(display-mode: standalone)').matches;
    }
  } catch {
    // Standalone detection is optional; failure must never prevent Settings from rendering.
  }

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
