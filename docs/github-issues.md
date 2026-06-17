# GitHub issue guide

How we write GitHub issues for EuroLeague Quiz. Issues are written so a human —
or our **orchestrator** that turns issues into autonomous coding sessions — can
pick one up and implement it without further clarification. Follow these
conventions for every issue you create.

A good issue is **self-contained**: it states the problem, the agreed design,
the exact scope, verifiable acceptance criteria, and the concrete files to
touch. Avoid open questions — decide and write down the decision (note
alternatives under "Out of scope" or "Notes" if useful).

## Issue types

Pick the shape that matches the work:

| Type | When | Identified by |
|------|------|---------------|
| **Epic** | A large feature spanning multiple PRs/areas; coordinates several sub-issues. | `## Problem / Vision` + a `## Sub-issues (dependency order)` checklist. |
| **Sub-issue** | One shippable slice of an epic (ideally one PR). | A `Parent: #<epic>` metadata line as the **first line**. |
| **Standalone task** | A self-contained bug fix or enhancement with no parent epic. | `## Summary`, no `Parent:` line. |

## Orchestrator-critical conventions

The orchestrator relies on these — keep them exact:

- **Sub-issue metadata line (first line, before any heading):**
  - `Parent: #48` — links the sub-issue to its epic.
  - `Parent: #83 · Depends on #84` — add `· Depends on #A, #B` to declare
    prerequisites that must merge first. Use the middle dot `·` as the separator.
- **Epic sub-issue list** under `## Sub-issues (dependency order)`, in the order
  they should be implemented:
  ```
  - [ ] **#84** — User datastore foundation · _foundation_
  - [ ] **#85** — Backend resource-server auth · _depends on #84_
  - [ ] **#86** — Clerk webhook user sync · _depends on #84, #85_
  ```
  The first item is usually tagged `· _foundation_`; later items carry
  `· _depends on #N_`. Optionally group tasks by letter (A, B, C…) and reference
  those letters from the Scope section.
- **Acceptance criteria** are GitHub task-list checkboxes (`- [ ]`) and must be
  **verifiable** (a reviewer/agent can tick each one). This is the issue's
  definition of done.

## Labels (always set)

Apply, at minimum:

- **Type:** `bug`, `enhancement`, `documentation`, or `type:refactor`.
- **Game scope — at least one:** `game:tic-tac-toe`, `game:roster-guess`,
  `game:higher-lower`, `game:career-quiz`, `game:photo-quiz`, or `game:general`
  (cross-cutting / shared / infra). Use `game:general` for shared/infra work;
  add one or more specific `game:*` labels when particular games are directly
  affected (a cross-game epic may carry both, e.g. `game:general` +
  `game:photo-quiz`).
- **Area — one or more:** `area:frontend`, `area:backend`, `area:realtime`,
  `area:testing`, `area:auth`.
- **`mode:multiplayer`** when it touches online play.

Run `gh label list` to confirm a label exists before using it.

## Title

Short, specific, and scannable. Prefix with the affected surface when it helps,
e.g. `Online Tic-Tac-Toe: …`, `Photo Quiz: …`, `Accounts: …`,
`Quick-match: …`.

## Templates

### Standalone task

```markdown
## Summary
<What's wrong / what we want and why, in 2–4 sentences.>

## Steps to reproduce        ← bugs only
1. …
2. …

## Proposed solution
<The agreed approach. Reuse existing patterns/tokens; name them.>

## Acceptance criteria
- [ ] <verifiable outcome>
- [ ] <…>
- [ ] Tests updated/added and passing.
- [ ] `README.md` and `.github/copilot-instructions.md` updated (if the change
      is significant — API, game mode, architecture, or workflow).

## Touch points (non-binding)
- `path/to/file` — <what changes>

## Out of scope (future/separate)
<Explicitly excluded work.>

## References
- `path/to/related/file`, related issues #NN.
```

### Sub-issue (belongs to an epic)

```markdown
Parent: #<epic> · Depends on #<a>, #<b>

## Problem
<The specific slice this issue solves.>

## Design
<Concrete approach: modules, endpoints, data, reuse.>

## Scope
**In scope:** …
**Out of scope:** … (point to the issues that own the excluded parts)

## Acceptance criteria
- [ ] <verifiable outcome>
- [ ] Tests for the new behaviour.

## References
- `path/to/file`, related issues #NN.
```

### Epic

```markdown
## Problem / Vision
<The big-picture problem and the outcome. Call out hard constraints.>

## Approach (agreed design)
<The locked approach. An ASCII architecture sketch is welcome.>

## Decisions locked (design review)
| # | Decision |
|---|----------|
| 1 | … |

## Scope (v1)
**In scope**
- … (label task groups A, B, C… and map them to sub-issues)

**Out of scope (future epics — seams only now)**
- …

## Sub-issues (dependency order)
- [ ] **#NN** — <title> · _foundation_
- [ ] **#NN** — <title> · _depends on #NN_

## Notes / prerequisites
<Setup, secrets, external accounts, gotchas.>

## References
- Concrete file paths and related epics/sub-issues.

> Planning only — implementation is deferred. This epic captures the agreed
> design and tracks the sub-issues.
```

## Acceptance-criteria checklist (house habits)

Most issues include these where relevant:

- Behaviour is described as observable outcomes, not implementation steps.
- New/changed behaviour is covered by tests (`frontend/src/test/**`,
  `frontend/e2e/**`, `backend/tests/**`).
- Anonymous play keeps working when touching online/identity code.
- `README.md` **and** `.github/copilot-instructions.md` are updated for
  significant features, API changes, game-mode changes, architecture changes, or
  workflow changes (see the matching rule in the instructions file).

## Worked examples in this repo

- **Epics:** [#83](https://github.com/filip998/EuroleagueQuiz/issues/83)
  (Accounts), [#57](https://github.com/filip998/EuroleagueQuiz/issues/57)
  (Photo Quiz).
- **Sub-issues:** [#85](https://github.com/filip998/EuroleagueQuiz/issues/85),
  [#50](https://github.com/filip998/EuroleagueQuiz/issues/50).
- **Standalone task:**
  [#82](https://github.com/filip998/EuroleagueQuiz/issues/82).
