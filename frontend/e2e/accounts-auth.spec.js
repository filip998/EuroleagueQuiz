import { test, expect } from "@playwright/test";

const E2E_USERNAME = process.env.VITE_E2E_CLERK_USERNAME || "e2e_clerk";
const E2E_EMAIL = process.env.VITE_E2E_CLERK_EMAIL || "e2e.clerk@example.test";

function quickMatchPost(page) {
  return page.waitForRequest((request) =>
    request.method() === "POST"
    && request.url().endsWith("/quiz/tictactoe/quick-match")
  );
}

function ticTacToeSocket(page) {
  return page.waitForEvent("websocket", (socket) =>
    socket.url().includes("/quiz/tictactoe/ws/")
  );
}

async function waitForAuthTokenProvider(page) {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { getAuthToken } = await import("/src/authToken.js");
        return Boolean(await getAuthToken());
      })
    )
    .toBe(true);
}

async function signInWithMockClerk(page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("e2e-user-button")).toBeVisible();
  await waitForAuthTokenProvider(page);
}

async function startTicTacToeQuickMatch(page, { nickname, preset = "Blitz" }) {
  await page.goto("/tictactoe");
  await expect(page.getByTestId(`quick-pick-${preset.toLowerCase()}`)).toBeVisible();
  if (nickname !== undefined) {
    await page.getByPlaceholder("Your name").fill(nickname);
  }
  await page.getByTestId(`quick-pick-${preset.toLowerCase()}`).click();
}

async function waitForOnlineBoard(page, { ownName, opponentName }) {
  await expect(page.getByText(new RegExp(`Online.*${escapeRegex(ownName)}.*Player [12]`))).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText(opponentName, { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "Resign" })).toBeVisible();
}

async function cleanupQuickMatchPage(page) {
  if (page.isClosed()) return;
  const resignButton = page.getByRole("button", { name: "Resign" });
  if (await resignButton.isVisible().catch(() => false)) {
    await resignButton.click();
    if (await page.getByText("Resign the match? Your opponent wins.").isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Resign" }).click();
      await expect(page.getByText(/WINS!/)).toBeVisible({ timeout: 15000 }).catch(() => {});
    }
    return;
  }

  const cancelButton = page.getByRole("button", { name: "Cancel search" });
  if (await cancelButton.isVisible().catch(() => false)) {
    await cancelButton.click();
    await expect(page.getByText("Game Mode")).toBeVisible({ timeout: 10000 }).catch(() => {});
  }
}

function expectNoToken(socket) {
  const url = new URL(socket.url());
  expect(url.searchParams.has("token")).toBe(false);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe.serial("Accounts auth e2e", () => {
  test("mock signed-in user reaches /auth/me, prefilled setup, REST auth, and authed realtime", async ({ browser }) => {
    const signedContext = await browser.newContext();
    const anonymousContext = await browser.newContext();
    const signedPage = await signedContext.newPage();
    const anonymousPage = await anonymousContext.newPage();

    try {
      await signInWithMockClerk(signedPage);

      const me = await signedPage.evaluate(async () => {
        const { getAuthMe } = await import("/src/api.js");
        return getAuthMe();
      });
      expect(me.username).toBe(E2E_USERNAME);
      expect(me.email).toBe(E2E_EMAIL);

      await signedPage.goto("/tictactoe");
      await expect(signedPage.getByPlaceholder("Your name")).toHaveValue(E2E_USERNAME);

      const signedQuickMatch = quickMatchPost(signedPage);
      const signedSocket = ticTacToeSocket(signedPage);
      await signedPage.getByTestId("quick-pick-blitz").click();
      const request = await signedQuickMatch;
      expect(request.headers().authorization).toMatch(/^Bearer /);
      const socket = await signedSocket;
      expect(new URL(socket.url()).searchParams.get("token")).toBeTruthy();

      await startTicTacToeQuickMatch(anonymousPage, {
        nickname: "Anon Opponent",
        preset: "Blitz",
      });

      await waitForOnlineBoard(signedPage, {
        ownName: E2E_USERNAME,
        opponentName: "Anon Opponent",
      });
      await waitForOnlineBoard(anonymousPage, {
        ownName: "Anon Opponent",
        opponentName: E2E_USERNAME,
      });
    } finally {
      await cleanupQuickMatchPage(signedPage);
      await cleanupQuickMatchPage(anonymousPage);
      await signedContext.close();
      await anonymousContext.close();
    }
  });

  test("anonymous quick match sends no auth header and opens tokenless realtime sockets", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      const requestA = quickMatchPost(pageA);
      const socketA = ticTacToeSocket(pageA);
      await startTicTacToeQuickMatch(pageA, {
        nickname: "Anon Alice",
        preset: "Long",
      });
      expect((await requestA).headers().authorization).toBeUndefined();
      expectNoToken(await socketA);

      const requestB = quickMatchPost(pageB);
      const socketB = ticTacToeSocket(pageB);
      await startTicTacToeQuickMatch(pageB, {
        nickname: "Anon Bob",
        preset: "Long",
      });
      expect((await requestB).headers().authorization).toBeUndefined();
      expectNoToken(await socketB);

      await waitForOnlineBoard(pageA, {
        ownName: "Anon Alice",
        opponentName: "Anon Bob",
      });
      await waitForOnlineBoard(pageB, {
        ownName: "Anon Bob",
        opponentName: "Anon Alice",
      });
    } finally {
      await cleanupQuickMatchPage(pageA);
      await cleanupQuickMatchPage(pageB);
      await contextA.close();
      await contextB.close();
    }
  });
});
