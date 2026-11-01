import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The app is published at https://cdrjohnson.github.io/photo-tagger/ so the default base is /photo-tagger/.
// Override with BASE_PATH (e.g. BASE_PATH=/ to host at a domain root, or ./ for a relative build).
const base = process.env.BASE_PATH || '/photo-tagger/'

// Transformers.js references a 27 MB asyncify/WebGPU build of ONNX Runtime that this app never loads
// (we serve the plain CPU wasm from /ort/ instead), so drop it from the bundle.
const dropUnusedWasm = (): Plugin => ({
  name: 'drop-unused-ort-wasm',
  generateBundle(_o, bundle) {
    for (const k of Object.keys(bundle)) if (/ort-wasm-simd-threaded\.(asyncify|jsep|jspi).*\.wasm$/.test(k)) delete bundle[k]
  },
})

export default defineConfig({
  base,
  plugins: [
    react(),
    dropUnusedWasm(),
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
            // ONNX Runtime wasm (served from our own origin) – cache after first use for offline tagging
            urlPattern: ({ url }) => url.pathname.includes('/ort/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ort-runtime', expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
})
