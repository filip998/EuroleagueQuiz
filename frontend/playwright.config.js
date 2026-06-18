import { defineConfig } from "@playwright/test";
import { createSign, generateKeyPairSync } from "node:crypto";
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
if (tempDbPath) {
  copyFileSync(join(backendDir, "data/euroleague.db"), tempDbPath);
  process.once("exit", () => rmSync(tempDbDir, { recursive: true, force: true }));
}
const databaseUrl = explicitDatabaseUrl
  || (defaultReuseDbPath ? `sqlite:///${defaultReuseDbPath}` : `sqlite:///${tempDbPath}`);
if (!explicitDatabaseUrl && (tempDbPath || defaultReuseDbPath)) {
  process.env.E2E_DATABASE_URL = databaseUrl;
}
const databasePath = tempDbPath || defaultReuseDbPath || sqlitePathFromUrl(process.env.E2E_DATABASE_URL);
if (databasePath) {
  process.env.E2E_DATABASE_PATH = databasePath;
}
const tempAuthDbDir = explicitAuthDatabaseUrl
  ? null
  : mkdtempSync(join(tmpdir(), "elq-e2e-auth-"));
const tempAuthDbPath = tempAuthDbDir ? join(tempAuthDbDir, "users.db") : null;
if (tempAuthDbDir) {
  process.once("exit", () => rmSync(tempAuthDbDir, { recursive: true, force: true }));
}
const authDatabaseUrl = explicitAuthDatabaseUrl || `sqlite:///${tempAuthDbPath}`;
process.env.E2E_AUTH_DATABASE_URL = authDatabaseUrl;
const e2eClerk = createE2EClerkFixture();
process.env.VITE_API_URL = backendUrl;
process.env.VITE_CLERK_PUBLISHABLE_KEY = "pk_test_e2e";
process.env.VITE_E2E_MOCK_CLERK = "1";
process.env.VITE_E2E_CLERK_TOKEN = e2eClerk.token;
process.env.VITE_E2E_CLERK_JWKS_JSON = JSON.stringify(e2eClerk.jwks);
process.env.VITE_E2E_CLERK_USER_ID = e2eClerk.userId;
process.env.VITE_E2E_CLERK_USERNAME = e2eClerk.username;
process.env.VITE_E2E_CLERK_EMAIL = e2eClerk.email;

function sqlitePathFromUrl(url) {
  if (!url?.startsWith("sqlite:///")) return null;
  return decodeURIComponent(url.slice("sqlite:///".length));
}

function createE2EClerkFixture() {
  const kid = "e2e-clerk-key";
  const issuer = "https://e2e-clerk.example.test";
  const userId = "user_e2e_clerk";
  const username = "e2e_clerk";
  const email = "e2e.clerk@example.test";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { alg: "RS256", typ: "JWT", kid },
    {
      iss: issuer,
      sub: userId,
      iat: now,
      nbf: now - 5,
      exp: now + 60 * 60,
      username,
      email,
      name: "E2E Clerk",
      image_url: "https://example.test/e2e-clerk.png",
    },
    privateKey
  );
  return {
    issuer,
    jwksUrl: `${frontendUrl}/.well-known/e2e-clerk-jwks.json`,
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
    token,
    userId,
    username,
    email,
  };
}

function signJwt(header, payload, privateKey) {
  const signingInput = [
    base64urlJson(header),
    base64urlJson(payload),
  ].join(".");
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function base64urlJson(value) {
  return base64url(Buffer.from(JSON.stringify(value)));
}

function base64url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  retries: 1,
  workers: 1,
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
      command: `cd "${backendDir}" && export ELQ_DATABASE_URL="${databaseUrl}" ELQ_AUTH_DATABASE_URL="${authDatabaseUrl}" ELQ_CORS_ORIGINS="${frontendUrl}" ELQ_CLERK_ISSUER="${e2eClerk.issuer}" ELQ_CLERK_JWKS_URL="${e2eClerk.jwksUrl}" && .venv/bin/alembic -c alembic_auth.ini upgrade head && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      port: backendPort,
      reuseExistingServer,
      timeout: 60000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      port: frontendPort,
      reuseExistingServer,
      timeout: 15000,
    },
  ],
});
