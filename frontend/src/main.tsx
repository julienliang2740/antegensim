import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
if (location.search.includes('harness=1')) void import('./dev/mountHarness.tsx').then((m) => m.mountHarness()) // inspect harness (src/dev); keep this guard
