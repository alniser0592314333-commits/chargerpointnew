import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (value: any) => void>();
  return {
    listeners,
    native: true,
    fetch: vi.fn(),
    Capacitor: {
      isNativePlatform: vi.fn(() => true),
      getPlatform: vi.fn(() => 'android'),
    },
    PushNotifications: {
      addListener: vi.fn(async (name: string, callback: (value: any) => void) => {
        listeners.set(name, callback);
        return { remove: vi.fn() };
      }),
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
      requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
      createChannel: vi.fn(async () => undefined),
      register: vi.fn(async () => undefined),
    },
    LocalNotifications: {
      addListener: vi.fn(async (name: string, callback: (value: any) => void) => {
        listeners.set(name, callback);
        return { remove: vi.fn() };
      }),
      checkPermissions: vi.fn(async () => ({ display: 'granted' })),
      requestPermissions: vi.fn(async () => ({ display: 'granted' })),
      schedule: vi.fn(async (_options: any) => undefined),
    },
  };
});

vi.mock('@capacitor/core', () => ({ Capacitor: mocks.Capacitor }));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: mocks.PushNotifications }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: mocks.LocalNotifications }));
vi.mock('../config/env', () => ({
  config: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'publishable-test-key' },
}));

describe('native push notification integration', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_NATIVE_PUSH_ENABLED', 'true');
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.native = true;
    mocks.Capacitor.isNativePlatform.mockImplementation(() => mocks.native);
    mocks.Capacitor.getPlatform.mockReturnValue('android');
    mocks.PushNotifications.checkPermissions.mockResolvedValue({ receive: 'granted' });
    mocks.PushNotifications.requestPermissions.mockResolvedValue({ receive: 'granted' });
    mocks.LocalNotifications.checkPermissions.mockResolvedValue({ display: 'granted' });
    mocks.LocalNotifications.requestPermissions.mockResolvedValue({ display: 'granted' });
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('does not request permissions or register a token on the web build', async () => {
    mocks.native = false;
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await service.startNativePushNotifications('admin', () => 'valid-access-token', 'en');

    expect(mocks.PushNotifications.requestPermissions).not.toHaveBeenCalled();
    expect(mocks.PushNotifications.register).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not register a device until an authenticated session is available', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await service.startNativePushNotifications('admin', () => null, 'en');

    expect(mocks.PushNotifications.register).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('registers an authenticated admin FCM token with the server-derived identity flow', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await service.initializeNativePushNotificationListeners('admin', 'en');
    await service.startNativePushNotifications('admin', () => 'valid-access-token', 'en');
    mocks.listeners.get('registration')?.({ value: 'fcm-token-012345678901234567890123456789' });

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = mocks.fetch.mock.calls[0];
    const body = JSON.parse(init.body);

    expect(url).toBe('https://example.supabase.co/functions/v1/native-push');
    expect(init.headers.Authorization).toBe('Bearer valid-access-token');
    expect(body.action).toBe('register');
    expect(body.appVariant).toBe('admin');
    expect(body.locale).toBe('en');
    expect(body.token).toBe('fcm-token-012345678901234567890123456789');
    expect(body.deviceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mocks.PushNotifications.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'charging-point-events',
      importance: 5,
    }));
  });

  it('coalesces concurrent startup calls under React Strict Mode effect replay', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await Promise.all([
      service.startNativePushNotifications('admin', () => 'valid-access-token', 'en'),
      service.startNativePushNotifications('admin', () => 'valid-access-token', 'en'),
    ]);

    expect(mocks.PushNotifications.register).toHaveBeenCalledTimes(1);
    expect(mocks.PushNotifications.addListener).toHaveBeenCalledTimes(5);
  });

  it('cancels registration when logout races the initial auth-token lookup', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');
    let resolveToken!: (value: string) => void;
    const tokenLookup = new Promise<string>((resolve) => { resolveToken = resolve; });

    const starting = service.startNativePushNotifications('admin', () => tokenLookup, 'en');
    const stopping = service.stopNativePushNotifications();
    resolveToken('valid-access-token');

    await Promise.all([starting, stopping]);
    expect(mocks.PushNotifications.register).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).action).toBe('unregister');
  });

  it('unregisters on logout and cannot re-register from a late token callback', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await service.initializeNativePushNotificationListeners('admin', 'en');
    await service.startNativePushNotifications('admin', () => 'valid-access-token', 'en');
    mocks.listeners.get('registration')?.({ value: 'fcm-token-012345678901234567890123456789' });

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await service.stopNativePushNotifications();

    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).action).toBe('unregister');
    mocks.listeners.get('registration')?.({ value: 'late-fcm-token-012345678901234567890123456789' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('shows a foreground push as a local Android notification without exposing event details', async () => {
    vi.resetModules();
    const service = await import('../services/nativePushNotifications');

    await service.initializeNativePushNotificationListeners('customer', 'ar');
    mocks.listeners.get('pushNotificationReceived')?.({
      title: 'تمت مراجعة إشعار الدفع',
      body: 'تم اعتماد إشعار الدفع بعد المراجعة.',
      data: { eventId: 'qr_payment_submissions:123', targetPath: '/public/about' },
    });

    await vi.waitFor(() => expect(mocks.LocalNotifications.schedule).toHaveBeenCalledTimes(1));
    const payload = mocks.LocalNotifications.schedule.mock.calls[0][0];
    expect(payload.notifications[0].title).toBe('تمت مراجعة إشعار الدفع');
    expect(payload.notifications[0].extra.targetPath).toBe('/public/about');
  });
});
