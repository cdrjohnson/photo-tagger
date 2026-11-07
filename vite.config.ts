import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'

// Web/PWA (GitHub Pages): /photo-tagger/
// Tauri desktop: ./ (relative) — set BASE_PATH=./ and VITE_TAURI=1
const isTauri = process.env.TAURI_ENV_PLATFORM != null || process.env.VITE_TAURI === '1'
const base = process.env.BASE_PATH || (isTauri ? './' : '/photo-tagger/')

const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  base,
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version), __ORT_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version) },
  plugins: [
    react(),
    // Never register a service worker inside the Tauri webview
    ...(!isTauri
      ? [
          VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
            manifest: {
              name: 'Photo Tagger',
              short_name: 'Photo Tagger',
              description: 'Private, on-device photo tagging and filtering.',
              theme_color: '#4f46e5',
              background_color: '#0f1117',
              display: 'standalone',
              orientation: 'any',
              start_url: base,
              scope: base,
              id: base,
              icons: [
                { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
              ],
            },
            workbox: {
              globPatterns: ['**/*.{js,css,html,svg,png,json,webmanifest}'],
              globIgnores: ['ort/**'],
              maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
              navigateFallback: 'index.html',
              runtimeCaching: [
                {
                  urlPattern: ({ url }) => url.pathname.includes('/ort/'),
                  handler: 'CacheFirst',
                  options: { cacheName: 'ort-runtime', expiration: { maxEntries: 8 } },
                },
              ],
            },
          }),
        ]
      : []),
  ],
  worker: { format: 'es' },
  build: {
    target: isTauri
      ? (process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13')
      : 'es2022',
    chunkSizeWarningLimit: 4000,
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
