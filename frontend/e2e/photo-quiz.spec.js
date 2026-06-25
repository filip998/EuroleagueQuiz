import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const dbPath = process.env.E2E_DATABASE_PATH;
const pythonBin = process.env.PYTHON || "python3";

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

async function startPhotoSolo(page) {
  await page.goto("/photo");
  await page.getByRole("button", { name: "Start Game" }).click();
  await expect(page.getByText("PHOTO QUIZ")).toBeVisible({ timeout: 10000 });
  await expect(photoClue(page)).toBeVisible({ timeout: 10000 });
}

async function startPhotoFriendHost(page, { nickname, targetWins = "3" }) {
  await page.goto("/photo");
  await page.getByRole("button", { name: "Online" }).click();
  await page.getByRole("button", { name: "Play a Friend" }).click();
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.locator("select").first().selectOption(targetWins);
  await page.getByRole("button", { name: "Create Online Game" }).click();
  await expect(page.getByText("WAITING FOR OPPONENT")).toBeVisible({ timeout: 10000 });
  return joinCodeFromWaitingLobby(page);
}

async function joinPhotoFriend(page, { nickname, joinCode }) {
  await page.goto("/photo");
  await page.getByRole("button", { name: "Online" }).click();
  await page.getByRole("button", { name: "Play a Friend" }).click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByPlaceholder("ABC123").fill(joinCode);
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByRole("button", { name: "Join Game" }).click();
}

async function startPhotoQuickMatch(page, { nickname, preset = "quick" }) {
  await page.goto("/photo");
  await page.getByRole("button", { name: "Online" }).click();
  // Online defaults to Quick Match. Set the optional name, then a single tap on
  // the pool card enters the pool (no Find Match button).
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByTestId(`quick-pick-${preset}`).click();
}

