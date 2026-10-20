import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications, type PushNotificationSchema, type Token } from '@capacitor/push-notifications';
import { config } from '../config/env';

type AppVariant = 'admin' | 'customer';
type TokenProvider = () => string | null | Promise<string | null>;

const buildVariant = import.meta.env.VITE_APP_VARIANT;
let currentVariant: AppVariant | null = buildVariant === 'admin' || buildVariant === 'customer' ? buildVariant : null;
let currentTokenProvider: TokenProvider | null = null;
let currentLocale = 'ar';
let currentNavigationTarget = currentVariant === 'customer' ? '/public/about' : '/app/notifications';
let latestPushToken: string | null = null;
let lastAuthorizedToken: string | null = null;
let listenersReady: Promise<void> | null = null;
let registrationInFlight = false;

const endpoint = () => config.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/native-push';

const deviceId = (bearer: string, variant: AppVariant): string => {
  // Device identifiers are scoped per authenticated identity. They are not secrets
  // or authorization credentials; the server independently verifies the session.
  let subject = 'unknown';
  try {
    const payload = bearer.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    if (typeof claims.sub === 'string' && claims.sub) subject = claims.sub;
  } catch {}
  const key = 'cp_native_push_device_id:' + variant + ':' + subject;
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
};

const getAccessToken = async (): Promise<string | null> => {
  try {
    const value = await currentTokenProvider?.();
    if (typeof value === 'string' && value.trim()) {
      lastAuthorizedToken = value.trim();
      return value.trim();
    }
  } catch {}
  return null;
};

const callEndpoint = async (action: 'register' | 'unregister', bearer: string, token?: string) => {
  if (!config.supabaseUrl || !config.supabaseAnonKey || !bearer) return;
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: 'Bearer ' + bearer,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action,
      deviceId: deviceId(bearer, currentVariant ?? 'customer'),
      appVariant: currentVariant,
      platform: Capacitor.getPlatform(),
      locale: currentLocale,
      ...(token ? { token } : {}),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Native push registration failed (' + response.status + '): ' + detail.slice(0, 160));
  }
};

const persistLatestToken = async (token: string) => {
  latestPushToken = token;
  const bearer = await getAccessToken();
  if (!bearer || !currentVariant) return;
  try {
    await callEndpoint('register', bearer, token);
  } catch (error) {
    // Registration failures must never interrupt login, payments, or normal app use.
    console.warn('Native push device registration is unavailable.', error);
  }
};

const notificationTarget = (variant: AppVariant) =>
  variant === 'admin' ? '/app/notifications' : '/public/about';

const showForegroundNotification = async (notification: PushNotificationSchema) => {
  const title = notification.title?.trim();
  const body = notification.body?.trim();
  if (!title && !body) return;
  try {
    const permissions = await LocalNotifications.checkPermissions();
    if (permissions.display !== 'granted') {
      const requested = await LocalNotifications.requestPermissions();
      if (requested.display !== 'granted') return;
    }
    const rawId = String(notification.data?.eventId ?? notification.data?.id ?? Date.now());
    let id = 0;
    for (let i = 0; i < rawId.length; i += 1) id = (Math.imul(id, 31) + rawId.charCodeAt(i)) | 0;
    id = Math.abs(id) || 1;
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title: title || (currentLocale === 'ar' ? 'نقطة الشحن' : 'Charging Point'),
        body: body || '',
        extra: { targetPath: notification.data?.targetPath || currentNavigationTarget },
        schedule: { at: new Date(Date.now() + 250) },
      }],
    });
  } catch (error) {
    console.warn('Could not display foreground native notification.', error);
  }
};

const navigateFromNotification = (data: Record<string, unknown> | undefined) => {
  const requested = typeof data?.targetPath === 'string' ? data.targetPath : currentNavigationTarget;
  const safeTarget = currentVariant === 'admin'
    ? (requested === '/app/notifications' || requested === '/app/goals' ? requested : '/app/notifications')
    : '/public/about';
  // Full navigation also supports taps when Android has recreated the WebView.
  window.location.assign(safeTarget);
};

async function ensureListeners() {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await PushNotifications.addListener('registration', (token: Token) => {
      void persistLatestToken(token.value);
    });
    await PushNotifications.addListener('registrationError', (error) => {
      console.warn('Native push registration error.', error);
    });
    await PushNotifications.addListener('pushNotificationReceived', (notification) => {
      void showForegroundNotification(notification);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      navigateFromNotification(action.notification.data as Record<string, unknown> | undefined);
    });
    await LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      navigateFromNotification(action.notification.extra as Record<string, unknown> | undefined);
    });
  })().catch((error) => {
    listenersReady = null;
    throw error;
  });
  return listenersReady;
}

/** Attach tap listeners at app startup, before authentication restoration finishes. */
export async function initializeNativePushNotificationListeners(variant: AppVariant, locale: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  currentVariant = variant;
  currentNavigationTarget = notificationTarget(variant);
  currentLocale = locale === 'en' ? 'en' : 'ar';
  try {
    await ensureListeners();
  } catch (error) {
    console.warn('Native notification listeners could not be initialized.', error);
  }
}

/**
 * Register this installation only after the existing app/customer authentication flow
 * has established a valid session. The server independently validates the session,
 * derives the recipient identity, and never trusts a client-supplied user/customer ID.
 */
export async function startNativePushNotifications(
  variant: AppVariant,
  tokenProvider: TokenProvider,
  locale: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform() || registrationInFlight) return;
  currentVariant = variant;
  currentTokenProvider = tokenProvider;
  currentLocale = locale === 'en' ? 'en' : 'ar';
  currentNavigationTarget = notificationTarget(variant);
  const bearer = await getAccessToken();
  if (!bearer) return;

  registrationInFlight = true;
  try {
    await ensureListeners();
    const permission = await PushNotifications.checkPermissions();
    const receivePermission = permission.receive === 'granted'
      ? permission
      : await PushNotifications.requestPermissions();
    if (receivePermission.receive !== 'granted') return;
    if (Capacitor.getPlatform() === 'android') {
      await PushNotifications.createChannel({
        id: 'charging-point-events',
        name: 'Charging Point updates',
        description: 'Important account and payment updates',
        importance: 5,
        visibility: 1,
        vibration: true,
      }).catch(() => undefined);
    }
    await PushNotifications.register();
    // Re-register the previously issued FCM token after an auth/session refresh.
    if (latestPushToken) await persistLatestToken(latestPushToken);
  } catch (error) {
    console.warn('Native push notifications could not be initialized.', error);
  } finally {
    registrationInFlight = false;
  }
}

/** Remove the server-side binding before/while an authenticated user signs out. */
export async function stopNativePushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !currentVariant) return;
  const bearer = await getAccessToken().catch(() => null) || lastAuthorizedToken;
  if (bearer) {
    try {
      await callEndpoint('unregister', bearer, latestPushToken ?? undefined);
    } catch (error) {
      console.warn('Could not unregister native push device.', error);
    }
  }
  latestPushToken = null;
  lastAuthorizedToken = null;
  currentTokenProvider = null;
}
