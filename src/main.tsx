import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { LibraryProvider } from './store'
import { PeopleProvider } from './people'
import './styles.css'

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraryProvider>
      <PeopleProvider>
        <App />
      </PeopleProvider>
    </LibraryProvider>
  </StrictMode>,
)
