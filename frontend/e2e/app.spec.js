import { test, expect } from "@playwright/test";

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
