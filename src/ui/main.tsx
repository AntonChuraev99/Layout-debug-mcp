import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { I18nProvider } from './i18n.ts'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')

createRoot(el, {
  // A render crash unmounts the whole tree to white; the boot panel in index.html says
  // what happened instead. `true`: React has already emptied #root by now.
  onUncaughtError: (error) => {
    console.error('[layout-debug] the window crashed', error)
    window.__ldBootFailed?.(error instanceof Error ? error.message : String(error), true)
  },
}).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
