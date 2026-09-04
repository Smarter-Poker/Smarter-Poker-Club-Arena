# 2026-09-04 — Round chips at micro stakes, 50% larger corner buttons, one Bomb Pot marker

Dan, with a screenshot of a 0.10/0.25 NLH hand preflop:

> "WHY ARE THE CHIPS, OVAL SHAPED NOW PREFLOP INSTEAD OF CIRCLES? THE APPEAR
> NORMAL ON ALL OTHER STREETS... FIX THIS BUG PLEASE. 2, THE PREVIOUS HANDS,
> CHAT, LOBBY BUTTON (FOR TOURNAMENTS) AND RABBIT HUNT BUTTONS ALL NEED TO BE
> 50% LARGER AS WELL."

And, mid-session:

> "AND THERE SHOULDN'T BE 'BOMB POT PILL BUTTONS' UNDER THE PLAYERS. THERE
> SHOULD JUST BE SOMETHING ON THE TABLE THAT SAYS 'BOMB POT'."

## 1. The oval chips

Not an animation and not a street-specific branch. `.cp-chip--partial` in
`ChipPhysics.css` drew the disc that stands in for a sub-1 bet at 55% height,
with a dashed rim and 75% opacity; `.pot-display__pile-chip--partial` did the
same to the pot's disc at 37.5% height. The reasoning in the file was that
Dan's ladder has nothing under the white 1, so a full white chip for a 0.5
blind "would claim twice its value".

At 0.10/0.25 EVERY preflop bet is under 1 - the 0.10 blind, the 0.25 blind, a
0.50 open, the 0.25 call - so every chip on the felt was an oval until the
pot crossed a chip on the flop, at which point they all snapped round. That is
exactly "oval preflop, normal on other streets". The value was never carried
by the disc's shape: `.cp-amount` prints the exact figure beside it.

Fix: the partial disc is a full, round, white chip in both places. The
`partial` flag survives on the visual as data - it is what keeps 7.5 at three
chips rather than four - but it no longer changes how the disc is drawn.

- `src/components/table/ChipPhysics.css` - `.cp-chip--partial` is
  `height: var(--cp-chip-size)`, nothing else.
- `src/components/table/PotDisplay.css` - same for the pot pile.
- `src/lib/chipDenominations.ts` - header and `partial` doc updated so the
  next reader does not restore the sliver from the comment.
- `tests/chips-on-the-felt.test.tsx` - the "sliver, not a white chip" pin is
  replaced by two: the sub-1 disc is white and carries its label, and both
  partial rules restate the chip's own height with no fraction, opacity or
  dashed rim. `tests/unit/chipDenominations.test.ts` title updated.

## 2. The corner buttons

All four of the controls Dan named are the same 44px tile language:
`--sp-hud-tile-size` (TableHUD.css) sizes the previous-hand card, the Rabbit
Hunt button and the time-bank tile; `.chat-collapsed` (TableChat.css) is the
same 44px by the 2026-08-28 parity rule. 44 -> 66, radius 12 -> 18, in both
files. The time-bank tile moves with them because it shares Rabbit Hunt's
slot: a 44px clock replaced by a 66px rabbit is the corner changing shape at
the end of every hand, the 2026-08-27 bug again.

`PreviousHandCard.css` carried a `min-width: 1024px` block reading
`--sp-hud-tile-size-lg` with a 44px fallback. Nothing declares that token, so
the fallback would have held the desktop tile at 44 while the real token
moved. Removed; one token, every width.

### Geometry, measured rather than assumed

`tests/all-in-cannot-leave-and-the-hud-slot.test.ts` pinned
`--sp-hero-clear >= tile + 8`, i.e. that the corner row fits under the felt's
bottom edge. A 66px row (74px above the bar) is nominally taller than the
50-68px reserve. Rendered in the felt harness with the real stylesheets and a
2-card hero, at 375 / 390 / 430 / 768 / 900 / 1280 and with real iPhone insets:

| width | felt bottom above bar | rabbit tile right edge | hero avatar left edge |
| ----- | --------------------- | ---------------------- | --------------------- |
| 375   | 98px                  | 142                    | 152                   |
| 390   | 99px                  | 142                    | 154                   |
| 430   | 106px                 | 142                    | 170                   |
| 768   | 117px                 | 144                    | 325                   |
| 1280  | 109px                 | 144                    | 606                   |

