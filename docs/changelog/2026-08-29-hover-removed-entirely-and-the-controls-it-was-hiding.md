# Hover removed entirely, and the four controls it was hiding

**Date:** 2026-08-29
**Dan:** "Remove hover entirely, everywhere."

## What this finishes

Three earlier passes each took a slice and stopped:

| PR    | Scope                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------- |
| #1689 | hover MOTION (transform/scale/translate/rotate) and the shadows in those same blocks, 266 stylesheets |
| #1693 | everything hover, but only on the lobby, 8 stylesheets                                                |
| #1697 | 179 empty `:hover {}` shells, 26 JS handlers mutating `.style`                                        |

What survived all three was every hover rule that changed only colour,
background, border, filter, opacity or z-index, anywhere outside the lobby —
**1,014 `:hover` rules across 349 stylesheets**, including the global sheets
(`globals.css`, `design-system.css`, `club-engine.css`) that #1693 could only
work around rather than fix.

This pass removes all of it. **937 rules deleted, 44 selector lists pruned, 1
empty at-rule dropped, 349 files.** After it there is no `:hover` selector left
anywhere in `src/` — the three remaining textual matches are all inside
comments, and all three of those comments were rewritten because they described
rules that no longer exist.

## The part that is not a sweep

Four controls were **invisible at rest** and painted in only by a hover on
their parent row. Deleting the hover rule under those does not remove a
flourish, it removes the button:

| File                                              | Control          | Was          | Now   |
| ------------------------------------------------- | ---------------- | ------------ | ----- |
| `components/players/PlayerNotes.css`              | `.delete-btn`    | `opacity: 0` | `0.7` |
| `components/search/RecentSearches.css`            | `.remove-btn`    | `opacity: 0` | `1`   |
| `components/gameplay/PlayerNotesPanel.module.css` | `.deleteBtn`     | `opacity: 0` | `0.6` |
| `components/notifications/NotificationItem.css`   | `.notif-dismiss` | `opacity: 0` | `1`   |

Every one is a delete or dismiss button — the only way to remove the thing it
sits on. **None of them worked on a phone before this commit**, because a phone
cannot hover, and the panel two of them live in is a table-side panel that is
mostly used on a phone. This is a bug fix that the hover removal happened to
surface, not a side effect of it.

Two more elements were revealed only by hover and are decoration, so they are
now simply never painted: `.lock-overlay` in `VIPBenefitsGrid.css` (locked
cards already read as locked — `.benefit-card.locked` dims them to 0.5) and
`.glowEffect` in `MetalIconBox.module.css`. Both are dead CSS now; deleting the
markup is a separate tidy-up, listed under "not done".

## What was deliberately kept

- **`:focus-visible`.** Where a selector list paired the two, the `:hover`
  branch was pruned out and the focus branch kept. Removing hover makes focus
  the only state a keyboard user has, so taking it would have been the worse
  bug. 44 lists were pruned this way rather than deleted.
- **`:active`.** A real press, and it fires on touch. This is where interaction
  feedback lives now.
- **`@media (hover: none)` / `(pointer: coarse)`.** A capability query, not a
  state — `portraitLock` uses it to identify a phone. It styles nothing.
- **`onMouseEnter` for route prefetch.** `ChunkPreloader`, `handleItemHover` in
  `HamburgerMenu` (7 sites), `prefetchMessenger` in `GlobalHeader`,
  `preloadRoute` in `HomePage`. They warm a chunk and paint nothing, and each
  is paired with `onTouchStart`/`onFocus` so touch and keyboard get the same
  head start. The 7 HamburgerMenu handlers were simplified from
  `(e) => { handleItemHover(...) }` to `() => handleItemHover(...)` — the event
  argument had been left over from the style mutation #1697 removed.
- **`onMouseEnter` that shows DATA.** Chart and heatmap tooltips
  (`ActivityHeatmap`, `PositionalRadar`, `PositionWinRates`, `HoleCardHeatmap`),
  the training `RangeViewer`, the star-rating preview, and combobox highlight
  sync (`Search`, `FindPlayerModal`, `AdminCommandPalette`). These deliver
  information or move a selection; they are not a paint of the hovered element.
  They do still need a non-pointer route on touch — that is real work, listed
  under "not done", and not a licence to restyle.

