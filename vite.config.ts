import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // The default build remains the existing web/PWA app. Native APK builds
  // explicitly select customer/admin so each APK has a single app entry point.
  const appVariant = mode === 'customer' || mode === 'admin' ? mode : 'web';

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        // The deployed web application is served from the origin root.
        // Keep the service worker and manifest aligned with the existing web entry point.
        scope: '/',
        // The canonical web manifest is checked in at public/manifest.webmanifest.
        manifest: false,
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          // This is a root-scoped SPA. Navigation requests should fall back to
          // index.html except for API paths, which must remain network-only.
          navigateFallbackAllowlist: [/^(?!\/rest\/v1\/).*/],
          navigateFallbackDenylist: [/^\/rest\/v1\//, /^https:\/\/.*\.supabase\.co\/.*/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
              handler: 'NetworkOnly',
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    define: {
      // Compile-time constant allows Rollup to remove the other app's entry
      // branch from each native build instead of merely hiding its UI.
      'import.meta.env.VITE_APP_VARIANT': JSON.stringify(appVariant),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.VITE_SUPABASE_URL ?? 'https://ydhcyamtgioyrxfarkwk.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_dXsrK8ltM6DCZ88HgfP27w_bxb3rvGN'),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
