import { test, expect } from "@playwright/test";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const backendUrl = `http://127.0.0.1:${backendPort}`;

async function startTicTacToeQuickMatch(page, { nickname, preset = "Standard" }) {
  await page.goto("/");
  await page.getByText("TICTACTOE").click();
  await page.getByRole("button", { name: "Online" }).click();
  await page.getByRole("button", { name: preset }).click();
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByRole("button", { name: "Find Match" }).click();
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

async function autocompleteAnyPlayerForCell(cell) {
  const params = new URLSearchParams({ q: "", limit: "25" });
  if (cell.row_team_code) params.set("team_code_1", cell.row_team_code);
  if (cell.col_team_code) {
    if (cell.row_team_code) params.set("team_code_2", cell.col_team_code);
    else params.set("team_code_1", cell.col_team_code);
  }
  const data = await apiJson(`/quiz/tictactoe/players/autocomplete?${params}`);
  return data.players?.[0]?.player_id ?? null;
}

async function submitApiMove(gameId) {
  const state = await apiJson(`/quiz/tictactoe/games/${gameId}`);
  const openCells = state.round.cells.filter((cell) => !cell.claimed_by_player);

  for (const cell of openCells) {
    const playerId = await autocompleteAnyPlayerForCell(cell);
    if (!playerId) continue;

    const move = await apiJson(
      `/quiz/tictactoe/games/${gameId}/moves?player=${state.current_player}`,
      {
        method: "POST",
        body: JSON.stringify({
          row_index: cell.row_index,
          col_index: cell.col_index,
          player_id: playerId,
        }),
      },
    );
    return move.payload?.result || move.payload?.game?.status || "move";
  }

  throw new Error(`No playable TicTacToe cell found for game ${gameId}`);
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
    await expect(page.getByText("ROSTER GUESS")).toBeVisible();
    await expect(page.getByText("HIGHER OR LOWER")).toBeVisible();
    await expect(page.getByText("Choose your game")).toBeVisible();
  });

  test("navigates to TicTacToe setup", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    await expect(page.getByText("Game Mode")).toBeVisible();
    await expect(page.getByText("Solo")).toBeVisible();
    await expect(page.getByText("Start Game")).toBeVisible();
  });

  test("shows the Quick Match preset picker by default under Online", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    await page.getByRole("button", { name: "Online" }).click();

    // Online now defaults to the Quick Match sub-mode: a preset picker + the
    // Find Match action, rather than the old direct Create/Join toggle.
    await expect(page.getByText("Pick a pool")).toBeVisible();
    await expect(page.getByRole("button", { name: "Blitz" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Standard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Long" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Find Match" })).toBeVisible();
  });

  test("reveals the join-code form via Online then Play a Friend then Join", async ({ page }) => {
    await page.goto("/");
    await page.getByText("TICTACTOE").click();

    await page.getByRole("button", { name: "Online" }).click();
    await page.getByRole("button", { name: "Play a Friend" }).click();
    await page.getByRole("button", { name: "Join", exact: true }).click();

    await expect(page.getByPlaceholder("ABC123")).toBeVisible();
    await expect(page.getByRole("button", { name: "Join Game" })).toBeVisible();
  });

  test("navigates to Roster Guess setup", async ({ page }) => {
    await page.goto("/");
    await page.getByText("ROSTER GUESS").click();

    await expect(page.getByText("Game Mode")).toBeVisible();
    await expect(page.getByText("Start Game")).toBeVisible();
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

    // Solo mode is default, just click Start Game
    await page.getByText("Start Game").click();

    // Should see the game board with team names in headers
    await expect(page.locator("table, [class*='grid']").first()).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe.serial("TicTacToe Quick Match Flow", () => {
  test("pairs two clients on Standard, plays API-backed moves, and resigns", async ({ browser }) => {
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

      await submitApiMove(gameId);
      await expect(playerA.getByText(/Correct|Incorrect|Turn switches/)).toBeVisible({
        timeout: 15000,
      });

      await submitApiMove(gameId);

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
      await expect(page.getByRole("button", { name: "Start Game" })).toBeVisible();
    } finally {
      await cleanupQuickMatchPage(page);
      await context.close();
    }
  });
});

test.describe("Higher or Lower Flow", () => {
  test("can create a game and see player pair", async ({ page }) => {
    await page.goto("/");
    await page.getByText("HIGHER OR LOWER").click();

    // Fill in required nickname
    await page.getByPlaceholder("Your nickname").fill("E2ETest");

    // Start the game
    await page.getByText("Start Game").click();

    // Should see "Who has more" and the category + two player cards
    await expect(page.getByText("Who has more")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("HIGHER OR LOWER")).toBeVisible();
  });
});
