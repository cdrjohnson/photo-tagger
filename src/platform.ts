/** Runtime detection: Tauri desktop vs browser / PWA. */
export function isDesktop(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export function isTauriBuild(): boolean {
  return import.meta.env.TAURI_ENV_PLATFORM != null || import.meta.env.VITE_TAURI === '1'
}
