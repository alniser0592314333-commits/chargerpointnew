import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { callCustomerAccount } from '../services/customer/customerAuth';
import { getSupabaseAuthToken, invokeSupabaseRpc } from '../services/supabase/client';

type AdminInbox = {
  pending_reset_requests?: number;
  unread_account_events?: number;
};
type AdminNotificationCounts = { notifications: number; customerAccounts: number };

export function useAdminNotificationCount(enabled: boolean): AdminNotificationCounts {
  const [counts, setCounts] = useState<AdminNotificationCounts>({ notifications: 0, customerAccounts: 0 });

  useEffect(() => {
    if (!enabled) {
      setCounts({ notifications: 0, customerAccounts: 0 });
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
          callCustomerAccount<AdminInbox>('admin-counts', {}, token),
        ]);
        if (disposed) return;
        const nextCounts: AdminNotificationCounts = { notifications: 0, customerAccounts: 0 };
        if (!paymentsResult.error && Array.isArray(paymentsResult.data)) {
          nextCounts.notifications = paymentsResult.data.length;
        }
        if (!inboxResult.error && inboxResult.data) {
          nextCounts.customerAccounts = Math.max(0, Number(inboxResult.data.pending_reset_requests) || 0)
            + Math.max(0, Number(inboxResult.data.unread_account_events) || 0);
        }
        setCounts(nextCounts);
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

  return counts;
}
