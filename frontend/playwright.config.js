import { defineConfig } from "@playwright/test";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const frontendPort = Number(process.env.E2E_FRONTEND_PORT || 5173);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: frontendUrl,
    headless: true,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: [
    {
      command: `cd ../backend && ELQ_CORS_ORIGINS=${frontendUrl} .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      port: backendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: `VITE_API_URL=${backendUrl} npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      port: frontendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 15000,
    },
  ],
});
