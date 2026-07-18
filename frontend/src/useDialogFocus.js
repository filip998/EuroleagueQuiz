import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(node) {
  if (!node) return [];
  return Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR));
}

// True only if calling `.focus()` on this element would actually move focus
// to it right now -- connected to the document, not the document/body root
// itself, and not natively disabled. A disconnected element, `<body>`/the
// root `<html>` (never a meaningful restoration target -- see below), or one
// whose `disabled` attribute flipped true while a dialog was open on top of
// it (e.g. a game board cell that became unavailable while a picker was
// open) silently no-ops on `.focus()`, which is exactly how focus
// restoration used to go missing to `<body>`.
function isRestorable(el) {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el === document.body || el === document.documentElement) return false;
  if ("disabled" in el && el.disabled) return false;
  return true;
}

export function useDialogFocus({
  open = true,
  onClose,
  initialFocusRef = null,
  triggerRef = null,
  fallbackFocusRef = null,
}) {
  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;

    // Prefer an explicitly-supplied trigger control -- deterministic
    // regardless of whether the browser actually moved focus to it on
    // pointer/tap (Safari and Firefox on macOS commonly leave `<body>`
    // focused after a plain click, unlike Chromium). Only fall back to
    // inferring the opener from document.activeElement for callers that
    // haven't supplied one yet.
    const explicitTrigger =
      triggerRef?.current instanceof HTMLElement ? triggerRef.current : null;
    const activeElementOpener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerRef.current = explicitTrigger || activeElementOpener;

    const node = dialogRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (initialFocusRef?.current || node)?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !node) return;

      const focusable = getFocusable(node);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const insideChild = node.contains(active) && active !== node;

      if (event.shiftKey) {
        if (!insideChild || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!insideChild || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      const opener = openerRef.current;
      // Restore to the opener when it's still a real, focusable control.
      // Otherwise (disconnected, or disabled by something that changed while
      // this dialog was open -- e.g. a realtime update elsewhere on the
      // page) fall back to a caller-supplied stable control instead of
      // silently leaving focus at <body>.
      if (isRestorable(opener)) {
        opener.focus();
      } else {
        // Intentionally read fresh here (not a value captured when this
        // effect started): `fallbackFocusRef` points at a live DOM node
        // (e.g. GameBoard's board-region container) that can itself remount
        // to a different element while this dialog was open -- reading
        // `.current` now, at cleanup time, is what gets the fallback that
        // actually still exists, not a possibly-stale one from when the
        // dialog opened.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const fallback = fallbackFocusRef?.current;
        if (isRestorable(fallback)) fallback.focus();
      }
    };
  }, [initialFocusRef, triggerRef, fallbackFocusRef, open]);

  return dialogRef;
}
