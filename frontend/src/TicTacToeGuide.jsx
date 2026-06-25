import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Additive onboarding chrome for the TicTacToe board: a persistent objective
// line, a dismissible first-run how-to, and a tappable clue legend. Nothing here
// touches game state — it is pure, client-only explanatory UI so a first-time
// player understands the goal and what each row/column chip means.
//
// Copy stays consistent with the per-cell search prompt (see cluePrompt.js):
// team = "played for", nationality = "is from", played_with = "teammate of",
// season = "played in the … season", position = "played as", champion =
// "EuroLeague champion", stat_milestone = the chip's own label.

const HOWTO_SEEN_KEY = "elq_ttt_howto_seen";

// Read/write of the "seen" flag is best-effort: a throwing localStorage (private
// mode, disabled storage) must never break the board, so we degrade to "not
// seen" on read failure and silently drop write failures. The reopen control is
// always rendered, so the how-to is always reachable regardless.
function readHowToSeen() {
  try {
    return globalThis.localStorage?.getItem(HOWTO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function persistHowToSeen() {
  try {
    globalThis.localStorage?.setItem(HOWTO_SEEN_KEY, "1");
  } catch {
    // Ignore: the in-memory flag still dismisses the card for this session.
  }
}

// The three micro-steps, shared between the first-run inline card and the
// reopenable how-to dialog so the wording can never drift between them.
function HowToSteps() {
  return (
    <ol className="space-y-1.5 text-sm text-elq-text list-decimal pl-5">
      <li>Tap an empty cell.</li>
      <li>Name a EuroLeague player who fits its row clue and its column clue.</li>
      <li>Claim three cells in a row to win.</li>
    </ol>
  );
}

// One entry per axis type the backend can serve. Each carries a representative
// chip (palette + emoji mirror AxisLabel) and a type-level description — never a
// single hardcoded milestone — so calibration changes need no edit here.
const LEGEND_ENTRIES = [
  {
    type: "team",
    chip: "Real Madrid",
    palette: "bg-slate-50 text-slate-700 border-slate-200",
    name: "Team",
    description: "The player played for this club.",
  },
  {
    type: "nationality",
    chip: "\ud83c\udf0d Serbia",
    palette: "bg-emerald-50 text-emerald-800 border-emerald-200",
    name: "Nationality",
    description: "The player is from this country.",
  },
  {
    type: "played_with",
    chip: "\ud83e\udd1d Teammate",
    palette: "bg-amber-50 text-amber-800 border-amber-200",
    name: "Played with",
    description: "The player was a teammate of the named player.",
  },
  {
    type: "season",
    chip: "\ud83d\udcc5 2015\u201316",
    palette: "bg-violet-50 text-violet-800 border-violet-200",
    name: "Season",
    description: "The player played in this season.",
  },
  {
    type: "position",
    chip: "Guard",
    palette: "bg-sky-50 text-sky-800 border-sky-200",
    name: "Position",
    description: "The player played this role (Guard, Forward, or Center).",
  },
  {
    type: "champion",
    chip: "\ud83c\udfc6 EuroLeague champion",
    palette: "bg-yellow-50 text-yellow-800 border-yellow-300",
    name: "Champion",
    description: "The player won the EuroLeague title.",
  },
  {
    type: "stat_milestone",
    chip: "\ud83d\udcca 15+ PPG season",
    palette: "bg-rose-50 text-rose-800 border-rose-200",
    name: "Stat milestone",
    description:
      "The player hit the stat milestone shown on the chip (e.g. 15+ PPG in a season).",
  },
];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(node) {
  if (!node) return [];
  return Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR));
}

// A portal-mounted modal so it is never clipped by the board's overflow cells.
// It implements the accessibility contract the issue requires: role="dialog" +
// aria-modal, a manual focus trap (jsdom does not move focus on Tab), Esc and
// backdrop-click to close, and focus restoration to the opener.
function GuideDialog({ open, onClose, title, testId, children }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;

    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const node = dialogRef.current;
    // Focus the container (not a child) so a screen reader announces the dialog
    // title before the user starts tabbing through controls.
    node?.focus();

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusable = getFocusable(node);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const insideChild = node.contains(active) && active !== node;
      if (e.shiftKey) {
        if (!insideChild || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideChild || active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const opener = openerRef.current;
      if (opener && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-overlay-in"
      style={{ background: "rgba(15, 25, 35, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5 animate-modal-in outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3 gap-3">
          <h2
            id={titleId}
            className="font-display text-2xl tracking-wide text-elq-dark"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-elq-text hover:bg-elq-bg focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-elq-dark transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
        <p className="mt-4 text-[11px] text-elq-text text-center">
          Press{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-elq-bg border border-elq-border text-[10px] font-mono">
            Esc
          </kbd>{" "}
          to close
        </p>
      </div>
    </div>,
    document.body
  );
}

const AFFORDANCE_CLASS =
  "text-sm font-medium text-elq-text underline underline-offset-2 hover:text-elq-orange focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-elq-dark rounded transition-colors";

// Standalone "How to play" control + dialog for surfaces that want the how-to
// without the objective line, clue legend, or first-run card — the desktop Solo
// command rail (issue #266). It reuses the same GuideDialog + HowToSteps and the
// same `ttt-howto-trigger` / `ttt-howto-dialog` testids as the full guide, so the
// copy can never drift and behaviour stays identical; only the always-on legend
// is dropped on this surface, per the product decision.
export function HowToPlayControl({ className = AFFORDANCE_CLASS }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="ttt-howto-trigger"
        onClick={() => setOpen(true)}
        className={className}
      >
        How to play
      </button>
      <GuideDialog
        open={open}
        onClose={() => setOpen(false)}
        title="HOW TO PLAY"
        testId="ttt-howto-dialog"
      >
        <HowToSteps />
      </GuideDialog>
    </>
  );
}

export default function TicTacToeGuide() {
  const [howToSeen, setHowToSeen] = useState(readHowToSeen);
  // null | "howto" | "legend" — only ever one dialog open at a time.
  const [openDialog, setOpenDialog] = useState(null);

  function dismissFirstRun() {
    persistHowToSeen();
    setHowToSeen(true);
  }

  const closeDialog = () => setOpenDialog(null);

  return (
    <div className="w-full mb-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p data-testid="ttt-objective" className="text-sm text-elq-text">
          Claim three in a row — name a player who matches both clues for a cell.
        </p>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            data-testid="ttt-howto-trigger"
            onClick={() => setOpenDialog("howto")}
            className={AFFORDANCE_CLASS}
          >
            How to play
          </button>
          <span aria-hidden="true" className="text-elq-border">
            |
          </span>
          <button
            type="button"
            data-testid="ttt-legend-trigger"
            onClick={() => setOpenDialog("legend")}
            className={AFFORDANCE_CLASS}
          >
            Clue legend
          </button>
        </div>
      </div>

      {!howToSeen && (
        <div
          data-testid="ttt-howto"
          role="note"
          aria-label="How to play"
          onKeyDown={(e) => {
            if (e.key === "Escape") dismissFirstRun();
          }}
          className="ttt-howto-firstrun mt-3 bg-white border border-elq-border rounded-xl p-4 animate-slide-down"
        >
          <div className="flex items-start justify-between gap-3 mb-2">
            <h3 className="text-sm font-semibold text-elq-text">New here? How to play</h3>
            <button
              type="button"
              data-testid="ttt-howto-dismiss"
              onClick={dismissFirstRun}
              className="shrink-0 text-xs font-semibold text-elq-text px-2.5 py-1 rounded-lg border border-elq-border hover:bg-elq-bg focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-elq-dark transition-colors"
            >
              Got it
            </button>
          </div>
          <HowToSteps />
        </div>
      )}

      <GuideDialog
        open={openDialog === "howto"}
        onClose={closeDialog}
        title="HOW TO PLAY"
        testId="ttt-howto-dialog"
      >
        <HowToSteps />
      </GuideDialog>

      <GuideDialog
        open={openDialog === "legend"}
        onClose={closeDialog}
        title="CLUE LEGEND"
        testId="ttt-legend-dialog"
      >
        <p className="text-sm text-elq-text mb-3">
          Each cell sits where a row clue meets a column clue — name a player who
          satisfies both.
        </p>
        <ul className="space-y-3">
          {LEGEND_ENTRIES.map((entry) => (
            <li
              key={entry.type}
              data-testid={`ttt-legend-entry-${entry.type}`}
              className="flex items-start gap-3"
            >
              <span
                className={`shrink-0 px-2 py-1 rounded-lg border text-xs font-semibold leading-tight ${entry.palette}`}
              >
                {entry.chip}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-elq-text">{entry.name}</p>
                <p className="text-sm text-elq-text">{entry.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </GuideDialog>
    </div>
  );
}
