import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chargerpointnew.customer',
  appName: 'نقطة الشحن - العميل',
  webDir: 'dist/customer',
  server: {
    androidScheme: 'https',
  },
};

export default config;
