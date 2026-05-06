import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// PR-1.5 wraps <App /> in <ErrorBoundary /> so render-time throws don't
// blank the entire screen and force a hard reload. The boundary catches
// the throw, surfaces a friendly fallback, and lets the user reload
// from a state where their work on the server is still intact.

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
