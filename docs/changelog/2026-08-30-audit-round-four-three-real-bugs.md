# 2026-08-30 — Line-by-line audit of the day's work: three real bugs, plus a red main

Dan: "go through it all line by line, check for any bugs, stubs, gaps, errors,
regressions or wiring issues." Four things came out of it. Three are bugs I
either shipped or walked past today; one was already red on main and had to be
fixed first (fix-first, CLAUDE.md section 4).

## 1. The notch fix applied everywhere except the screens that have a notch

`.table-tab-bar`'s base rule was moved to
`padding-top: calc(6px + var(--sp-tabbar-inset, env(safe-area-inset-top, 0)))`
so whichever strip touches y=0 pays the inset once. **The `<= 480px` override
was left on the raw `env()`.** 375px is the design width, so the double-inset
band survived on exactly the devices with a notch. Both declarations read the
property now, and the pin walks every `padding-top` in the file rather than
checking one of them.

## 2. The pinned action bar paid a notch the global header had already paid

`.multi-table-page__tab-bar-wrapper--pinned` zeroes its own `padding-top` with
the comment "The global header already owns the notch inset". That was only
half the job: the `.table-tab-bar` INSIDE it pays its own
`env(safe-area-inset-top)`, and the wrapper is fixed at
`var(--ca-global-header-height)` — a height `GlobalHeader.tsx` publishes from
`getBoundingClientRect()` **after** `GlobalHeader.module.css` has already padded
by that same inset. On a notched iPhone the lobby's action bar sat ~47px low
with a dead black band above it.

One declaration fixes it, and only because of the property introduced this
morning: `--sp-tabbar-inset: 0px` on the pinned wrapper. Scoped there, so the
in-flow bar on `/table/*` still pays the notch when nothing above it has.

## 3. The connection banner left the wordmark behind on multi-board tables

The banner was anchored at a literal `top: 52%` — six points above the felt
wordmark's `58%`. Correct for a one-board table and wrong for every other kind:
`.table-page[data-boards='2'] .table-brand` moves the masthead to **72%** and
`[data-boards='3']` to **84%**. So on a run-it-twice or bomb-pot table the
banner floated up to a third of the felt above the mark it is supposed to sit
on, in the middle of the board stack — on precisely the tables where losing the
connection costs the most.

Fixed by giving them one anchor instead of two literals:

- `--sp-brand-top: 58%` is declared on `.table-surface`, the nearest common
  ancestor of both elements;
- `.table-brand` uses `top: var(--sp-brand-top, 58%)`;
- the banner uses `top: calc(var(--sp-brand-top, 58%) - 6%)`;
- the `[data-boards]` overrides now set `--sp-brand-top` on `.table-surface`
  rather than `top` on the wordmark, so both move together.

CSS-declared, never written from JavaScript, and not part of the felt's size
expression — `feltReserveIsStatic.test.ts` stays satisfied.

## 4. Main was red, and not from anything of mine

`tests/unit/noFixedSizeSourceWindows.test.ts` was failing on
`satelliteDoubleQualification.guard.test.ts:71`, which bounded a source window
with `MANAGER.slice(at, at + 2000)`. The rule it breaks is a good one and it
bites here specifically: the comment block inside that branch is ~1,100
characters on its own, so a few more lines of explanation would have pushed the
`payCash` call out of the window and the pin would have passed while asserting
nothing.

Replaced with `sliceEnclosingBlock(MANAGER, 'held_from_this_satellite === false')`
— bounded by the branch, not by a byte count. The import carries its `.js`
extension, which `TournamentFixes.guard.test.ts` requires of every relative
import in `server/` (caught on the second run, fixed before shipping).

**Then PR #1975 landed the same fix independently**, importing the extractor
from a server-local `../testHelpers/sourceWindow.js` rather than reaching up
into `tests/`. That is the better home for it, so on the merge this branch took
THEIRS and dropped its own copy. Recorded because the diff no longer shows the
work: main was red, it is green, and it took two of us to notice.

## Pins

`tests/unit/mttTickerAnchor.test.ts` gains three, and
`tests/table-says-when-it-is-reconnecting.test.tsx` one:

- **the notch is paid once at EVERY breakpoint** — walks every `padding-top`
  with a safe-area term in TableTabBar.css and requires each to read the
  property, so a future breakpoint cannot reintroduce the raw `env()`.
- **the pinned bar does not pay a notch the global header already paid.**
- **the banner and the wordmark share one anchor** — including
  `expect(TABLE_PAGE_CSS).not.toMatch(/\.table-brand \{[^}]*top:\s*\d+%/)`, so
  the literal that let them drift apart cannot come back.
- the banner spec now requires the `calc(var(--sp-brand-top, 58%) - 6%)` form
  and explicitly rejects the old literal `52%`.

## 5. Dead code the audit turned up in today's own files

`eslint` on the files this work touched reported four unused bindings, all of
them left behind by earlier changes rather than by anything today:

- `RabbitHunt.tsx` — `toCardImage` and `normalizeRank`, plus the `CardImage`
  value import that fed them. POKERBROS PARITY 2026-08-26 moved the reveal onto
  the CommunityCards board; the component has drawn no card since, so the pair
  had no call site and the import was pulling the CardImage module into the
  Rabbit Hunt chunk for nothing.
- `RabbitHunt.tsx` — `revealedCards` was read nowhere. The state is write-only
  BY DESIGN (TablePage renders the reveal via `rabbitCards`), and the setter
  still matters because clearing it on a new hand is what stops the previous
  hand's cards being offered again. Now `const [, setRevealedCards]`, with the
  reason written down instead of looking like an oversight.
- `TournamentStartingTicker.tsx` — the `OverlayState` interface, unreferenced.

## Verification

- Client suite: **9693 passed / 9693** (668 files).
- Server suite: **2701 passed / 2701** (241 files).
- `eslint` clean on every file this work touched.
- `tsc --noEmit` clean.

A note for whoever runs the suite in a worktree: symlinking `node_modules` from
the main clone when the directory already exists creates
`node_modules/node_modules`, React resolves twice, and ~106 rendering tests fail
with "Invalid hook call". That is the symlink, not the code.
