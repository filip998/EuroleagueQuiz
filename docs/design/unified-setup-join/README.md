# Unified setup / join — design reference

Visual reference for the GitHub issue **"Unify pre-game setup, join, and waiting-lobby UX across all games."**
This documents the agreed design only; it is not shipped code.

## Chosen direction: A — "Online expands"

A row of mode cards (**Solo · Local 1v1 · Online**). Selecting **Online** reveals a
**Create / Join** sub-toggle, so joining is identical across every game. The mode selector
is hidden entirely for single-mode games (Higher or Lower).

| State | Screenshot |
|---|---|
| All three directions compared (A chosen) + shared waiting lobby | `overview.png` |
| Direction A — Online → Create | `direction-a-create.png` |
| Direction A — Online → Join | `direction-a-join.png` |

## Viewing the interactive mockup

`mockups.html` is self-contained (Tailwind Play CDN + Google Fonts). Open it directly,
or serve it and click through every mode in each direction:

```bash
cd docs/design/unified-setup-join
python3 -m http.server 7878
# then open http://localhost:7878/mockups.html
```

## Notes for the implementer

- The mockup uses **Roster Guess** as a representative game (richest settings) and an
  **orange placeholder badge** for the header icon. The real per-game accent colors are
  specified in the issue: TicTacToe `elq-player1` (blue), Roster Guess `elq-player2` (red),
  Higher or Lower emerald, Career Quiz amber. The primary button stays `elq-orange`.
- The in-card compact header in the mockup is a space-saving simplification for the 3-up
  comparison. The real screens use `LogoMini` (top-left) + a centered per-game identity
  block above the card, per the issue.
- Canonical card style: `rounded-2xl border border-elq-border shadow-lg shadow-black/5`.
