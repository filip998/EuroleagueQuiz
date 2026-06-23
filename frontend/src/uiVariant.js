/**
 * UI variant switch.
 *
 * `refined` (default) renders the "Refined Light" home and applies the accessible
 * token overrides under `[data-ui="refined"]`. Setting the build/runtime env var
 * `VITE_UI_VARIANT=classic` restores the previous home and the original tokens
 * pixel-for-pixel, with no code change. Read once at module load; `main.jsx`
 * mirrors it onto `document.documentElement.dataset.ui` at boot so the CSS token
 * overrides cascade app-wide.
 */
export const UI_VARIANT =
  import.meta.env.VITE_UI_VARIANT === "classic" ? "classic" : "refined";
