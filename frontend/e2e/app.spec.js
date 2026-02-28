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
