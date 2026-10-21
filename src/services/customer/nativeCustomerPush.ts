import { customerAuth } from './customerAuth';
import { startNativePushNotifications } from '../nativePushNotifications';

/** Start customer push only from the existing customer Auth session. */
export function startCustomerNativePushNotifications(locale: string): Promise<void> {
  return startNativePushNotifications('customer', async () => {
    const { data, error } = await customerAuth.auth.getSession();
    return error ? null : data.session?.access_token ?? null;
  }, locale);
}
