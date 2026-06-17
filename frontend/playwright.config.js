import { defineConfig } from "@playwright/test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const frontendPort = Number(process.env.E2E_FRONTEND_PORT || 5173);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const configDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(configDir, "../backend");
const tempDbDir = process.env.E2E_DATABASE_URL
  ? null
  : mkdtempSync(join(tmpdir(), "elq-e2e-"));
const tempDbPath = tempDbDir ? join(tempDbDir, "euroleague.db") : null;
if (tempDbPath) {
  copyFileSync(join(backendDir, "data/euroleague.db"), tempDbPath);
  process.once("exit", () => rmSync(tempDbDir, { recursive: true, force: true }));
}
const databaseUrl = process.env.E2E_DATABASE_URL || `sqlite:///${tempDbPath}`;
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === "1" && !process.env.CI;

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
      command: `cd "${backendDir}" && ELQ_DATABASE_URL="${databaseUrl}" ELQ_CORS_ORIGINS=${frontendUrl} .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      port: backendPort,
      reuseExistingServer,
      timeout: 30000,
    },
    {
      command: `VITE_API_URL=${backendUrl} npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      port: frontendPort,
      reuseExistingServer,
      timeout: 15000,
    },
  ],
});