The tiles are below the felt everywhere (the phone felt is width-bound and
floats above the reserve line), and the row stays clear of the hero block
beside it. The chat tile is top-right on phones (x >= 318 at 390) and on the
bottom line at `right: 8px` on desktop, nowhere near the hero's cards either
way. The test now pins what actually protects the hero: the corner is a ROW
(two tiles sideways, never a column of them), and the token is 66.

### The tournament lobby button

On a tournament the only lobby control is the level bar (`TournamentHUD`):
Dan 2026-08-30, "IF YOU CLICK THE LEVEL TAB BUTTON IT WILL OPEN TO THE
TOURNAMENT LOBBY INSTANTLY", and the separate MiniStatsCard lobby icon was
removed the same day. It stands in the corner the chat button occupies on a
cash table. It is scaled 1.5x from 1200px up.

**Below 1200px it is left as it was, and this is the paragraph Dan can
overrule.** Measured on the live DSS Bounty Hunter table by setting the
transform in place and reading the seat boxes back:

| viewport  | bar at 1.5x (left edge, bottom) | top-right seat           | result  |
| --------- | ------------------------------- | ------------------------ | ------- |
| 1366x1024 | x=865, y=169                    | ends x=836               | clear   |
| 1280x800  | x=779, y=134                    | ends x=762               | clear   |
| 1024x768  | x=523, y=134                    | x 535-631, top y=112     | COVERED |
| 390x844   | (0.74 today) left edge x=148    | top-LEFT seat ends x=146 | 2px     |

The bar is anchored at `top: 54px` and the top seats start at y=112 on every
width, so a 1.5x bar (80px tall, bottom at 134) paints the level clock over
the top-right player's avatar wherever it horizontally reaches that seat,
which it does on every width under ~1200. On the phone the current 0.74 is
already the largest scale that clears the top-LEFT player by two pixels, and
a phone felt is edge-to-edge so there is nowhere to move the bar to. A level
clock over a seated player's face is a worse table than a small clock.

If Dan wants it larger on the phone or the tablet anyway, the options are:
(a) accept the covered seat (one-line change, the scales are in
TableHUD.css), or (b) redesign TournamentHUD as a two-row or compact bar,
which is a component change rather than a scale. Neither is taken on my own
authority.

## 3. One Bomb Pot marker, on the felt

During a bomb-pot hand every live seat grew a magenta "BOMB" pill
(`.seat__bombpot-badge`, driven by SeatSlot's `bombPotAnte` prop) and the
on-felt countdown pill (`.bomb-pot-eta`) hid itself for the duration. That is
the opposite of what Dan asked for.

- `SeatSlot.tsx` / `SeatSlot.css` - the per-seat pill, its keyframe and the
  `bombPotAnte` prop are deleted (tombstone left on the props interface).
- `TablePage.tsx` - `.bomb-pot-eta` no longer hides while `bombPotActive`;
  it stays up through the hand and reads "BOMB POT" (prefixed "DOUBLE BOARD"
  / "TRIPLE BOARD" as the other states already do), with a
  `bomb-pot-eta--live` modifier. The urgency pulse (`--next`) never applies
  during the hand itself.
- `TablePage.css` - `.bomb-pot-eta--live` carries the magenta the seat pills
  used, so the hand still reads as the bomb pot at a glance, without a pulse
  (the bomb has arrived; there is nothing left to warn about).

The BombPotOverlay announcement at the trigger is untouched.

## Verified

- `npx vitest run tests/chips-on-the-felt.test.tsx tests/unit/chipDenominations.test.ts tests/all-in-cannot-leave-and-the-hud-slot.test.ts tests/unit/tableChatSheet.test.tsx tests/shipped-invariants.test.ts tests/unit/tourneyUxSweep20260825.test.tsx tests/unit/bombPotGuards.test.ts tests/seatslot-memo-lets-live-props-through.test.tsx tests/seatslot-countdown-duration.test.tsx tests/animations-always-play.law.test.ts` green.
- `npx tsc --noEmit` clean.
- Felt harness screenshots at the widths above (scratch, not committed).
