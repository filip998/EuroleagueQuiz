import { useEffect, useRef, useState } from "react";

// Module-level stable reference used whenever navigation is disabled, so the
// "items changed" check below never sees a brand-new array (which would reset
// the highlight every render and spin into "Too many re-renders").
const EMPTY_ITEMS = [];

/**
 * Keyboard navigation for an autocomplete suggestion list.
 *
 * `items` must be referentially stable between real updates (typically a piece
 * of component state). The highlight resets whenever the array reference
 * changes, so passing a freshly-built array every render (`.filter()`,
 * `.slice()`, inline `cond ? items : []`) would clear the highlight on every
 * render and is not supported.
 *
 * `enabled` (default `true`) lets a consumer turn navigation off while the
 * suggestion list is not actually rendered (e.g. mid-debounce loading, or a
 * popup hidden by a focus/empty-query gate). When `false` the hook behaves as
 * if the list were empty, so the cursor keys fall back to the input and Enter
 * can never select a stale row the user can no longer see.
 *
 * Returns:
 * - `activeIndex`: highlighted row, or `-1` when nothing is highlighted and the
 *   text cursor stays in the input.
 * - `activeItemRef`: attach to the highlighted row so long lists scroll it into
 *   view.
 * - `handleKeyDown`: owns ArrowUp/ArrowDown/Enter. Consumers keep their own
 *   Escape/blur handling and delegate the remaining keys here.
 */
export function useListKeyboardNav(items, onChoose, enabled = true) {
  // The list the user can actually see and act on right now.
  const activeItems = enabled ? items : EMPTY_ITEMS;
  const [activeIndex, setActiveIndex] = useState(-1);
  const [prevItems, setPrevItems] = useState(activeItems);
  const activeItemRef = useRef(null);

  // Reset the highlight whenever the visible suggestion list changes (new
  // results, a cleared list, or the list being hidden via `enabled`) so a stale
  // row is never highlighted. Uses the "adjust state during render" pattern
  // rather than a useEffect to satisfy the repo's react-hooks/set-state-in-effect
  // rule (mirrors the prevRoundKey reset in the Career/Photo guess boxes).
  if (activeItems !== prevItems) {
    setPrevItems(activeItems);
    setActiveIndex(-1);
  }

  useEffect(() => {
    if (activeIndex < 0) return;
    // jsdom does not implement scrollIntoView, so guard the call for tests.
    activeItemRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function handleKeyDown(event) {
    if (event.key === "ArrowDown") {
      // Nothing to navigate: leave the arrow key to the input's text cursor.
      if (activeItems.length === 0) return;
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, activeItems.length - 1));
    } else if (event.key === "ArrowUp") {
      if (activeItems.length === 0) return;
      event.preventDefault();
      // From the first row (or none) go back to the input; otherwise step up.
      setActiveIndex((index) => (index <= 0 ? -1 : index - 1));
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < activeItems.length) {
        event.preventDefault();
        onChoose(activeItems[activeIndex]);
      } else if (activeItems.length === 1) {
        // Preserve the existing "exactly one result -> Enter selects it" shortcut.
        event.preventDefault();
        onChoose(activeItems[0]);
      }
    }
  }

  return { activeIndex, activeItemRef, handleKeyDown };
}
