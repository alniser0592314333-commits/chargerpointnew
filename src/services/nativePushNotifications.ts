import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications, type PushNotificationSchema, type Token } from '@capacitor/push-notifications';
import { config } from '../config/env';

type AppVariant = 'admin' | 'customer';
type TokenProvider = () => string | null | Promise<string | null>;

const buildVariant = import.meta.env.VITE_APP_VARIANT;
const nativePushEnabled = import.meta.env.VITE_NATIVE_PUSH_ENABLED === 'true';
let currentVariant: AppVariant | null = buildVariant === 'admin' || buildVariant === 'customer' ? buildVariant : null;
let currentTokenProvider: TokenProvider | null = null;
let currentLocale = 'ar';
let currentNavigationTarget = currentVariant === 'customer' ? '/public/about' : '/app/notifications';
let latestPushToken: string | null = null;
let lastAuthorizedToken: string | null = null;
let listenersReady: Promise<void> | null = null;
let registrationInFlight = false;
let lifecycleGeneration = 0;
let tokenPersistencePromise: Promise<void> | null = null;
let localeObserver: MutationObserver | null = null;

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
  const generation = lifecycleGeneration;
  try {
    const value = await currentTokenProvider?.();
    if (typeof value === 'string' && value.trim()) {
      // A provider promise may resolve after logout; never repopulate auth state
      // from a lifecycle that has already been invalidated.
      if (generation === lifecycleGeneration && currentTokenProvider) lastAuthorizedToken = value.trim();
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
    // Do not copy server response bodies into device logs; keep backend diagnostics
    // and any future response fields out of logs on shared/customer devices.
    throw new Error('Native push registration failed (' + response.status + ').');
  }
};

