import { useEffect, useState } from 'react';
import { invokeSupabaseRpc } from '../services/supabase/client';

/**
 * Pending QR receipts are the administrator's actionable notification queue.
 * Read only the existing server-authoritative RPC; never query private tables
 * directly or treat locally cached counts as authoritative.
 */
export function usePendingNotificationCount(enabled = true): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;
    const refresh = async () => {
      if (running || navigator.onLine === false || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const { data, error } = await invokeSupabaseRpc<Array<Record<string, unknown>>>(
          'list_pending_qr_payment_submissions',
          {},
        );
        if (!disposed && !error) setCount(Array.isArray(data) ? data.length : 0);
      } catch {
        // Keep the last known badge during transient outages; the RPC remains authoritative.
      } finally {
        running = false;
      }
    };
    const onOnline = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10000);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  return count;
}
