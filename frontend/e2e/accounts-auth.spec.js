import { test, expect } from "@playwright/test";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const backendUrl = `http://127.0.0.1:${backendPort}`;

async function startTicTacToeQuickMatch(page, { nickname = null, preset = "Blitz" } = {}) {
  await page.goto("/tictactoe");
  const nameInput = page.getByPlaceholder("Your name");
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  if (nickname !== null) {
    await nameInput.fill(nickname);
  }
  await page.getByTestId(`quick-pick-${preset.toLowerCase()}`).click();
}

async function waitForOnlineBoard(page, { opponentName }) {
  await expect(page.getByText("Online")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(opponentName, { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "Resign" })).toBeVisible();
}

function recordAuthTraffic(page) {
  const rest = [];
  const websockets = [];
  page.on("request", (request) => {
    if (request.url().startsWith(backendUrl)) {
      rest.push({
        url: request.url(),
        authorization: request.headers().authorization || null,
      });
    }
  });
  page.on("websocket", (websocket) => {
    websockets.push(websocket.url());
  });
  return { rest, websockets };
}

function ticTacToeSocketUrls(traffic) {
  return traffic.websockets.filter((url) => url.includes("/quiz/tictactoe/ws/"));
}

async function getAuthMeThroughApp(page) {
  return page.evaluate(async () => {
    const api = await import("/src/api.js");
    return api.getAuthMe();
  });
}

async function cleanupQuickMatchPage(page) {
  if (page.isClosed()) return;
  const resignButton = page.getByRole("button", { name: "Resign" });
  if (await resignButton.isVisible().catch(() => false)) {
    await resignButton.click();
    const confirm = page.getByText("Resign the match? Your opponent wins.");
    if (await confirm.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Resign" }).click();
    }
    await expect(page.getByText(/WINS!/)).toBeVisible({ timeout: 15000 }).catch(() => {});
    return;
  }

  const cancel = page.getByRole("button", { name: "Cancel search" });
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click();
    await expect(page.getByText("Game Mode")).toBeVisible({ timeout: 10000 }).catch(() => {});
  }
}

test.describe.serial("Accounts auth e2e", () => {
  test.setTimeout(60000);

  test("signs in with mocked Clerk, provisions /auth/me, prefills name, and opens an authed socket", async ({ browser }) => {
    const signedContext = await browser.newContext();
    const anonymousContext = await browser.newContext();
    const signedPage = await signedContext.newPage();
    const anonymousPage = await anonymousContext.newPage();
    const signedTraffic = recordAuthTraffic(signedPage);

    try {
      await signedPage.goto("/");
      await expect(signedPage.getByRole("button", { name: "Sign in" })).toBeVisible();
      await signedPage.getByRole("button", { name: "Sign in" }).click();
      await expect(signedPage.getByTestId("e2e-user-button")).toBeVisible();

      const me = await getAuthMeThroughApp(signedPage);
      expect(me.username).toBe("signed_tester");
      expect(me.email).toBe("signed.tester@example.com");
      expect(me.display_name).toBe("Signed Tester");
      expect(me).not.toHaveProperty("clerk_user_id");
      expect(
        signedTraffic.rest.some(
          (request) =>
            request.url.endsWith("/auth/me") &&
            request.authorization?.startsWith("Bearer ")
        )
      ).toBe(true);

      await signedPage.goto("/tictactoe");
      await expect(signedPage.getByPlaceholder("Your name")).toHaveValue("signed_tester");
      await signedPage.getByTestId("quick-pick-blitz").click();
      await expect(signedPage.getByText("SEARCHING THE POOL")).toBeVisible({
        timeout: 10000,
      });

      await startTicTacToeQuickMatch(anonymousPage, {
        nickname: "Authed Opponent",
      });

      await waitForOnlineBoard(signedPage, { opponentName: "Authed Opponent" });
      await waitForOnlineBoard(anonymousPage, { opponentName: "signed_tester" });

      await expect
        .poll(() => ticTacToeSocketUrls(signedTraffic).some((url) => url.includes("token=")))
        .toBe(true);
    } finally {
      await cleanupQuickMatchPage(signedPage);
      await cleanupQuickMatchPage(anonymousPage);
      await signedContext.close();
      await anonymousContext.close();
    }
  });

  test("keeps anonymous online play free of auth headers and websocket tokens", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const playerA = await contextA.newPage();
    const playerB = await contextB.newPage();
    const trafficA = recordAuthTraffic(playerA);
    const trafficB = recordAuthTraffic(playerB);

    try {
      await startTicTacToeQuickMatch(playerA, {
        nickname: "Anon Alice",
      });
      await expect(playerA.getByText("SEARCHING THE POOL")).toBeVisible({
        timeout: 10000,
      });

      await startTicTacToeQuickMatch(playerB, {
        nickname: "Anon Bob",
      });

      await waitForOnlineBoard(playerA, { opponentName: "Anon Bob" });
      await waitForOnlineBoard(playerB, { opponentName: "Anon Alice" });

      await expect.poll(() => ticTacToeSocketUrls(trafficA).length).toBeGreaterThan(0);
      await expect.poll(() => ticTacToeSocketUrls(trafficB).length).toBeGreaterThan(0);
      expect([...trafficA.rest, ...trafficB.rest].every((request) => !request.authorization)).toBe(true);
      expect(
        [...ticTacToeSocketUrls(trafficA), ...ticTacToeSocketUrls(trafficB)].every(
          (url) => !url.includes("token=")
        )
      ).toBe(true);
    } finally {
      await cleanupQuickMatchPage(playerA);
      await cleanupQuickMatchPage(playerB);
      await contextA.close();
      await contextB.close();
    }
  });
});