const persistLatestToken = async (token: string) => {
  // Ignore token callbacks after logout instead of restoring stale in-memory state.
  if (!currentTokenProvider) return;
  latestPushToken = token;
  const generation = lifecycleGeneration;
  // Serialize token persistence so logout can wait for any already-started register
  // request before issuing unregister; otherwise network response order can rebind
  // the device after logout.
  const previous = tokenPersistencePromise;
  const operation = (async () => {
    await previous?.catch(() => undefined);
    const bearer = await getAccessToken();
    if (generation !== lifecycleGeneration || !currentTokenProvider || !bearer || !currentVariant) return;
    await callEndpoint('register', bearer, token);
  })();
  tokenPersistencePromise = operation;
  try {
    await operation;
  } catch (error) {
    // Registration failures must never interrupt login, payments, or normal app use.
    console.warn('Native push device registration is unavailable.', error);
  } finally {
    if (tokenPersistencePromise === operation) tokenPersistencePromise = null;
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

const resolveNotificationTarget = (data: Record<string, unknown> | undefined): string => {
  const requested = typeof data?.targetPath === 'string' ? data.targetPath : currentNavigationTarget;
  if (currentVariant === 'admin') {
    if (requested === '/app/goals' || requested === '/app/notifications' ||
        requested === '/app/days' || requested === '/app/customers' ||
        requested === '/app/financials') return requested;
    // Order links are only allowed to navigate to the existing order/day detail route.
    if (/^\/app\/days\/[0-9a-f-]{36}#order-card-[0-9a-f-]{36}$/i.test(requested)) return requested;
    if (/^\/app\/customers\/[0-9a-f-]{36}$/i.test(requested)) return requested;
    if (/^\/app\/financials\/customers\/[0-9a-f-]{36}$/i.test(requested)) return requested;
    return '/app/notifications';
  }

  // Semantic customer destinations are resolved locally so customer QR tokens
  // never need to be embedded in server-side notification payloads.
  const params = requested.startsWith('/customer/') ? requested.slice('/customer/'.length) : '';
  if (params) {
    let savedToken = '';
    try { savedToken = window.localStorage.getItem('last_customer_token')?.trim() || ''; } catch {}
    if (savedToken && savedToken.length <= 512) {
      const separator = params.indexOf('?');
      const tab = separator >= 0 ? params.slice(0, separator) : params;
      const query = separator >= 0 ? params.slice(separator + 1) : '';
      if (tab === 'goals' || tab === 'orders' || tab === 'finance' || tab === 'home') {
        const safeQuery = new URLSearchParams(query);
        const clean = new URLSearchParams({ tab });
        if (tab === 'orders') {
          const number = safeQuery.get('orderNumber') || '';
          const createdAt = safeQuery.get('orderCreatedAt') || '';
          if (/^\d{1,9}$/.test(number)) clean.set('orderNumber', number);
          if (createdAt && !Number.isNaN(Date.parse(createdAt))) clean.set('orderCreatedAt', createdAt);
        }
        return '/c/' + encodeURIComponent(savedToken) + '?' + clean.toString();
      }
    }
    return '/public/about';
  }
  if (requested === '/public/about' || requested.startsWith('/c/') ||
      requested.startsWith('/pay/') || requested.startsWith('/o/') ||
      requested.startsWith('/public/order/') || requested.startsWith('/public/qr/')) return requested;
  return '/public/about';
};

const navigateFromNotification = (data: Record<string, unknown> | undefined) => {
  const safeTarget = resolveNotificationTarget(data);
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
  if (!Capacitor.isNativePlatform() || !nativePushEnabled) return;
  currentVariant = variant;
  currentNavigationTarget = notificationTarget(variant);
  currentLocale = locale === 'en' ? 'en' : 'ar';
  if (!localeObserver && typeof MutationObserver !== 'undefined') {
    localeObserver = new MutationObserver(() => {
      const nextLocale = document.documentElement.lang === 'en' ? 'en' : 'ar';
      if (nextLocale === currentLocale) return;
      currentLocale = nextLocale;
      if (latestPushToken) void persistLatestToken(latestPushToken);
    });
    localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }
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
async function startNativePushNotificationsInternal(
  variant: AppVariant,
  tokenProvider: TokenProvider,
  locale: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform() || !nativePushEnabled || registrationInFlight) return;
  const generation = lifecycleGeneration;
  currentVariant = variant;
  currentTokenProvider = tokenProvider;
  currentLocale = locale === 'en' ? 'en' : 'ar';
  currentNavigationTarget = notificationTarget(variant);
  const bearer = await getAccessToken();
  if (generation !== lifecycleGeneration || !bearer) return;

  registrationInFlight = true;
  try {
    await ensureListeners();
    if (generation !== lifecycleGeneration) return;
    const permission = await PushNotifications.checkPermissions();
    const receivePermission = permission.receive === 'granted'
      ? permission
      : await PushNotifications.requestPermissions();
    if (generation !== lifecycleGeneration || receivePermission.receive !== 'granted') return;
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
    if (generation !== lifecycleGeneration) return;
    // Re-register the previously issued FCM token after an auth/session refresh.
    if (latestPushToken) await persistLatestToken(latestPushToken);
  } catch (error) {
    console.warn('Native push notifications could not be initialized.', error);
  } finally {
    registrationInFlight = false;
  }
}

/**
 * Coalesce concurrent startup calls (including React Strict Mode effect replay).
 * A shared promise prevents parallel permission prompts and duplicate native registration.
 */
let startPromise: Promise<void> | null = null;
let queuedStartRequest: { variant: AppVariant; tokenProvider: TokenProvider; locale: string } | null = null;

export function startNativePushNotifications(
  variant: AppVariant,
  tokenProvider: TokenProvider,
  locale: string,
): Promise<void> {
  const request = { variant, tokenProvider, locale };
  if (startPromise || registrationInFlight) {
    // If authentication changes while the first native registration is still in
    // flight, keep the newest session request and run it after the old attempt ends.
    // Otherwise the old session can win the race and leave the device bound stale.
    queuedStartRequest = request;
    return startPromise ?? Promise.resolve();
  }
  const pending = startNativePushNotificationsInternal(variant, tokenProvider, locale);
  const tracked = pending.finally(() => {
    if (startPromise === tracked) startPromise = null;
    const queued = queuedStartRequest;
    queuedStartRequest = null;
    if (queued) void startNativePushNotifications(queued.variant, queued.tokenProvider, queued.locale);
  });
  startPromise = tracked;
  return tracked;
}

/** Remove the server-side binding before/while an authenticated user signs out. */
export async function stopNativePushNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform() || !currentVariant) return;
  // Invalidate in-flight startup/token callbacks synchronously before awaiting anything.
  const provider = currentTokenProvider;
  const token = latestPushToken ?? undefined;
  const cachedBearer = lastAuthorizedToken;
  lifecycleGeneration += 1;
  startPromise = null;
  queuedStartRequest = null;
  currentTokenProvider = null;
  latestPushToken = null;
  lastAuthorizedToken = null;

  // Drain any register request that already crossed its generation check before
  // logout; unregister must be the final server-side operation for this device.
  const pendingPersistence = tokenPersistencePromise;
  await pendingPersistence?.catch(() => undefined);

  // If logout races the first token lookup, resolve the captured provider only for
  // unregistering; the invalidated startup path can no longer register afterwards.
  const bearer = cachedBearer || await Promise.resolve().then(() => provider?.()).catch(() => null);
  lastAuthorizedToken = null;
  if (bearer) {
    try {
      await callEndpoint('unregister', bearer, token);
    } catch (error) {
      console.warn('Could not unregister native push device.', error);
    }
  }
}
