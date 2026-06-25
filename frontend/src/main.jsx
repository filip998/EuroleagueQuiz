import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { AuthProvider, AuthMenu, authEnabled } from './auth.jsx'
import { UI_VARIANT } from './uiVariant.js'

// Mirror the UI variant onto the root element so the refined token overrides in
// index.css (`html[data-ui="refined"]`) cascade app-wide. Set before render so
// the first paint already uses the right tokens.
document.documentElement.dataset.ui = UI_VARIANT

// Issue #293: when Clerk is configured the fixed account controls (`AuthMenu`)
// render top-right, so reserve a top safe-area app-wide (see `.elq-auth-safe-top`
// in index.css) to keep them off game UI. Set before first paint to avoid a
// layout shift; remove it when auth is off so anonymous builds are untouched.
if (authEnabled) {
  document.documentElement.dataset.authChrome = 'reserve'
} else {
  delete document.documentElement.dataset.authChrome
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AuthMenu />
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
