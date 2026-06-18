import { defineConfig } from "@playwright/test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createSign, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const frontendPort = Number(process.env.E2E_FRONTEND_PORT || 5173);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const configDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(configDir, "../backend");
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === "1" && !process.env.CI;
const explicitDatabaseUrl = process.env.E2E_DATABASE_URL;
const explicitAuthDatabaseUrl = process.env.E2E_AUTH_DATABASE_URL;
const defaultReuseDbPath = reuseExistingServer && !explicitDatabaseUrl
  ? join(backendDir, "data/euroleague.db")
  : null;
const tempDbDir = explicitDatabaseUrl || defaultReuseDbPath
  ? null
  : mkdtempSync(join(tmpdir(), "elq-e2e-"));
const tempDbPath = tempDbDir ? join(tempDbDir, "euroleague.db") : null;
const tempAuthDbDir = explicitAuthDatabaseUrl
  ? null
  : mkdtempSync(join(tmpdir(), "elq-e2e-auth-"));
const tempAuthDbPath = tempAuthDbDir ? join(tempAuthDbDir, "users.db") : null;
if (tempDbPath) {
  copyFileSync(join(backendDir, "data/euroleague.db"), tempDbPath);
  process.once("exit", () => rmSync(tempDbDir, { recursive: true, force: true }));
}
if (tempAuthDbDir) {
  process.once("exit", () => rmSync(tempAuthDbDir, { recursive: true, force: true }));
}
const databaseUrl = explicitDatabaseUrl
  || (defaultReuseDbPath ? `sqlite:///${defaultReuseDbPath}` : `sqlite:///${tempDbPath}`);
const authDatabaseUrl = explicitAuthDatabaseUrl || `sqlite:///${tempAuthDbPath}`;
if (!explicitDatabaseUrl && (tempDbPath || defaultReuseDbPath)) {
  process.env.E2E_DATABASE_URL = databaseUrl;
}
if (!explicitAuthDatabaseUrl && tempAuthDbPath) {
  process.env.E2E_AUTH_DATABASE_URL = authDatabaseUrl;
}
const databasePath = tempDbPath || defaultReuseDbPath || sqlitePathFromUrl(process.env.E2E_DATABASE_URL);
if (databasePath) {
  process.env.E2E_DATABASE_PATH = databasePath;
}
const e2eClerk = createE2eClerkFixture();

function sqlitePathFromUrl(url) {
  if (!url?.startsWith("sqlite:///")) return null;
  return decodeURIComponent(url.slice("sqlite:///".length));
}

function createE2eClerkFixture() {
  const issuer = "https://e2e.clerk.test";
  const kid = "e2e-clerk-key";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid,
    use: "sig",
    alg: "RS256",
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    sub: "user_e2e_clerk",
    exp: now + 24 * 60 * 60,
    iat: now,
    username: "signed_tester",
    email: "signed.tester@example.com",
    name: "Signed Tester",
    image_url: "https://example.com/e2e-avatar.png",
  };
  return {
    issuer,
    jwksJson: JSON.stringify({ keys: [jwk] }),
    token: signJwt({ kid }, payload, privateKey),
    username: payload.username,
    fullName: payload.name,
    firstName: "Signed",
  };
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT", ...header });
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

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
      command: `cd "${backendDir}" && .venv/bin/alembic -c alembic_auth.ini upgrade head && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      port: backendPort,
      reuseExistingServer,
      timeout: 30000,
      env: {
        ...process.env,
        ELQ_DATABASE_URL: databaseUrl,
        ELQ_AUTH_DATABASE_URL: authDatabaseUrl,
        ELQ_CORS_ORIGINS: frontendUrl,
        ELQ_CLERK_ISSUER: e2eClerk.issuer,
        ELQ_CLERK_JWKS_URL: `${frontendUrl}/.well-known/e2e-clerk-jwks.json`,
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      port: frontendPort,
      reuseExistingServer,
      timeout: 15000,
      env: {
        ...process.env,
        VITE_API_URL: backendUrl,
        VITE_CLERK_PUBLISHABLE_KEY: "pk_test_e2e",
        VITE_E2E_MOCK_CLERK: "1",
        VITE_E2E_CLERK_TOKEN: e2eClerk.token,
        VITE_E2E_CLERK_JWKS_JSON: e2eClerk.jwksJson,
        VITE_E2E_CLERK_USERNAME: e2eClerk.username,
        VITE_E2E_CLERK_FULL_NAME: e2eClerk.fullName,
        VITE_E2E_CLERK_FIRST_NAME: e2eClerk.firstName,
      },
    },
  ],
});