async function waitForOnlineRace(page, { ownName, opponentName }) {
  await expect(page.getByText("ONLINE RACE")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(`You are ${ownName}`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(opponentName, { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(photoClue(page)).toBeVisible({ timeout: 10000 });
}

async function waitForActivePhotoState(gameId, predicate = () => true) {
  const deadline = Date.now() + 15000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await apiJson(`/quiz/photo/games/${gameId}`);
    if (lastState.status === "active" && lastState.current_round && predicate(lastState)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Photo game ${gameId} did not reach expected active state: ${JSON.stringify(lastState)}`);
}

async function waitForFinishedPhotoState(gameId) {
  const deadline = Date.now() + 15000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await apiJson(`/quiz/photo/games/${gameId}`);
    if (lastState.status === "finished") return lastState;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Photo game ${gameId} did not finish: ${JSON.stringify(lastState)}`);
}

async function playCorrectPhotoGuess(page, gameId, { expectedRound = null } = {}) {
  const state = await waitForActivePhotoState(
    gameId,
    (game) => expectedRound == null || game.round_number === expectedRound
  );
  const answer = answerForPhotoRound(gameId, state.current_round.round_number);
  await expect(page.getByPlaceholder("Type a player name...")).toBeEnabled({ timeout: 7000 });
  await guessPhotoPlayer(page, answer.name);
  return { state, answer };
}

async function guessPhotoPlayer(page, playerName) {
  const input = page.getByPlaceholder("Type a player name...");
  await input.fill(playerName);
  const option = page.getByRole("button", { name: playerName, exact: true });
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
}

async function knownPhotoPlayerName() {
  const result = await apiJson("/quiz/photo/players/autocomplete?q=teodosic&limit=1");
  const player = result.players?.[0];
  if (!player?.name) throw new Error("Expected seeded Photo Quiz player for solo autocomplete");
  return player.name;
}

function answerForPhotoRound(gameId, roundNumber) {
  if (!dbPath) {
    throw new Error("E2E_DATABASE_PATH is required for deterministic Photo Quiz e2e answers");
  }
  const script = `
import json
import sqlite3
import sys

db_path, game_id, round_number = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
try:
    row = connection.execute(
        """
        SELECT p.id, p.first_name, p.last_name
        FROM photo_quiz_rounds AS r
        JOIN players AS p ON p.id = r.answer_player_id
        WHERE r.game_id = ? AND r.round_number = ?
        """,
        (game_id, round_number),
    ).fetchone()
finally:
    connection.close()

if row is None:
    raise SystemExit(f"No Photo Quiz answer for game {game_id} round {round_number}")

print(json.dumps({
    "id": row["id"],
    "name": f"{row['first_name']} {row['last_name']}",
}))
`;
  return JSON.parse(
    execFileSync(
      pythonBin,
      ["-c", script, dbPath, String(gameId), String(roundNumber)],
      { encoding: "utf8" }
    )
  );
}

function gameIdFromUrl(page) {
  const match = page.url().match(/\/photo\/(\d+)/);
  if (!match) throw new Error(`Could not read Photo Quiz game id from ${page.url()}`);
  return Number(match[1]);
}

async function joinCodeFromWaitingLobby(page) {
  const bodyText = await page.locator("body").innerText();
  const match = bodyText.match(/\b[A-Z0-9]{6}\b/);
  if (!match) throw new Error(`Could not read Photo Quiz join code from: ${bodyText}`);
  return match[0];
}

function photoClue(page) {
  return page.locator('[data-testid="photo-clue-image"], [data-testid="photo-clue-fallback"]');
}

async function cleanupQuickMatchPage(page) {
  if (page.isClosed()) return;
  const cancel = page.getByRole("button", { name: "Cancel search" });
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click();
    await expect(page.getByText("PHOTO QUIZ")).toBeVisible({ timeout: 10000 }).catch(() => {});
  }
}

test.describe.serial("Photo Quiz Flow", () => {
  test.setTimeout(60000);

  test("plays a solo round through guess feedback and reveal", async ({ page }) => {
    await startPhotoSolo(page);

    const playerName = await knownPhotoPlayerName();
    await guessPhotoPlayer(page, playerName);
    await expect(page.getByTestId("photo-feedback-message")).toBeVisible({ timeout: 10000 });

    const nextPhoto = page.getByRole("button", { name: "Next photo" });
    if (!(await nextPhoto.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Reveal answer" }).click();
      await expect(nextPhoto).toBeVisible({ timeout: 10000 });
    }
  });

  test("lets two friend clients race through reveal countdowns and finish", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const playerA = await contextA.newPage();
    const playerB = await contextB.newPage();

    try {
      const joinCode = await startPhotoFriendHost(playerA, {
        nickname: "Photo Alice",
        targetWins: "3",
      });

      await joinPhotoFriend(playerB, {
        nickname: "Photo Bob",
        joinCode,
      });

      await waitForOnlineRace(playerA, {
        ownName: "Photo Alice",
        opponentName: "Photo Bob",
      });
      await waitForOnlineRace(playerB, {
        ownName: "Photo Bob",
        opponentName: "Photo Alice",
      });

      const gameId = gameIdFromUrl(playerA);
      expect(gameIdFromUrl(playerB)).toBe(gameId);

      const first = await playCorrectPhotoGuess(playerA, gameId, { expectedRound: 1 });
      await expect(playerA.getByText("Correct!")).toBeVisible({ timeout: 10000 });
      await expect(playerA.getByText(`Answer: ${first.answer.name}`)).toBeVisible({ timeout: 10000 });
      await expect(playerA.getByText(/Next round unlocks in|Next round unlocked/)).toBeVisible({
        timeout: 10000,
      });

      await playCorrectPhotoGuess(playerA, gameId, { expectedRound: 2 });
      await playCorrectPhotoGuess(playerA, gameId, { expectedRound: 3 });

      await waitForFinishedPhotoState(gameId);
      await expect(playerA.getByText("Photo Alice WINS!")).toBeVisible({ timeout: 15000 });
      await expect(playerB.getByText("Photo Alice WINS!")).toBeVisible({ timeout: 15000 });
      await expect(playerA.getByText("3 - 0")).toBeVisible();
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("pairs two quick-match clients on First to 1 and finishes a public race", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const playerA = await contextA.newPage();
    const playerB = await contextB.newPage();

    try {
      await startPhotoQuickMatch(playerA, {
        nickname: "Quick Photo Alice",
        preset: "quick",
      });
      await expect(playerA.getByText("SEARCHING THE POOL")).toBeVisible({ timeout: 10000 });

      await startPhotoQuickMatch(playerB, {
        nickname: "Quick Photo Bob",
        preset: "quick",
      });

      await waitForOnlineRace(playerA, {
        ownName: "Quick Photo Alice",
        opponentName: "Quick Photo Bob",
      });
      await waitForOnlineRace(playerB, {
        ownName: "Quick Photo Bob",
        opponentName: "Quick Photo Alice",
      });
      await expect(playerA.getByRole("button", { name: "Nobody knows" })).toBeVisible();
      await expect(playerB.getByRole("button", { name: "Nobody knows" })).toBeVisible();
      await playerA.getByRole("button", { name: "Nobody knows" }).click();
      await expect(playerB.getByRole("button", { name: "Accept no answer" })).toBeVisible({
        timeout: 10000,
      });
      await expect(
        playerB.getByText("accept to reveal the answer and skip this round", { exact: false })
      ).toBeVisible();
      await playerB.getByRole("button", { name: "Decline" }).click();
      await expect(playerA.getByRole("button", { name: "Nobody knows" })).toBeVisible({
        timeout: 10000,
      });

      const gameId = gameIdFromUrl(playerA);
      expect(gameIdFromUrl(playerB)).toBe(gameId);

      await playCorrectPhotoGuess(playerA, gameId, { expectedRound: 1 });
      await waitForFinishedPhotoState(gameId);

      await expect(playerA.getByText("Quick Photo Alice WINS!")).toBeVisible({ timeout: 15000 });
      await expect(playerB.getByText("Quick Photo Alice WINS!")).toBeVisible({ timeout: 15000 });
      await expect(playerA.getByText("1 - 0")).toBeVisible();
    } finally {
      await cleanupQuickMatchPage(playerA);
      await cleanupQuickMatchPage(playerB);
      await contextA.close();
      await contextB.close();
    }
  });
});
