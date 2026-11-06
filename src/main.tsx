import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { LibraryProvider } from './store'
import { PeopleProvider } from './people'
import './styles.css'

async function boot() {
  // Vite DCE: Tauri builds set VITE_TAURI=1 and omit the PWA plugin, so this import is dropped.
  if (import.meta.env.VITE_TAURI !== '1') {
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
