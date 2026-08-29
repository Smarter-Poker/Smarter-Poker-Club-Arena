# The chooser could never choose, and the card floor was the rejected card

Two reports from Dan on a phone, 2026-08-28 evening, with a screenshot of a live
all-in.

---

## 1. "You can't click run it once, twice or 3 times"

Verbatim: _"the 'run it twice' pop up is blocked and you can't click run it once,
twice or 3 times. It's cut off ... Also this card says 'kingfish offers to run it
twice'. I didn't offer anything yet, but that's the pop up on screen."_

### It was not cut off. There was nothing there to cut off.

One line, in `TablePage.tsx`:

```ts
const [ritChosenRuns, setRitChosenRuns] = useState<2 | 3>(2);
```

`RunItTwicePrompt` chooses its face with `isChooserPhase = isChooser &&
!chosenRuns` — _"I am the chooser and nothing has been chosen yet"_. A `2` that
really means "no answer yet" makes that **false on the first render**, so the
chooser's panel skipped its own question and fell through to the branch below
it, `isChooser && !!chosenRuns`, which is the **waiting** state. The Run Once /
Run It Twice / Run It 3 Times buttons have been unreachable code since FIX 188
wrote them. Nobody has ever pressed one.

The same phantom answer wrote the sentence Dan quoted. The message reads
`${opponentName} Requests To Run It ${runsLabel}`, and `ritOpponent` is set to
the **chooser's** display name — so a chooser was told, by name, that he had
requested something he had never been offered the chance to request.

**Fixed:** the state carries the third value (`2 | 3 | undefined`, initialised
`undefined`) and is cleared in **both** places that begin a RIT question —
`resetRitPanelState` (hand boundary) and the `rit_offer` handler, which resets
every other panel field and missed only this one. A stale `2` surviving into the
next offer would put the next chooser straight back into the waiting state.

