import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { callCustomerAccount } from '../services/customer/customerAuth';
import { getSupabaseAuthToken, invokeSupabaseRpc } from '../services/supabase/client';

type AdminInbox = {
  requests?: Array<{ status?: string }>;
  events?: Array<{ is_read?: boolean }>;
};

export function useAdminNotificationCount(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== 'visible' || navigator.onLine === false) return;
      const token = getSupabaseAuthToken();
      if (!token) return;
      inFlight = true;
      try {
        const [paymentsResult, inboxResult] = await Promise.all([
          invokeSupabaseRpc<Array<Record<string, unknown>>>('list_pending_qr_payment_submissions', {}),
          callCustomerAccount<AdminInbox>('admin-list', {}, token),
        ]);
        if (disposed) return;
        let nextCount = 0;
        if (!paymentsResult.error && Array.isArray(paymentsResult.data)) {
          nextCount += paymentsResult.data.length;
        }
        if (!inboxResult.error && inboxResult.data) {
          const requests = Array.isArray(inboxResult.data.requests) ? inboxResult.data.requests : [];
          const events = Array.isArray(inboxResult.data.events) ? inboxResult.data.events : [];
          nextCount += requests.filter((request) => String(request.status || '').toUpperCase() === 'PENDING').length;
          nextCount += events.filter((event) => event.is_read === false).length;
        }
        setCount(nextCount);
      } catch {
        // Keep the last confirmed count if the network is temporarily unavailable.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10000);
    let pushListener: { remove: () => Promise<void> } | null = null;
    let pushListenerDisposed = false;
    if (Capacitor.isNativePlatform()) {
      void PushNotifications.addListener('pushNotificationReceived', () => { void refresh(); })
        .then((handle) => {
          if (pushListenerDisposed) void handle.remove();
          else pushListener = handle;
        })
        .catch((error) => console.warn('Notification badge push refresh listener unavailable.', error));
    }
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onOnline = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      pushListenerDisposed = true;
      if (pushListener) void pushListener.remove();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return count;
}