// Rectangle intersection: true when the two boxes share any area. Used to assert
// the fixed account controls never cover game UI (issue #293).
function overlaps(a, b) {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

test.describe("Account controls never cover game UI (issue #293)", () => {
  test("clears the TicTacToe solo board indicator at 1366px (signed out)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/tictactoe");

    // Clerk is enabled in e2e and defaults to signed out, so the Sign in / Sign
    // up controls float top-right — the exact overlay the fix must keep off UI.
    const signIn = page.getByRole("button", { name: "Sign in" });
    const signUp = page.getByRole("button", { name: "Sign up" });
    await expect(signIn).toBeVisible();

    // Start a solo board; at >=1024px it shows the "Solo" header indicator that
    // issue #293 reported as covered.
    await page.getByRole("button", { name: "Solo" }).click();
    await page.getByRole("button", { name: "Start Game" }).click();
    const indicator = page.getByTestId("ttt-mode-indicator");
    await expect(indicator).toBeVisible();

    const signInBox = await signIn.boundingBox();
    const signUpBox = await signUp.boundingBox();
    const indicatorBox = await indicator.boundingBox();
    expect(signInBox).not.toBeNull();
    expect(signUpBox).not.toBeNull();
    expect(indicatorBox).not.toBeNull();

    // Neither control rectangle intersects the indicator, and the reserved top
    // band keeps both controls entirely above it.
    expect(overlaps(signInBox, indicatorBox)).toBe(false);
    expect(overlaps(signUpBox, indicatorBox)).toBe(false);
    expect(signInBox.y + signInBox.height).toBeLessThanOrEqual(indicatorBox.y);
    expect(signUpBox.y + signUpBox.height).toBeLessThanOrEqual(indicatorBox.y);
  });

  test("clears the setup card on a narrow viewport (signed out)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tictactoe");

    const signIn = page.getByRole("button", { name: "Sign in" });
    const signUp = page.getByRole("button", { name: "Sign up" });
    await expect(signIn).toBeVisible();

    // On a phone-width viewport the setup content spans nearly the full width, so
    // its top-right would sit under the controls without the reserve.
    const content = page.getByTestId("game-setup-content");
    await expect(content).toBeVisible();

    const signInBox = await signIn.boundingBox();
    const signUpBox = await signUp.boundingBox();
    const contentBox = await content.boundingBox();
    expect(signInBox).not.toBeNull();
    expect(signUpBox).not.toBeNull();
    expect(contentBox).not.toBeNull();

    expect(overlaps(signInBox, contentBox)).toBe(false);
    expect(overlaps(signUpBox, contentBox)).toBe(false);
    expect(signInBox.y + signInBox.height).toBeLessThanOrEqual(contentBox.y);
    expect(signUpBox.y + signUpBox.height).toBeLessThanOrEqual(contentBox.y);
  });
});
