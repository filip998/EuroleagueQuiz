---
name: EuroLeague Quiz
description: A fast, club-specific quiz launcher for EuroLeague fans.
colors:
  brand-orange: "#FF6600"
  action-orange: "#C2410C"
  action-orange-hover: "#9A3412"
  ink: "#0F1923"
  text: "#1E293B"
  muted: "#566677"
  canvas: "#F5F6F8"
  surface: "#FFFFFF"
  border: "#E2E8F0"
  player-one: "#2563EB"
  player-two: "#DC2626"
  success: "#059669"
  warning: "#D97706"
typography:
  display:
    fontFamily: "Bebas Neue, Impact, sans-serif"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: 0.92
    letterSpacing: "0.025em"
  headline:
    fontFamily: "Bebas Neue, Impact, sans-serif"
    fontSize: "36px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.025em"
  title:
    fontFamily: "Bebas Neue, Impact, sans-serif"
    fontSize: "24px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.025em"
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "0.05em"
rounded:
  button: "8px"
  control: "12px"
  surface: "16px"
  pill: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-orange}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.action-orange-hover}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "24px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
---

# Design System: EuroLeague Quiz

## Overview

**Creative North Star: "Courtside Game Launcher"**

The interface should feel like arriving courtside just before tip-off: the
available games are obvious, the next action is immediate, and the EuroLeague
identity comes from real clubs, players, and competition rather than ornamental
chrome. It is energetic without shouting, compact without becoming cramped,
and tactile without imitating an arcade cabinet.

The home page is a launcher first at every viewport. All five games remain
visible in one focused column, and the first playable action fits inside the
initial phone viewport. Supporting rules and mode explanations never push game
choice below the fold; reveal them after the user has chosen a direction.

**Key Characteristics:**

- Basketball-specific identity through club marks, game names, and real data.
- One obvious primary action, with quieter alternatives.
- Compact mobile hierarchy and comfortable 44px minimum touch targets.
- Restrained surfaces, strong text contrast, and state-driven motion only.

## Colors

The palette uses crisp slate neutrals with a single orange action voice. Blue,
red, green, and amber are reserved for ownership and semantic game states.

### Primary

- **EuroLeague Orange:** `brand-orange` carries decorative identity, borders,
  icons, and restrained tints.
- **Tip-Off Orange:** `action-orange` is the accessible fill for primary
  actions; `action-orange-hover` is its deliberate hover and pressed depth.

### Secondary

- **Home Blue:** `player-one` identifies Player 1 and related ownership.
- **Away Red:** `player-two` identifies Player 2 and destructive emphasis.
- **Win Green / Warning Amber:** `success` and `warning` communicate game state,
  never decoration.

### Neutral

- **Scoreboard Ink:** `ink` is for display headings and highest-emphasis text.
- **Play Text:** `text` is the default readable UI copy.
- **Commentary Gray:** `muted` is the accessible secondary-copy color.
- **Arena Canvas / White Surface / Court Line:** `canvas`, `surface`, and
  `border` establish quiet structural layers.

**The One Orange Voice Rule.** Only `action-orange` carries white text. The
brighter brand orange remains decorative because it does not meet normal-text
contrast requirements with white.

## Typography

**Display Font:** Bebas Neue (with Impact fallback)
**Body Font:** DM Sans (with system-ui fallback)

**Character:** Bebas Neue provides compact basketball-poster energy for game
identity. DM Sans keeps rules, controls, player names, and supporting
information neutral and readable.

### Hierarchy

- **Display** (400, 48px, 0.92): rare page identity; on mobile it must not
  consume more than two compact lines.
- **Headline** (400, 36px, 1): screen and flagship-game headings.
- **Title** (400, 24px, 1.1): game launcher labels and card titles.
- **Body** (400, 16px, 1.5): instructions and supporting copy, capped at 70ch.
- **Label** (700, 12px, 0.05em): short controls and status labels only.

**The Play Before Prose Rule.** On phones, reduce or remove explanatory copy
before reducing actionable labels below a comfortable reading size.

## Elevation

The system is structurally layered, not glossy. White surfaces use a quiet
border at rest and shallow ambient shadow only where separation is necessary.
Hover elevation is a desktop affordance; mobile hierarchy comes from spacing,
contrast, and selected state.

### Shadow Vocabulary

- **Resting Surface** (`0 1px 3px rgb(0 0 0 / 0.10), 0 1px 2px -1px rgb(0 0 0 / 0.10)`):
  home game surfaces.
- **Raised Setup** (`0 10px 15px -3px rgb(0 0 0 / 0.05)`): focused setup cards
  against the canvas.

**The Flat-By-Default Rule.** Shadows clarify hierarchy; they never substitute
for a clear primary action.

## Components

Components are compact, familiar, and tactile. Every interactive element must
have visible focus, active, disabled, and loading behavior.

### Buttons

- **Shape:** gently rounded rectangle (`button`, 8px).
- **Primary:** `action-orange` with white text, at least 44px tall on touch
  surfaces.
- **Hover / Focus:** darken to `action-orange-hover`; use the existing orange
  focus language without changing layout.
- **Press:** respond on pointer-down with `scale(0.98)` and a 120ms strong
  ease-out release. Under reduced motion, retain color feedback without scale.
- **Secondary / Ghost:** quiet text or bordered controls; never compete with the
  screen's single primary action.

### Chips

- **Style:** compact pills with a pale semantic tint, matching border, and
  high-contrast label.
- **State:** selection is communicated by border, fill, and text together, not
  color alone.

### Cards / Containers

- **Corner Style:** softly rounded (`surface`, 16px).
- **Background:** white `surface` over `canvas`.
- **Shadow Strategy:** shallow and structural.
- **Border:** one-pixel `border`.
- **Internal Padding:** 24px desktop; 16px mobile where density improves launch
  speed.

### Inputs / Fields

- **Style:** two-pixel `border`, `canvas` fill, 12px radius, and at least 44px
  height.
- **Focus:** orange border with a clear outline treatment.
- **Error / Disabled:** preserve readable text and expose state beyond opacity.

### Navigation

Navigation uses the compact logo or a plain Home control. On mobile, it must
not create a second hero above the task.

### Game Launcher

The flagship game receives the only filled primary action. Other games remain
one-tap targets with short names and one-line mode labels. The same focused
launcher is used on phone and desktop; detailed rules belong in setup or
onboarding, not on the home screen.

**Motion:** The launcher arrives as one unit over 220ms with opacity plus a
6px/0.995 settle using the shared ease-out-quint curve. Rows never stagger or
delay interaction. Fine pointers receive a 2px hover lift; every pointer receives
the 0.98 press response. Reduced motion uses a 120ms opacity-only arrival and
color-only press feedback.

## Do's and Don'ts

### Do:

- **Do** expose a playable action within the first 844px phone viewport.
- **Do** preserve 44px minimum touch targets and WCAG AA text contrast.
- **Do** use real EuroLeague clubs, players, and competition states as visual
  personality.
- **Do** keep one clear hierarchy: flagship first, alternatives easy to scan.
- **Do** honor `prefers-reduced-motion` while retaining understandable state
  changes.

### Don't:

- **Don't** build a text-heavy landing page that explains the product before
  exposing a playable action.
- **Don't** use oversized mobile typography that pushes the game launcher below
  the fold.
- **Don't** create a generic card dashboard where every game has equal visual
  weight and no obvious starting point.
- **Don't** add decorative motion that delays frequent actions or makes game
  information harder to read.
- **Don't** use bright `brand-orange` as a white-text button fill.
