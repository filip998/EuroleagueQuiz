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

// The board only learns the turn-switch and terminal `result` (correct /
// incorrect / resigned / opponent_left) over the websocket; the polling
// fallback delivers `result: null`. So before exchanging guesses, resigning, or
// disconnecting we wait until the page's Guess the List websocket has received
// its first frame (the server pushes initial state on connect). The per-socket
// `framereceived` listener is attached synchronously inside the `websocket`
// handler so the initial frame can never be missed.
function trackGuessSocket(page) {
  let resolveFrame;
  const firstFrame = new Promise((resolve) => {
    resolveFrame = resolve;
  });
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/quiz/guess-the-list/ws/")) return;
    ws.on("framereceived", () => resolveFrame());
  });
  return firstFrame;
}

async function waitForSocket(promise, label, timeout = 20000) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label} Guess the List websocket`)),
      timeout
    );
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function gameIdFromUrl(page) {
  const match = page.url().match(/\/list\/(\d+)/);
  if (!match) throw new Error(`Could not read Guess the List game id from ${page.url()}`);
  return Number(match[1]);
}

async function joinCodeFromWaitingLobby(page) {
  const bodyText = await page.locator("body").innerText();
  const match = bodyText.match(/\b[A-Z0-9]{6}\b/);
  if (!match) throw new Error(`Could not read Guess the List join code from: ${bodyText}`);
  return match[0];
}

async function startClassicFriendHost(page, nickname) {
  await page.goto("/list");
  await page.getByRole("button", { name: "Online" }).click();
  // Online defaults to the Classic game type and the Create sub-mode.
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByRole("button", { name: "Create Online Game" }).click();
  await expect(page.getByText("WAITING FOR OPPONENT")).toBeVisible({ timeout: 15000 });
  const joinCode = await joinCodeFromWaitingLobby(page);
  const gameId = gameIdFromUrl(page);
  return { joinCode, gameId };
}

async function joinClassicFriend(page, { joinCode, nickname }) {
  await page.goto("/list");
  await page.getByRole("button", { name: "Online" }).click();
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByPlaceholder("ABC123").fill(joinCode);
  await page.getByPlaceholder("Your name").fill(nickname);
  await page.getByRole("button", { name: "Join Game" }).click();
}

function identityBanner(page, name) {
  return page.getByText(`You are ${name}`);
}

function guessInput(page) {
  return page.getByPlaceholder("Type a player name to guess...");
}

async function guessPlayer(page, fullName) {
  const input = guessInput(page);
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(fullName);
  const option = page.getByRole("button", { name: fullName, exact: true });
  await expect(option).toBeVisible({ timeout: 10000 });
  await option.click();
}

// Query the temp e2e database (a copy of euroleague.db; roster rounds are
// random) for answer candidates whose first+last name is globally unique, so an
// exact-name autocomplete option is unambiguous.
function roundAnswerCandidates(gameId, roundNumber) {
  if (!dbPath) {
    throw new Error("E2E_DATABASE_PATH is required for deterministic Guess the List e2e answers");
  }
  const script = `
import json
import sqlite3
import sys

db_path, game_id, round_number = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
try:
    round_row = connection.execute(
        "SELECT id FROM guess_the_list_rounds WHERE game_id = ? AND round_number = ?",
        (game_id, round_number),
    ).fetchone()
    if round_row is None:
        raise SystemExit(f"No Guess the List round for game {game_id} round {round_number}")
    round_id = round_row["id"]

    unique_names = """
        SELECT first_name, last_name
        FROM players
        WHERE TRIM(COALESCE(first_name, '')) <> '' AND TRIM(COALESCE(last_name, '')) <> ''
        GROUP BY first_name, last_name
        HAVING COUNT(*) = 1
    """

    correct = connection.execute(
        f"""
        SELECT p.id AS player_id, p.first_name, p.last_name
        FROM guess_the_list_slots AS s
        JOIN players AS p ON p.id = s.player_id
        JOIN ({unique_names}) AS u
          ON u.first_name = p.first_name AND u.last_name = p.last_name
        WHERE s.round_id = ? AND s.guessed_by_player IS NULL
        ORDER BY p.last_name, p.first_name
        """,
        (round_id,),
    ).fetchall()

    wrong = connection.execute(
        f"""
        SELECT p.id AS player_id, p.first_name, p.last_name
        FROM players AS p
        JOIN ({unique_names}) AS u
          ON u.first_name = p.first_name AND u.last_name = p.last_name
        WHERE p.id NOT IN (
            SELECT player_id FROM guess_the_list_slots WHERE round_id = ?
        )
        ORDER BY p.last_name, p.first_name
        LIMIT 60
        """,
        (round_id,),
    ).fetchall()
finally:
    connection.close()


def names(rows):
    return [
        {"player_id": row["player_id"], "name": f"{row['first_name']} {row['last_name']}".strip()}
        for row in rows
    ]


