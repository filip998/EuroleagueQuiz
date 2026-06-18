import { test, expect, devices } from "@playwright/test";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const backendUrl = `http://127.0.0.1:${backendPort}`;

async function startTicTacToeQuickMatch(page, { nickname, preset = "Standard" }) {
  await page.goto("/");
  await page.getByText("TICTACTOE").click();
  // /tictactoe lands directly on Online -> Quick Match. Set the optional name,
  // then a single tap on the pool card enters the pool (no Find Match button).
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByTestId(`quick-pick-${preset.toLowerCase()}`).click();
}

async function waitForOnlineBoard(page, { ownName, opponentName }) {
  await expect(page.getByText(new RegExp(`Online.*${ownName}.*Player [12]`))).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText(opponentName, { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "Resign" })).toBeVisible();
}

function gameIdFromUrl(page) {
  const match = page.url().match(/\/tictactoe\/(\d+)/);
  if (!match) throw new Error(`Could not read TicTacToe game id from ${page.url()}`);
  return Number(match[1]);
}

async function apiJson(path, options = {}) {
  const { headers, ...requestOptions } = options;
  const response = await fetch(`${backendUrl}${path}`, {
    ...requestOptions,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`API ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function currentTurnPage(gameId, playerA, playerB) {
  const state = await apiJson(`/quiz/tictactoe/games/${gameId}`);
  return state.current_player === 1 ? playerA : playerB;
}

async function playVisibleMove(gameId, playerA, playerB) {
  const page = await currentTurnPage(gameId, playerA, playerB);
  await page.getByRole("button", { name: "+" }).first().click();
  await page.getByPlaceholder("Type player name...").fill("a");
  const firstResult = page.locator("ul button").first();
  await expect(firstResult).toBeVisible({ timeout: 10000 });
  await firstResult.click();
  await expect(page.getByText(/Correct|Incorrect|Turn switches/)).toBeVisible({
    timeout: 15000,
  });
}

async function cleanupQuickMatchPage(page) {
  if (page.isClosed()) return;
  const url = page.url();
  if (!url.includes("/tictactoe/")) return;
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

  const cancelLink = page.getByRole("button", { name: "Cancel search" });
  if (await cancelLink.isVisible().catch(() => false)) {
    await cancelLink.click();
    await expect(page.getByText("Game Mode")).toBeVisible({
      timeout: 10000,
    }).catch(() => {});
  }
}

test.describe("Home Page", () => {
  test("displays all three game mode cards", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("TICTACTOE")).toBeVisible();
    await expect(page.getByText("GUESS THE LIST")).toBeVisible();
    await expect(page.getByText("HIGHER OR LOWER")).toBeVisible();
    await expect(page.getByText("Choose your game")).toBeVisible();
  });

  test("navigates to TicTacToe setup and lands on Quick Match", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    await expect(page.getByText("Game Mode")).toBeVisible();
    // Default landing is Online -> Quick Match (pool grid first).
    await expect(page.getByTestId("quick-pick-standard")).toBeVisible();
    // Solo is one tap away via the mode selector.
    await page.getByText("Solo").click();
    await expect(page.getByText("Start Game")).toBeVisible();
  });

  test("home TicTacToe Quick Match CTA lands on the pool grid", async ({ page }) => {
    await page.goto("/");
    // Two home cards now expose a Quick Match CTA (TicTacToe + Photo Quiz); scope
    // by href so the locator resolves to a single element.
    await page.locator('[data-testid="home-quick-match-cta"][href="/tictactoe"]').click();

    await expect(page).toHaveURL(/\/tictactoe$/);
    await expect(page.getByText("Pick a pool")).toBeVisible();
    await expect(page.getByTestId("quick-pick-standard")).toBeVisible();
  });

  test("shows the Quick Match pool grid by default under Online", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    // Online -> Quick Match is the default: a one-click pool grid, not the old
    // Create/Join toggle or a separate Find Match button.
    await expect(page.getByText("Pick a pool")).toBeVisible();
    await expect(page.getByTestId("quick-pick-blitz")).toBeVisible();
    await expect(page.getByTestId("quick-pick-standard")).toBeVisible();
    await expect(page.getByTestId("quick-pick-long")).toBeVisible();
    await expect(page.getByRole("button", { name: "Find Match" })).toHaveCount(0);
  });

  test("reveals the join-code form via Online then Play a Friend then Join", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    // Online is already the default mode; switch the sub-mode to Play a Friend.
    await page.getByRole("button", { name: "Play a Friend" }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();

    await expect(page.getByPlaceholder("ABC123")).toBeVisible();
    await expect(page.getByRole("button", { name: "Join Game" })).toBeVisible();
  });

  test("navigates to Guess the List setup", async ({ page }) => {
    await page.goto("/");
    await page.getByText("GUESS THE LIST").click();

    await expect(page.getByText("Game Mode")).toBeVisible();
    await expect(page.getByText("Start Game")).toBeVisible();
  });

  test("redirects legacy roster quick links to Guess the List Race Quick Match", async ({ page }) => {
    await page.goto("/roster?quick=1");

    await expect(page).toHaveURL(/\/list\?quick=1$/);
    await expect(page.getByText("Game Mode")).toBeVisible();
    await expect(page.getByRole("button", { name: "Race" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByText("Pick a pool")).toBeVisible();
    await expect(page.getByTestId("quick-pick-modern-standard")).toBeVisible();
  });

  test("navigates to Higher or Lower setup", async ({ page }) => {
    await page.goto("/");
    await page.getByText("HIGHER OR LOWER").click();

    await expect(page.getByText("Difficulty")).toBeVisible();
    await expect(page.getByText("Start Game")).toBeVisible();
  });
});

test.describe("TicTacToe Flow", () => {
  test("can create a solo game and see the board", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    // Quick Match is now the default landing; Solo is one tap away.
    await page.getByText("Solo").click();
    await page.getByText("Start Game").click();

    // Should see the game board with team names in headers
    await expect(page.locator("table, [class*='grid']").first()).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe.serial("TicTacToe Quick Match Flow", () => {
  test("pairs two clients on Standard, plays visible moves, and resigns", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const playerA = await contextA.newPage();
    const playerB = await contextB.newPage();

    try {
      await startTicTacToeQuickMatch(playerA, {
        nickname: "Quick Alice",
        preset: "Standard",
      });
      await expect(playerA.getByText("SEARCHING THE POOL")).toBeVisible({
        timeout: 10000,
      });

      await startTicTacToeQuickMatch(playerB, {
        nickname: "Quick Bob",
        preset: "Standard",
      });

      await waitForOnlineBoard(playerA, {
        ownName: "Quick Alice",
        opponentName: "Quick Bob",
      });
      await waitForOnlineBoard(playerB, {
        ownName: "Quick Bob",
        opponentName: "Quick Alice",
      });

      const gameId = gameIdFromUrl(playerA);
      expect(gameIdFromUrl(playerB)).toBe(gameId);

      await playVisibleMove(gameId, playerA, playerB);
      await playVisibleMove(gameId, playerA, playerB);

      await playerA.getByRole("button", { name: "Resign" }).click();
      await playerA.getByText("Resign the match? Your opponent wins.").waitFor();
      await playerA.getByRole("button", { name: "Resign" }).click();

      await expect(playerA.getByText("You resigned.")).toBeVisible({ timeout: 15000 });
      await expect(playerA.getByText(/Quick Bob WINS!/)).toBeVisible({ timeout: 15000 });
      await expect(playerB.getByText(/Quick Bob WINS!/)).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanupQuickMatchPage(playerA);
      await cleanupQuickMatchPage(playerB);
      await contextA.close();
      await contextB.close();
    }
  });

  test("can cancel a Long quick-match search", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await startTicTacToeQuickMatch(page, {
        nickname: "Quick Cancel",
        preset: "Long",
      });

      await expect(page.getByText("SEARCHING THE POOL")).toBeVisible({ timeout: 10000 });
      await page.getByRole("button", { name: "Cancel search" }).click();
      await expect(page.getByText("Game Mode")).toBeVisible({
        timeout: 10000,
      });
      // Cancelling returns to the default Quick Match pool grid (not a Start
      // Game form).
      await expect(page.getByTestId("quick-pick-standard")).toBeVisible();
    } finally {
      await cleanupQuickMatchPage(page);
      await context.close();
    }
  });

  test("touch: a pool card shows an at-rest tap affordance and starts searching in one tap", async ({
    browser,
  }) => {
    // Emulate a real phone (hasTouch, no hover/focus) so we exercise the touch
    // path the desktop hover reveal never covers. Uses the Long preset, which no
    // other spec searches, so the one-tap → searching signal can't be skipped by
    // an accidental cross-worker pairing.
    const context = await browser.newContext({ ...devices["Pixel 5"] });
    const page = await context.newPage();

    try {
      // /tictactoe lands directly on Online -> Quick Match (the pool grid).
      await page.goto("/tictactoe");

      // At rest on touch (no hover/focus ever fires): the persistent tap
      // affordance AND the live presence count are both visible on the card.
      const affordance = page.getByTestId("affordance-long");
      const presence = page.getByTestId("presence-long");
      await expect(affordance).toBeVisible();
      await expect(affordance).toHaveCSS("opacity", "1");
      await expect(presence).toBeVisible();
      await expect(presence).toHaveCSS("opacity", "1");

      // A single tap on the card goes straight to matchmaking — there is no
      // "Find Match" button and no double-tap trap.
      await page.getByTestId("quick-pick-long").tap();
      await expect(page.getByText("SEARCHING THE POOL")).toBeVisible({
        timeout: 10000,
      });

      // Clean up the public waiting game this tap created.
      await page.getByRole("button", { name: "Cancel search" }).click();
      await expect(page.getByTestId("quick-pick-standard")).toBeVisible({
        timeout: 10000,
      });
    } finally {
      await context.close();
    }
  });
});

test.describe("Higher or Lower Flow", () => {
  test("can create a game and see player pair", async ({ page }) => {
    await page.goto("/");
    await page.getByText("HIGHER OR LOWER").click();

    // Fill in the player name (now standardized across setups)
    await page.getByPlaceholder("Your name").fill("E2ETest");

    // Start the game
    await page.getByText("Start Game").click();

    // Should see "Who has more" and the category + two player cards
    await expect(page.getByText("Who has more")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("HIGHER OR LOWER")).toBeVisible();
  });
});
