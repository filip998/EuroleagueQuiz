import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { AuthProvider, AuthMenu } from './auth.jsx'
import { UI_VARIANT } from './uiVariant.js'

// Mirror the UI variant onto the root element so the refined token overrides in
// index.css (`html[data-ui="refined"]`) cascade app-wide. Set before render so
// the first paint already uses the right tokens.
document.documentElement.dataset.ui = UI_VARIANT

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