print(json.dumps({"correct": names(correct), "wrong": names(wrong)}))
`;
  return JSON.parse(
    execFileSync(pythonBin, ["-c", script, dbPath, String(gameId), String(roundNumber)], {
      encoding: "utf8",
    })
  );
}

// Confirm a candidate's exact full name is returned by the live autocomplete
// (limit 15, the same query the board issues) so the dropdown option is present
// and unique before we type it.
async function pickAutocompletable(candidates) {
  for (const candidate of candidates) {
    const result = await apiJson(
      `/quiz/guess-the-list/players/autocomplete?q=${encodeURIComponent(candidate.name)}&limit=15`
    );
    const exact = (result.players || []).filter((player) => player.full_name === candidate.name);
    if (exact.length === 1 && exact[0].player_id === candidate.player_id) {
      return candidate;
    }
  }
  return null;
}

async function answersForRound(gameId, roundNumber) {
  const { correct, wrong } = roundAnswerCandidates(gameId, roundNumber);
  const correctPick = await pickAutocompletable(correct);
  const wrongPick = await pickAutocompletable(wrong);
  if (!correctPick) {
    throw new Error(`No autocompletable correct answer for game ${gameId} round ${roundNumber}`);
  }
  if (!wrongPick) {
    throw new Error(`No autocompletable wrong answer for game ${gameId} round ${roundNumber}`);
  }
  return { correct: correctPick, wrong: wrongPick };
}

// Best-effort cleanup: finish an otherwise-active game so closing the contexts
// does not leave a background disconnect-grace timer writing to the shared DB.
async function resignViaApi(gameId, player) {
  try {
    await apiJson(`/quiz/guess-the-list/games/${gameId}/give-up?player=${player}`, {
      method: "POST",
    });
  } catch {
    // The game may already be finished; ignore.
  }
}

test.describe.serial("Guess the List Classic online Play-a-Friend", () => {
  test.setTimeout(60000);

  test("lifecycle: waiting lobby, join, realtime guesses, and turn switching", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const socketA = trackGuessSocket(pageA);
    const socketB = trackGuessSocket(pageB);
    let gameId;
    try {
      const host = await startClassicFriendHost(pageA, "Classic Alice");
      gameId = host.gameId;

      // Waiting lobby copy + invite link route prefill source (#228).
      await expect(pageA.getByRole("button", { name: "Copy code" })).toBeVisible();
      await expect(pageA.getByRole("button", { name: "Copy link" })).toBeVisible();
      await expect(pageA.getByText(`/list?join=${host.joinCode}`)).toBeVisible();

      await joinClassicFriend(pageB, { joinCode: host.joinCode, nickname: "Classic Bob" });

      // Both players reach the active board with the correct online identity.
      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible({ timeout: 15000 });
      await expect(identityBanner(pageB, "Classic Bob")).toBeVisible({ timeout: 15000 });

      // Ensure both websockets are live before exchanging realtime guesses.
      await waitForSocket(socketA, "host");
      await waitForSocket(socketB, "joiner");

      // Player 1 (creator) starts: only their guess input is shown.
      await expect(guessInput(pageA)).toBeVisible({ timeout: 15000 });
      await expect(guessInput(pageB)).toBeHidden();

      const state = await apiJson(`/quiz/guess-the-list/games/${gameId}`);
      const { correct, wrong } = await answersForRound(gameId, state.round_number);

      // Correct guess by player 1: feedback on both clients (broadcast to all
      // connections) and the slot fills on the opponent's board over realtime.
      await guessPlayer(pageA, correct.name);
      await expect(pageA.getByText("Correct!")).toBeVisible({ timeout: 15000 });
      await expect(pageB.getByText("Correct!")).toBeVisible({ timeout: 15000 });
      await expect(pageB.getByText(correct.name, { exact: true })).toBeVisible({ timeout: 15000 });

      // Turn switches to player 2.
      await expect(guessInput(pageB)).toBeVisible({ timeout: 15000 });
      await expect(guessInput(pageA)).toBeHidden();

      // Incorrect guess by player 2 (a player not on the list): wrong feedback
      // on both clients and the turn returns to player 1.
      await guessPlayer(pageB, wrong.name);
      await expect(pageB.getByText("Wrong player.")).toBeVisible({ timeout: 15000 });
      await expect(pageA.getByText("Wrong player.")).toBeVisible({ timeout: 15000 });
      await expect(guessInput(pageA)).toBeVisible({ timeout: 15000 });
    } finally {
      if (gameId) await resignViaApi(gameId, 1);
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });

  test("resign produces resigned / opponent-resigned terminal states (#227)", async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const socketA = trackGuessSocket(pageA);
    const socketB = trackGuessSocket(pageB);
    try {
      const host = await startClassicFriendHost(pageA, "Classic Alice");
      await joinClassicFriend(pageB, { joinCode: host.joinCode, nickname: "Classic Bob" });
      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible({ timeout: 15000 });
      await expect(identityBanner(pageB, "Classic Bob")).toBeVisible({ timeout: 15000 });
      await waitForSocket(socketA, "host");
      await waitForSocket(socketB, "joiner");

      // Player 1 resigns via the shared footer control.
      await pageA.getByRole("button", { name: "Resign" }).click();
      await expect(pageA.getByText("Resign the match? Your opponent wins.")).toBeVisible();
      await pageA.getByRole("button", { name: "Resign" }).click();

      // The resigner loses; the opponent wins, with reason-specific subtitles.
      await expect(pageA.getByRole("heading", { name: "Classic Bob WINS!" })).toBeVisible({
        timeout: 15000,
      });
      await expect(pageA.getByText("You resigned.")).toBeVisible();
      await expect(pageB.getByRole("heading", { name: "Classic Bob WINS!" })).toBeVisible({
        timeout: 15000,
      });
      await expect(pageB.getByText("Your opponent resigned.")).toBeVisible();
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });

  test("opponent disconnect forfeits via the grace timer (#226)", async ({ browser }) => {
    test.setTimeout(75000);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const socketA = trackGuessSocket(pageA);
    const socketB = trackGuessSocket(pageB);
    try {
      const host = await startClassicFriendHost(pageA, "Classic Alice");
      await joinClassicFriend(pageB, { joinCode: host.joinCode, nickname: "Classic Bob" });
      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible({ timeout: 15000 });
      await expect(identityBanner(pageB, "Classic Bob")).toBeVisible({ timeout: 15000 });
      await waitForSocket(socketA, "host");
      await waitForSocket(socketB, "joiner");

      // Host (player 1) drops; after the disconnect-grace window the opponent
      // wins by forfeit. The wait tolerates the configured grace plus margin.
      await contextA.close().catch(() => {});

      await expect(pageB.getByRole("heading", { name: "Classic Bob WINS!" })).toBeVisible({
        timeout: 40000,
      });
      await expect(pageB.getByText("Your opponent left the game.")).toBeVisible();
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });

  test("active online game recovers after a refresh", async ({ browser }) => {
    test.setTimeout(45000);
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const socketA = trackGuessSocket(pageA);
    const socketB = trackGuessSocket(pageB);
    let gameId;
    try {
      const host = await startClassicFriendHost(pageA, "Classic Alice");
      gameId = host.gameId;
      await joinClassicFriend(pageB, { joinCode: host.joinCode, nickname: "Classic Bob" });
      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible({ timeout: 15000 });
      await expect(identityBanner(pageB, "Classic Bob")).toBeVisible({ timeout: 15000 });
      await waitForSocket(socketA, "host");
      await waitForSocket(socketB, "joiner");

      // The per-tab online seat used for recovery is persisted in sessionStorage.
      const stored = await pageA.evaluate((id) => sessionStorage.getItem(`elq_game_${id}`), gameId);
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored)).toMatchObject({ isOnline: true, playerNumber: 1 });

      // Reload the host tab (the opponent stays connected so the game remains
      // active); recovery must reconnect before the grace window elapses.
      const socketAReload = trackGuessSocket(pageA);
      await pageA.reload();
      await waitForSocket(socketAReload, "host-reload");

      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible({ timeout: 15000 });
      await expect(guessInput(pageA)).toBeVisible({ timeout: 15000 });

      // Reloading dropped the host websocket, which arms the disconnect-grace
      // forfeit timer; recovery must reconnect and cancel it. Assert the game is
      // still active only AFTER the grace window (10s in the e2e backend) would
      // have elapsed, so a broken reconnect-cancel cannot pass by being checked
      // before the forfeit fires. This bounded wait is unavoidable: the expected
      // outcome is the absence of a timed forfeit event.
      await pageA.waitForTimeout(13000);
      const recovered = await apiJson(`/quiz/guess-the-list/games/${gameId}`);
      expect(recovered.status).toBe("active");
      // Turn-insensitive: the identity banner renders whenever the online board
      // is mounted, regardless of whose turn it is, so a 40s turn-timer switch
      // during a slow run cannot turn this into a false failure.
      await expect(identityBanner(pageA, "Classic Alice")).toBeVisible();
    } finally {
      if (gameId) await resignViaApi(gameId, 1);
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });

  test("invite link prefills the Classic join code on /list?join= (#228)", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      const host = await startClassicFriendHost(pageA, "Classic Alice");

      await pageB.goto(`/list?join=${host.joinCode}`);

      // Landed on Online -> Classic -> Join with the code prefilled.
      await expect(pageB.getByPlaceholder("ABC123")).toHaveValue(host.joinCode);
      await expect(pageB.getByRole("button", { name: "Join Game" })).toBeVisible();
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });
});
