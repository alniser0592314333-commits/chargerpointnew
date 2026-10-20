import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chargerpointnew.admin',
  appName: 'نقطة الشحن - الإدارة',
  webDir: 'dist/admin',
  server: {
    androidScheme: 'https',
  },
};

export default config;
