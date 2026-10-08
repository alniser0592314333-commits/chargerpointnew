import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        // AI Studio may provide its own root-scoped service worker in production.
        // Keep this PWA worker scoped to the authenticated application routes so
        // both workers can coexist without replacing each other at scope '/'.
        scope: '/app/',
        // The canonical manifest is the checked-in public/manifest.webmanifest.
        // Do not emit a second manifest from vite-plugin-pwa.
        manifest: false,
        includeAssets: undefined,
        /* manifest: {
          id: '/',
          name: 'منظومة إدارة الطلبات والزبائن',
          short_name: 'إدارة الطلبات',
          description: 'منظومة إدارة الطلبات والزبائن - هيكل هندسي احترافي متكامل يدعم العمل دون إنترنت.',
          theme_color: '#082622',
          background_color: '#082622',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/icon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any',
            },
          ],
        }, */
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          navigateFallbackAllowlist: [/^\/app(?:\/.*)?$/],
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
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.VITE_SUPABASE_URL || 'https://ydhcyamtgioyrxfarkwk.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_dXsrK8ltM6DCZ88HgfP27w_bxb3rvGN'),
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
