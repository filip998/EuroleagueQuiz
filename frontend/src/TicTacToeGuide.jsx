import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./useDialogFocus";

const HOW_TO_STEPS = [
  {
    title: "Pick an empty cell",
    detail: "Its row and column show the two clues to match.",
  },
  {
    title: "Choose a matching player",
    detail: "Search for any EuroLeague player who fits both clues.",
  },
  {
    title: "Make three in a row",
    detail: "Claim a horizontal, vertical, or diagonal line to win.",
  },
];

const LEGEND_ENTRIES = [
  {
    type: "team",
    chip: "Real Madrid",
    palette: "bg-slate-50 text-slate-700 border-slate-200",
    name: "Team",
    description: "Played for this club.",
  },
  {
    type: "nationality",
    chip: "\ud83c\udf0d Serbia",
    palette: "bg-emerald-50 text-emerald-800 border-emerald-200",
    name: "Nationality",
    description: "Is from this country.",
  },
  {
    type: "played_with",
    chip: "\ud83e\udd1d Played with",
    palette: "bg-amber-50 text-amber-800 border-amber-200",
    name: "Teammate",
    description: "Shared a roster with this player.",
  },
  {
    type: "season",
    chip: "\ud83d\udcc5 2015\u201316",
    palette: "bg-violet-50 text-violet-800 border-violet-200",
    name: "Season",
    description: "Played in this season.",
  },
  {
    type: "position",
    chip: "Guard",
    palette: "bg-sky-50 text-sky-800 border-sky-200",
    name: "Position",
    description: "Played this role.",
  },
  {
    type: "champion",
    chip: "\ud83c\udfc6 Champion",
    palette: "bg-yellow-50 text-yellow-800 border-yellow-300",
    name: "Champion",
    description: "Won the EuroLeague title.",
  },
  {
    type: "stat_milestone",
    chip: "\ud83d\udcca 15+ PPG",
    palette: "bg-rose-50 text-rose-800 border-rose-200",
    name: "Stat milestone",
    description: "Reached the number shown.",
  },
];

function HowToPanel({ panelId, tabId }) {
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      data-testid="ttt-help-howto-panel"
    >
      <p className="mb-4 text-sm text-elq-muted">
        Match one player to both the row and column clue.
      </p>
      <ol className="space-y-3">
        {HOW_TO_STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex items-start gap-4 rounded-xl border border-elq-border bg-slate-50/70 p-3"
          >
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-elq-cta-dark"
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <strong className="block text-sm text-elq-dark">{step.title}</strong>
              <span className="mt-0.5 block text-sm leading-snug text-elq-muted">
                {step.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function LegendPanel({ panelId, tabId }) {
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      data-testid="ttt-help-legend-panel"
    >
      <ul className="space-y-3">
        {LEGEND_ENTRIES.map((entry) => (
          <li
            key={entry.type}
            data-testid={`ttt-legend-entry-${entry.type}`}
            className="flex items-center gap-3"
          >
            <span
              className={`flex min-h-8 w-[118px] shrink-0 items-center justify-center rounded-lg border px-2 py-1 text-center text-xs font-semibold leading-tight ${entry.palette}`}
            >
              {entry.chip}
            </span>
            <span className="min-w-0">
              <strong className="block text-sm text-elq-dark">{entry.name}</strong>
              <span className="block text-xs leading-snug text-elq-muted">
                {entry.description}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HelpDialog({ open, onClose }) {
  const [activeTab, setActiveTab] = useState("howto");
  const titleId = useId();
  const howToTabId = useId();
  const howToPanelId = useId();
  const legendTabId = useId();
  const legendPanelId = useId();
  const howToTabRef = useRef(null);
  const legendTabRef = useRef(null);
  const dialogRef = useDialogFocus({ open, onClose });

  if (!open) return null;

  function handleTabKeyDown(event) {
    let nextTab = null;
    if (event.key === "Home") nextTab = "howto";
    else if (event.key === "End") nextTab = "legend";
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      nextTab = activeTab === "howto" ? "legend" : "howto";
    }
    if (!nextTab) return;

    event.preventDefault();
    setActiveTab(nextTab);
    (nextTab === "howto" ? howToTabRef : legendTabRef).current?.focus();
  }

  return createPortal(
    <div
      className="animate-overlay-in fixed inset-0 z-50 flex items-end bg-slate-950/50 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="ttt-help-dialog"
        tabIndex={-1}
        className="ttt-responsive-dialog max-h-[calc(100dvh-56px)] w-full overflow-y-auto rounded-t-3xl bg-white px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-3 shadow-2xl outline-none sm:max-h-[85vh] sm:max-w-md sm:rounded-2xl sm:p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          aria-hidden="true"
          className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300 sm:hidden"
        />
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id={titleId}
            className="text-xl font-bold text-elq-dark"
          >
            Help
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-elq-muted transition-colors hover:bg-elq-bg hover:text-elq-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange"
          >
            <svg
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          role="tablist"
          aria-label="TicTacToe help"
          className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-200/70 p-1"
        >
          <button
            ref={howToTabRef}
            id={howToTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === "howto"}
            aria-controls={howToPanelId}
            tabIndex={activeTab === "howto" ? 0 : -1}
            data-testid="ttt-help-tab-howto"
            onClick={() => setActiveTab("howto")}
            onKeyDown={handleTabKeyDown}
            className={`min-h-10 rounded-lg text-sm font-semibold ${
              activeTab === "howto"
                ? "bg-white text-elq-dark shadow-sm"
                : "text-elq-muted"
            }`}
          >
            How to play
          </button>
          <button
            ref={legendTabRef}
            id={legendTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === "legend"}
            aria-controls={legendPanelId}
            tabIndex={activeTab === "legend" ? 0 : -1}
            data-testid="ttt-help-tab-legend"
            onClick={() => setActiveTab("legend")}
            onKeyDown={handleTabKeyDown}
            className={`min-h-10 rounded-lg text-sm font-semibold ${
              activeTab === "legend"
                ? "bg-white text-elq-dark shadow-sm"
                : "text-elq-muted"
            }`}
          >
            Clue types
          </button>
        </div>

        {activeTab === "howto" ? (
          <HowToPanel panelId={howToPanelId} tabId={howToTabId} />
        ) : (
          <LegendPanel panelId={legendPanelId} tabId={legendTabId} />
        )}
      </div>
    </div>,
    document.body
  );
}

const HELP_BUTTON_CLASS =
  "inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-elq-cta hover:text-elq-cta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-elq-orange";

export function HowToPlayControl({ className = HELP_BUTTON_CLASS }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="ttt-help-trigger"
        onClick={() => setOpen(true)}
        className={className}
      >
        Help
      </button>
      <HelpDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export default function TicTacToeGuide() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-2 flex w-full items-start justify-between gap-3">
      <p data-testid="ttt-objective" className="pt-2 text-sm leading-snug text-elq-text">
        Pick a cell, then name a player who matches both clues.
      </p>
      <button
        type="button"
        data-testid="ttt-help-trigger"
        onClick={() => setOpen(true)}
        className={`${HELP_BUTTON_CLASS} shrink-0`}
      >
        Help
      </button>
      <HelpDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
