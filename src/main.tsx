import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { LibraryProvider } from './store'
import { PeopleProvider } from './people'
import './styles.css'

async function boot() {
  // Vite DCE: Tauri CLI sets TAURI_ENV_PLATFORM and vite.config omits the PWA plugin.
  if (!import.meta.env.TAURI_ENV_PLATFORM) {
    const { registerSW } = await import('virtual:pwa-register')
    registerSW({ immediate: true })
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LibraryProvider>
        <PeopleProvider>
          <App />
        </PeopleProvider>
      </LibraryProvider>
    </StrictMode>,
  )
}

void boot()