The sentence is fixed separately, because it would still have been wrong the
moment he _did_ answer: a chooser is now addressed in the second person ("You
Asked To Run It Twice"), a responder still gets the name.

### The consent sheet was rendering somebody else's hand

`TableModalsLayer` declared six of `RunItTwicePrompt`'s props and forwarded
none of them: `boardCards`, `players`, `potAmount`, `totalSeconds`,
`heroAccepted`, `currency`. Every one fell to its default, so the panel drew

- **five face-down slots** over a flop that was already on the felt (the
  screenshot shows exactly this),
- no pot line,
- **no per-player consent rows at all** — the entire point of the 2026-08-26
  PokerBros parity pass,
- a countdown bar measured against a hardcoded 25s rather than the table's own
  window.

`ritPanelPlayers` and `ritPanelBoardCards` are `useMemo`s in TablePage that were
recomputed on every render and thrown away. They are wired now.

### And it genuinely was too tall for a phone

Three faults in `RunItTwice.css`, all of which matter because this panel has a
25-second engine deadline on it and a decision you cannot reach is a decision you
lose by default:

1. **`vh` on iOS is the LARGE viewport.** Safari resolves `vh` against the
   screen with the URL bar retracted, so `max-height: 86vh` is 86% of something
   the player cannot currently see all of — and the bottom of the panel is where
   the actions are. Now `dvh`, with `vh` left in front as the fallback.
2. **A centered flex item taller than its container overflows both ends**, and
   the top overflow cannot be scrolled back to. The overlay scrolls now and the
   panel uses `margin: auto`, which centers while it fits and top-aligns when it
   does not.
3. **Three buttons did not fit one row.** At a flat `min-width: 108px` they need
   3x108 + 2x10 = **344px** against the **312px** a 340px panel has inside its
   padding, so the third wrapped to a line of its own — and that extra line is
   what pushed the row past the bottom of a panel already mis-sized by `vh`.
   They share the row now (`flex: 1 1 0`, 88px floor, 44px minimum touch
   target), and the row is `position: sticky` so it cannot scroll out from under
   a running countdown.

### Measured, not reasoned about

`scripts/dev/measure-rit-panel.mjs` is new: it loads the real stylesheet at five
phone viewports x 2/5/9-way all-ins and reports whether every button is inside
the visible viewport and hittable. All 15 combinations: **one button row, 44px+
tall, zero off screen**, including a 9-way all-in on a 320x568 screen.

`tests/unit/ritChooserCanActuallyChoose.test.tsx` (10 beats) pins the behaviour,
the state shape, the prop wiring and all four CSS facts above.

---

## 2. "The cards in NLH have regressed back to the smaller sized hero cards"

Verbatim: _"the size of the cards in NLH have regressed back to the smaller sized
'hero cards' and board cards. Make them the same size as the PLO cards, then
prevent them from regressing again."_

Hold'em and PLO4 read the **same token** — `--sp-card2-w` — and had done since
#1571 that morning. That part was true and passing.

What no test could see is that the token has a **floor**, and the floor was
**44px**: the exact hold'em card Dan had rejected twelve hours earlier, the one
that "sat beside a 60px PLO4 card for nine days". So hold'em and PLO were equal
and **both were back at the rejected size wherever the floor bound**. Measured
with `scripts/dev/measure-felt.mjs`:

| Device            | Felt  | Fraction asks | Drew             |
| ----------------- | ----- | ------------- | ---------------- |
| iPhone SE 375x667 | 286.7 | 39.8px        | **44px** (floor) |
| iPhone landscape  | 96.0  | 13.3px        | **44px** (floor) |
| iPad landscape    | 308.1 | 42.8px        | **44px** (floor) |
| laptop 1280x800   | 323.9 | 45.0px        | 45px             |

— and, worse, on **every device for the first frame of every table**:
`scalerSize` in TablePage initialises to 320px and a ResizeObserver cannot report
before layout, so `320 x 0.139 = 44.5px` is what a hand started at everywhere.

**Fixed:** the floor is **50px**. The `--table-w` fallback moves
`360px -> 380px` for the same reason, so a `.seat` rendered before the observer
reports lands on the fraction rather than on top of the floor. Above the floor
the proportional rule from #1650 is untouched; below it, the only direction
available is bigger.

**Why 50 and not the 51 Dan approved**, which is the interesting part. 51 is the
#1571 phone rung, and the canonical iPhone 12/13/14 felt yields
`366 x 0.139 = 50.87` from the fraction. A floor AT 51 would therefore bind on
the canonical device — by 0.13px, invisible on screen — and
`tests/e2e/table-proportions.spec.ts` excuses a floor-bound device from every
flatness assertion it makes, because a floor is by definition what stops a
proportion. That would drop the most-reviewed device in the estate out of the
guard proving the proportion still holds, to buy one pixel nobody can see. The
crossover belongs just under the canonical answer, not on top of it. If the card
ever needs to be bigger, the thing to raise is the **fraction**, and the unit
guard now says so in its failure message.

Every card grows or stays where it is. Nothing shrinks:

| Device            | Before | After |
| ----------------- | ------ | ----- |
| iPhone SE         | 44     | 50    |
| iPhone landscape  | 44     | 50    |
| iPad landscape    | 44     | 50    |
| laptop 1280x800   | 45     | 50    |
| iPhone 12/13/14   | 50.9   | 50.9  |
| iPhone 14 Pro Max | 56.4   | 56.4  |
| iPad Pro 12.9     | 93.1   | 93.1  |

### "Prevent them from regressing again"

`tests/components/HeroCardRowGeometry.test.tsx` gains
`never draws a card smaller than the size Dan approved, on any felt`. It fails
**both ways**: if the floor drops back towards 44, and if it reaches the
canonical felt's own answer — which would make the floor the size, the
proportion decorative, and the canonical device invisible to the flatness guard.
It also fails if the `--table-w` fallback lands under the floor.

The floor is restated in two e2e specs and all three moved in this commit, per
CLAUDE.md rule 8: `CARD_FLOOR_PX` in `hero-card-row.spec.ts` and `CARD_FLOOR` in
`table-proportions.spec.ts`.

### One latent flaw the new floor exposed, fixed with it

`hero-card-row.spec.ts` compared `offsetWidth` — an **integer** by definition —
against `expectedCardW(felt) * 0.95` with `toBeCloseTo(want, 0)`, i.e. a
difference strictly under 0.5. That tolerance is one the measurement cannot
honour: whenever the expectation falls on an exact half, the rounded integer is
0.5 away and the assertion fails on arithmetic rather than on layout. The 50px
floor put PLO5 at the small-phone felt on exactly 47.5 and turned it red.

The row is measured by its layout box deliberately (the held-hand arc rotates the
visual bbox), so the integer is not negotiable and the tolerance had to be. 1px
now, which still catches everything this beat is for: the sizes it pins are
26-100px apart and the failure mode is a reintroduced breakpoint, which moves a
card by six pixels or more, never by one.

### And the process failure worth recording

The first push of this branch went red. `npx vitest run tests/` (8561 tests) and
`hero-card-row.spec.ts` were both green locally, and I pushed on that — but the
**CSS Beat E2E** job runs four specs, and `table-proportions.spec.ts` was not one
I had run. It is the one that guards exactly what I changed. Running the one spec
whose name matches the file you edited is not the same as running the job that
gates it; the job's own command line is in `ci.yml` and is the thing to copy.

---

## What I did NOT change, and why

**The board cards.** Dan reported these small in the same hand. Two facts, both
measured:

- The **single** board already takes every pixel available.
  `tests/unit/mobileBoardAndActionBar.test.ts` recomputes the ceiling from the
  shipped seat rings on every run — "takes every point of the ceiling except the
  daylight Dan asked to keep" and "the ceiling has not quietly fallen back under
  the shipped width" both pass. 95% of the felt is the cap, and it is at it.
- A **run-it-twice** hand is different: `.table-page[data-boards] .community-area`
  drops the stack to **68%**, so every board card in a multi-board runout is ~30%
  smaller. That is deliberate and documented — a stack spans roughly y 20..70% of
  the scaler and so has to clear the side seats on X, which the single row does
  not. Raising it is a **seat-geometry** change, not a stylesheet one, and it
  needs the same treatment #1571 gave the board band. Flagged for Dan rather than
  done here.

Note also that `data-boards` is only set once there is more than one board on the
felt, so it was **not** in effect in the screenshot Dan sent (that is the offer,
before any runout). If the board looked small there, it is the felt itself, and
that is the seat-ring question above.

`RunItTwiceResult` in `RunItTwice.tsx` has zero call sites — `ritResult`,
`onRitResultClose` and `ritResolveName` are threaded into `TableModalsLayer` and
never used, because the live multi-board surface is the felt (`ritBoardsView`).
Noted, not deleted: out of scope for a bug report about a consent panel.
