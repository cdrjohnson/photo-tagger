/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_DROPBOX_APP_KEY?: string
  readonly VITE_TAURI?: string
  readonly TAURI_ENV_PLATFORM?: string
  readonly TAURI_ENV_DEBUG?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module 'virtual:pwa-register' {
  export function registerSW(options?: { immediate?: boolean }): void
}
