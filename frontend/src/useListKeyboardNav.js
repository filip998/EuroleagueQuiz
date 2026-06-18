import { useEffect, useRef, useState } from "react";

/**
 * Keyboard navigation for an autocomplete suggestion list.
 *
 * `items` must be referentially stable between real updates (typically a piece
 * of component state). The highlight resets whenever the array reference
 * changes, so passing a freshly-built array every render (`.filter()`,
 * `.slice()`, inline `cond ? items : []`) would clear the highlight on every
 * render and is not supported.
 *
 * Returns:
 * - `activeIndex`: highlighted row, or `-1` when nothing is highlighted and the
 *   text cursor stays in the input.
 * - `activeItemRef`: attach to the highlighted row so long lists scroll it into
 *   view.
 * - `handleKeyDown`: owns ArrowUp/ArrowDown/Enter. Consumers keep their own
 *   Escape/blur handling and delegate the remaining keys here.
 */
export function useListKeyboardNav(items, onChoose) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [prevItems, setPrevItems] = useState(items);
  const activeItemRef = useRef(null);

  // Reset the highlight whenever the suggestion list changes (new results or a
  // cleared list) so a stale row is never highlighted. Uses the "adjust state
  // during render" pattern rather than a useEffect to satisfy the repo's
  // react-hooks/set-state-in-effect rule (mirrors the prevRoundKey reset in the
  // Career/Photo guess boxes).
  if (items !== prevItems) {
    setPrevItems(items);
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
      if (items.length === 0) return;
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      // From the first row (or none) go back to the input; otherwise step up.
      setActiveIndex((index) => (index <= 0 ? -1 : index - 1));
    } else if (event.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < items.length) {
        event.preventDefault();
        onChoose(items[activeIndex]);
      } else if (items.length === 1) {
        // Preserve the existing "exactly one result -> Enter selects it" shortcut.
        event.preventDefault();
        onChoose(items[0]);
      }
    }
  }

  return { activeIndex, activeItemRef, handleKeyDown };
}
