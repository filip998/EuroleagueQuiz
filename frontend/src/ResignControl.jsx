import { useState } from "react";

// Shared online "Resign" affordance used by every online board (TicTacToe,
// Career Quiz, Photo Quiz, Guess the List Race). Renders a subtle "Resign" link
// that expands into a confirm card. `onResign` is invoked when the player
// confirms; `disabled` freezes the buttons while the request is in flight.
export default function ResignControl({ onResign, disabled = false }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-4 text-center">
      {confirming ? (
        <div className="inline-flex flex-col items-center gap-2 bg-white rounded-xl border border-elq-border p-4 animate-slide-down">
          <p className="text-sm text-elq-text">Resign the match? Your opponent wins.</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onResign}
              disabled={disabled}
              className="px-5 py-2 bg-red-500 text-white font-medium rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              Resign
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={disabled}
              className="px-5 py-2 bg-white border border-elq-border text-elq-text font-medium rounded-lg hover:bg-elq-bg transition-colors disabled:opacity-50"
            >
              Keep playing
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          className="text-sm text-elq-muted hover:text-red-500 transition-colors underline underline-offset-2"
        >
          Resign
        </button>
      )}
    </div>
  );
}
