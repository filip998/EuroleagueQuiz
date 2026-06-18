import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const e2eMockClerk = process.env.VITE_E2E_MOCK_CLERK === '1'
const clerkMockPath = fileURLToPath(new URL('./e2e/mockClerk.jsx', import.meta.url))

function e2eClerkJwksPlugin() {
  return {
    name: 'e2e-clerk-jwks',
    configureServer(server) {
      server.middlewares.use('/.well-known/e2e-clerk-jwks.json', (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(process.env.VITE_E2E_CLERK_JWKS_JSON || '{"keys":[]}')
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), ...(e2eMockClerk ? [e2eClerkJwksPlugin()] : [])],
  resolve: e2eMockClerk
    ? {
        alias: {
          '@clerk/clerk-react': clerkMockPath,
        },
      }
    : undefined,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