## The sweep tool, and the four ways it was wrong first

The edit was mechanical, so it was done by a script — but the script was wrong
three times before it was right, and every failure is a trap worth recording.

1. **Comments must be masked before matching.** Known already (a 2026-08-28
   sweep cut `ClubBottomNav.module.css` in half on a `:hover` inside a comment).
   Masking replaces comment bodies with spaces so byte offsets still line up.
2. **A selector list must be split on the MASKED text, and by offset.** The
   first version split the raw prelude and the masked prelude independently and
   zipped the two lists. A prelude carries the rule's leading comment, comments
   are full of prose commas, so the two splits produced different part counts,
   the indices stopped lining up, and a rationale block in
   `ClubBottomNav.module.css` was rewritten into fragments. Fixed by splitting
   once, on the mask, and slicing the original at the same offsets.
3. **A rule's leading comment goes with it, but only the part that is about
   hover.** The first fix tested the whole leading run for `/hover/i` and so
   deleted the "Baked-nameplate clip for the /avatars/table/ family" block in
   `SeatSlot.css` — 12 lines of asset facts that mention hover nowhere — because
   a hover comment happened to follow it. Now the comments are walked backwards
   and only the trailing run that actually mentions hover is taken.
4. **An empty block that was already empty is not ours to delete.** The sweep
   was removing 41 pre-existing empty rules, which is unrelated cleanup
   smuggled into a hover diff, and at least one of them held a comment that was
   the point of it. The sweep now records which blocks are empty before it
   starts and leaves those alone. That count went 41 → 0, i.e. every one of
   them was pre-existing.

The script also never writes `transform: none` — a rule is deleted, never
neutralised. Several elements here carry a base `translate(-50%, -50%)` and
`none` yanks them out of position.

## Tests

Two tests pinned hover rules this commit removes, and both were rewritten **in
the same commit** (CLAUDE.md section 5 rule 8) to pin the new rule rather than
deleted:

- `tests/unit/pokerbrosWinnerPresentation.test.ts` — asserted
  `.community-cards__card--dimmed:hover` and `--highlighted:hover` EXISTED.
  They were counter-rules cancelling a base hover lift during the winner
  tableau. The base rule is gone, so there is nothing to cancel. The property
  being protected — a pointer must not disturb the tableau — is now pinned more
  strictly: no `:hover` in that stylesheet at all.
- `tests/unit/metallicPopupSystem.test.ts` — asserted
  `button:hover:not(:disabled)`. Now asserts `button:active:not(:disabled)`,
  which is the state that was always doing the work on a phone, plus a new case
  that the sheet has no hover to fall back on.

New law: **`tests/no-hover-effects.law.test.ts`**. It scans every stylesheet
under `src/`, masks comments, and fails on any `:hover`. It also asserts it
found more than 300 files (zero files scanned is zero violations found — the
same trap as the 2026-08-21 case-sensitivity failure), that `:focus-visible`
and `:active` survived, and that the four controls above are visible at rest.

Verified the law fails without the fix, per the rule that a test which passes
either way pins nothing: re-adding one hover rule and dropping `.delete-btn`
back to `opacity: 0` turns exactly those two assertions red.

Full suite: **560 files / 8,584 tests passing.** `npx tsc --noEmit` exit 0.

## Not done

- The hover-driven tooltips and chart readouts listed above have no touch
  equivalent. On a phone that data is unreachable today, and was before this
  commit too. Worth a pass of its own.
- `.lock-overlay` and `.glowEffect` are now painted-but-never-visible nodes.
  Removing the markup is a small tidy-up in `VIPPerksGrid`/`VIPBenefitsGrid`
  and `MetalIconBox`.
- Nothing here was rendered at 375px. The change is subtractive on every
  surface except the four opacity bumps, which is why it is being shipped
  without that, but those four are worth a look on a phone.
