import type { CapacitorConfig } from '@capacitor/cli';
import adminConfig from './capacitor.admin.config';
import customerConfig from './capacitor.customer.config';

// Capacitor CLI reads this canonical filename. Select the target explicitly
// for every native command so the customer and admin builds keep separate IDs
// and point at their own compiled web assets.
const variant = process.env.CP_APP_VARIANT;
if (variant !== 'customer' && variant !== 'admin') {
  throw new Error('Set CP_APP_VARIANT to "customer" or "admin" before running Capacitor commands.');
}

const config: CapacitorConfig = variant === 'customer' ? customerConfig : adminConfig;

export default config;
