import { useId } from "react";
import { NICKNAME_MAX_LENGTH } from "./identity";

// The one shared player-name input used by every game setup screen, so the
// label, placeholder, sizing, length cap, and (optional) required-ness stay
// identical across TicTacToe, Higher or Lower, Career, Photo, and Guess the List.
//
// It is always optional: anonymous play keeps working, and the field is
// prefilled from `getDisplayName()` (saved nickname or a stable guest name) so
// it is never empty by default. Local 1v1 reuses it with "Player 1"/"Player 2"
// labels via the `label`/`placeholder` props.
export default function NameField({
  value,
  onChange,
  label = "Your Name",
  placeholder = "Your name",
  disabled = false,
  className = "",
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm text-elq-text mb-1.5">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={NICKNAME_MAX_LENGTH}
        disabled={disabled}
        className="w-full px-4 py-2.5 rounded-xl border-2 border-elq-border bg-elq-bg focus:border-elq-orange focus:ring-0 focus:outline-none transition-colors disabled:opacity-60"
      />
    </div>
  );
}
