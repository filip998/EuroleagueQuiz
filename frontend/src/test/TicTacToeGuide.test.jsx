import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TicTacToeGuide from "../TicTacToeGuide";

const HOWTO_SEEN_KEY = "elq_ttt_howto_seen";

// The Node test runtime ships an inert experimental `localStorage` global that
// shadows jsdom's, so install a working in-memory Storage for these tests
// (mirroring identity.test.js). The first-run flag lives in localStorage.
const originalLocalStorage = globalThis.localStorage;

function installMemoryStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  installMemoryStorage();
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
  vi.restoreAllMocks();
});

describe("TicTacToeGuide objective + affordances", () => {
  it("always shows a one-line objective above the board", () => {
    render(<TicTacToeGuide />);
    const objective = screen.getByTestId("ttt-objective");
    expect(objective).toBeInTheDocument();
    expect(objective).toHaveTextContent(
      /Claim three in a row.*name a player who matches both clues for a cell/i
    );
  });

  it("always renders the How to play and Clue legend reopen controls", () => {
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);
    expect(screen.getByTestId("ttt-howto-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("ttt-legend-trigger")).toBeInTheDocument();
  });

  it("keeps the How to play reopen control visible while the first-run card shows", () => {
    render(<TicTacToeGuide />);
    expect(screen.getByTestId("ttt-howto")).toBeInTheDocument();
    expect(screen.getByTestId("ttt-howto-trigger")).toBeInTheDocument();
  });
});

describe("TicTacToeGuide first-run how-to", () => {
  it("shows the dismissible 3-step how-to on first visit", () => {
    render(<TicTacToeGuide />);
    const card = screen.getByTestId("ttt-howto");
    const steps = within(card).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(card).toHaveTextContent(/Tap an empty cell/i);
    expect(card).toHaveTextContent(/row clue and its column clue/i);
    expect(card).toHaveTextContent(/Claim three cells in a row/i);
  });

  it("dismisses the card, persists the flag, and keeps the reopen control", () => {
    render(<TicTacToeGuide />);
    fireEvent.click(screen.getByTestId("ttt-howto-dismiss"));
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();
    expect(localStorage.getItem(HOWTO_SEEN_KEY)).toBe("1");
    expect(screen.getByTestId("ttt-howto-trigger")).toBeInTheDocument();
  });

  it("stays dismissed across reloads (remount) once the flag is set", () => {
    const { unmount } = render(<TicTacToeGuide />);
    fireEvent.click(screen.getByTestId("ttt-howto-dismiss"));
    unmount();

    render(<TicTacToeGuide />);
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();
  });

  it("does not show the first-run card when already seen", () => {
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();
  });
});

describe("TicTacToeGuide how-to dialog (reopen)", () => {
  it("opens a focus-trapped dialog from the How to play control", async () => {
    const user = userEvent.setup();
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);

    expect(screen.queryByTestId("ttt-howto-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("ttt-howto-trigger"));

    const dialog = screen.getByTestId("ttt-howto-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const user = userEvent.setup();
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);

    const trigger = screen.getByTestId("ttt-howto-trigger");
    await user.click(trigger);
    expect(screen.getByTestId("ttt-howto-dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("ttt-howto-dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("traps focus inside the dialog while open", async () => {
    const user = userEvent.setup();
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);

    await user.click(screen.getByTestId("ttt-howto-trigger"));
    const dialog = screen.getByTestId("ttt-howto-dialog");

    // Focus starts on the dialog container so a screen reader announces the title.
    expect(dialog).toBe(document.activeElement);

    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    localStorage.setItem(HOWTO_SEEN_KEY, "1");
    render(<TicTacToeGuide />);

    await user.click(screen.getByTestId("ttt-howto-trigger"));
    const dialog = screen.getByTestId("ttt-howto-dialog");
    fireEvent.click(dialog.parentElement);
    expect(screen.queryByTestId("ttt-howto-dialog")).not.toBeInTheDocument();
  });
});

describe("TicTacToeGuide clue legend", () => {
  const AXIS_TYPES = [
    "team",
    "nationality",
    "played_with",
    "season",
    "position",
    "champion",
    "stat_milestone",
  ];

  it("opens from the board and explains every axis type that can appear", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);

    await user.click(screen.getByTestId("ttt-legend-trigger"));
    const dialog = screen.getByTestId("ttt-legend-dialog");
    expect(dialog).toHaveAttribute("role", "dialog");

    for (const type of AXIS_TYPES) {
      expect(within(dialog).getByTestId(`ttt-legend-entry-${type}`)).toBeInTheDocument();
    }
  });

  it("describes each clue type with consistent wording", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-legend-trigger"));
    const dialog = screen.getByTestId("ttt-legend-dialog");

    expect(within(dialog).getByText(/played for this club/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/is from this country/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/was a teammate of the named player/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/played in this season/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Guard, Forward, or Center/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/won the EuroLeague title/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/stat milestone shown on the chip/i)).toBeInTheDocument();
  });

  it("renders the dialog through a portal so it is not nested in the guide container", async () => {
    const user = userEvent.setup();
    const { container } = render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-legend-trigger"));

    const dialog = screen.getByTestId("ttt-legend-dialog");
    // Portaled to document.body, so it is not a descendant of the component's
    // own (overflow-prone) subtree.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("closes via the Close button", async () => {
    const user = userEvent.setup();
    render(<TicTacToeGuide />);
    await user.click(screen.getByTestId("ttt-legend-trigger"));
    const dialog = screen.getByTestId("ttt-legend-dialog");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("ttt-legend-dialog")).not.toBeInTheDocument();
  });
});

describe("TicTacToeGuide localStorage degradation", () => {
  it("shows the first-run card when reading the flag throws", () => {
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    render(<TicTacToeGuide />);
    // Read failure degrades to "not seen", so the card (and the always-present
    // reopen control) remain reachable.
    expect(screen.getByTestId("ttt-howto")).toBeInTheDocument();
    expect(screen.getByTestId("ttt-howto-trigger")).toBeInTheDocument();
  });

  it("still dismisses the card when writing the flag throws", () => {
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
    };
    render(<TicTacToeGuide />);
    expect(() => fireEvent.click(screen.getByTestId("ttt-howto-dismiss"))).not.toThrow();
    // The in-memory flag still hides the card for this session.
    expect(screen.queryByTestId("ttt-howto")).not.toBeInTheDocument();
  });
});
