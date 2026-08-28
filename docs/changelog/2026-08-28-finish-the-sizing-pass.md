# Finishing the sizing pass: what a line-by-line audit found afterwards

**Dan, 2026-08-28:** "go through it all line by line, check for any bugs, stubs,
gaps, errors, regressions or wiring issues."

Eight findings. **One is a live regression I introduced and shipped**; two are
animations that have never once played; the rest is dead code that was actively
misleading.

---

## 1. The hero avatar was still on the px ladder, with `!important`

**This is the bad one, and it is mine.** The proportional conversion changed
`--seat-avatar-base` on `.seat` and missed three rules sitting a thousand lines
higher:

```css
@media (max-width: 640|480|380px) {
  .seat.seat--hero {
    --seat-avatar-size: calc(66|58|52px * var(--seat-avatar-hero-ratio)) !important;
    width: ... !important;
  }
}
```

So on every viewport up to 640px, **the hero — the one seat the player is
actually looking at — was still pinned to 66 / 58 / 52px** while every villain
beside it had become a fraction of the felt. The changelog for that pass states
those rungs were "DELETED, not moved." They were deleted from one block and left
standing in another.

It is worse than a leftover, because `--seat-avatar-size` is not a leaf.
`.seat__avatar-wrap`, `.seat__avatar`, the initials glyph, the bust anchoring
and `--vh-card-h` → `--vh-card-w` — **every villain hole card** — derive from it.
A rung on the hero put the villains' cards back on a ladder indirectly, after
`--sp-card2-w` had been converted.

Deleted. Nothing replaces them: the base rule already derives from
`--seat-avatar-base`, so the 1.3333 hero ratio and the 8/7 name-box ratio hold at
every width by construction, which is what the note above that rule already
claimed.

### The guard had a blind spot exactly the shape of the bug

`table-proportions.spec.ts` rendered `.seat` — the villain slot. These rules only
ever matched `.seat--hero`. **A guard that checks one of two seats is a guard for
one of two seats.**

The harness renders both now, and the spec asserts two things, because either
alone passes while the bug is present: the hero must hold `x1.3333` to the
villain (a rung pinning both equally would pass a ratio check), _and_ the hero
must itself be a fraction of the felt (a rung scaling both together would pass
that).

Mutation-tested by restoring one rung:

```
iPhone SE (375x667): hero avatar 88px vs villain 50px = x1.760, expected x1.3333
iPhone 12/13/14 (390x844): hero avatar is 88px on a 366px felt = 24.0%, expected 21.1%
```

## 2. The hero's deal stagger and fold spin have never fired

`seat__cards--dealing` and `seat__cards--folding` are applied to **both**
clusters — the opponent row (`SeatSlot.tsx:1974`) and the hero row (`:2374`).
The rules were:

```css
.seat__cards--dealing .seat__card:nth-child(1) {
  animation-delay: 0ms;
}
.seat__cards--dealing .seat__card:nth-child(2) {
  animation-delay: 100ms;
}
.seat__cards--folding .seat__card:nth-child(2) {
  --fold-spin: -20deg;
}
```

In the opponent row `.seat__card` _is_ the flex child, so they worked. In the
hero row every card is wrapped in a `.seat__card-pick` span (added 2026-08-18 for
click-to-show), so **each card is the only child of its own wrapper**:
`:nth-child(1)` matched every hero card and `:nth-child(2)` matched none.

The hero's two cards have arrived at the same instant since that wrapper landed,
and the "satisfying 1-2 toss" the fold comment describes has never happened —
both cards left together, spinning the same way.

This is the exact trap `HeroCardRowGeometry.test.ts` was written about. The
geometry rules were fixed for it; the **animation** rules were not, so it
survived in the half nobody was measuring. Both now match the row's own child
(`> *:nth-child(n) .seat__card`, plus the bare form). ANIMATION LAW
(CLAUDE.md 10.6): these are owed on every deal and every fold, and now play.

## 3. The two bottom rows disagreed by up to 24px

`ActionPanel.css` has claimed since it was written that the row height "is named
ONCE here and the three consumers read it", naming `.pre-action-bar` second.
**It never did.** `PreActionBar.css` contained no reference to the token — only
literals that happened to agree on a phone.

They stopped agreeing when the action button became `clamp(46px … 72px)`:

| viewport | wrapper floor | pre-action row | dead black |
| -------- | ------------- | -------------- | ---------- |
| 1440px   | 85px          | 61px           | **24px**   |
| 768px    | ~65px         | 53px           | **12px**   |
| 375px    | 52px          | 52px           | 0          |

Only the phone — the one case the comment does the arithmetic for — was right.
Everywhere else the player got a strip of dead black under the pre-action pills:
the same defect Dan reported about the action bar itself on 2026-08-25 ("too much
wasted space at the bottom"), surviving in the row nobody re-measured.

`.pre-action-btn` reads `--sp-action-btn-h` now and the bar reads
`--sp-action-pad-top`, so the claim is true rather than aspirational. Four rungs
deleted — the token interpolates through every value they stated.

**`tests/unit/bottomBarReserve.test.ts` asserts the mirror now.** A comment
cannot enforce one.

### And landscape had the only sub-44px touch target in the product

`TablePage.css`'s landscape block carried `.pre-action-btn { min-height: 40px }`
— **below the 44px minimum touch target**, on the orientation where a thumb has
least room to be accurate, and below the 46px this file calls its minimum three
times. Unlike its `.action-btn` sibling in the same block it was _live_, winning
on cascade order. Deleted; the token's height term already answers landscape.

## 4. Dead code that was costing reading time

- **Four `.seat__card` size rules** (base + 640 / 480 / 380). Every card in the
  DOM is inside `.seat__cards--opponent` or `.seat__cards--hero`, both `(0,2,0)`
  and both setting width/height/radius. These are `(0,1,0)`, and a media query
  adds no specificity — so they described a 30x42 card that has not been drawn
  since the clusters were introduced. The 640px block was self-contradicting: the
  comment nine lines below the dead rule says _"never restate width/height/margin
  on `.seat__card`"_. Anyone deleting the ladder would read the comment, trust
  it, and leave the rule.
- **Six `.pre-action-btn__check` rules**, kept "for backward-compat in case
  downstream styling references them, but are no-ops since the markup no longer
  produces this element" — a note that states plainly they do nothing and keeps
  them anyway. `pre-action-btn__check` appears in **zero** `.ts`/`.tsx` files, so
  nothing can emit it. Two of the six set a 16px/14px size inside media queries
  and read as live responsive geometry.

## 5. A fallback that disagreed with every declared value

`SeatSlot.css` positioned the hero plate with `var(--sp-hero-clear, 34px)` in two
places. The token is declared **60px**, and 68px at ≤480px. A 34px fallback is
roughly _half_ the real value, so anywhere this renders outside a
`.table-container` — a preview, a replay, SimPage, a test harness — the hero plate
sat 26px off, and the number looked deliberate enough that nobody would question
it. Now 60px.

## 6. Two defects in the portrait lock, both mine

- `data-motion="keep"` on the rotating phone. That attribute is the
  reduced-motion **escape hatch**: it means "this animation must survive because
  its DURATION is the information", like a countdown ring. This turn is emphasis
  — the meaning is the phone's upright end state, not how long it took. Reduced
  motion should collapse it, which is what the rule at the foot of the stylesheet
  already does. The attribute claimed the opposite and was a no-op besides.
- `className="portrait-lock__phone"` on the `<rect>`, styled by nothing. A hook
  no rule uses is just a name to grep for later.

---

## 7. The last three felt-internal ladders

- **`--sp-wrap-overlap` had no base declaration at all.** Declared in exactly two
  media blocks (5px at ≤480, 4px at ≤380) and read in three places, every one as
  `var(--sp-wrap-overlap, 6px)`. Above 480px the token was fiction: all three
  readers silently used the literal in their own fallback slot, and it could not
  be changed in one place because there was no place. It is the avatar/name-box
  overlap, so it now derives from the seat's **own** avatar slot — which means
  the hero overlaps its own larger art correctly, something a viewport rung could
  never express.
- **Position chip** — a 22/18/16/14px ladder whose four rungs encoded a
  remarkably steady ratio to the avatar (0.262 / 0.273 / 0.276 / 0.269), so one
  coefficient reproduces all of them. The dealer **puck** on the felt was made
  proportional on 2026-08-25; this chip was not, so the two markers that both
  mean "who is on the button" disagreed about how big that idea is. Its radius is
  a pill now rather than a fixed 10px that squared off as it shrank.
- **Empty-seat art** — 64/52/48/44px, now 0.76 of the avatar with a **44px touch
  floor**. It is the "+ SIT" button and the only thing rendered at six of nine
  positions on an idle table, so the floor is a tap target rather than a
  legibility one.

## A finding I checked and rejected

The audit reported `CommunityCards.css` as "the largest surviving ladder — the
board is sized entirely by breakpoint while everything around it is a fraction of
the felt", and recommended it as the top priority.

**On the felt, that is not true.** `TablePage.css:1784` overrides the board with
`.table-surface .community-cards__card` at `(0,2,0)`:

```css
width: auto;
height: auto;
flex: 0 1 calc((100% - 4 * var(--cc-card-gap, 6px)) / 5);
aspect-ratio: 64 / 92;
```

So the on-felt board is already fluid — a percentage of `.community-area`, which
is a percentage of the felt. The `--cc-card-w` rungs apply only to boards drawn
**off** the felt (replays, the previous-hand sheet, share pages), where there is
no `--table-w` and a viewport ladder is the correct reference.

What is genuinely inconsistent is smaller: `--cc-card-gap` **is** read on the
felt and is still on a rung, so the gap steps while the cards it separates are
fluid. Left alone deliberately — a 2-8px gap is not worth the churn, and saying
so is more useful than a large refactor justified by a claim that does not hold.

## 8. The hero-clearance question, answered

I had flagged this as "needs a logged-in look" twice. It did not — the seat is
positioned by a rule I could read: hero sits at `y:100` in every ring
(`tableSeatGeometry.ts`), the wrapper is `translate(-50%,-50%)`, and
`--hero-lift` is retired to `0px` ("Zero, not some smaller lift"). That is
reproducible in a fixture, and `SeatSlot.css` states the dependency itself:

> **THE ONE THING IT DEPENDS ON:** half the hero block now hangs below the
> scaler, so `--sp-hero-clear` … has to be at least that half … Below that the
> plate carrying the stack goes back under the bar.

**Measured on all thirteen devices: the plate is clear everywhere.** The worry
was unfounded.

But the margin is not what that note assumes. On five devices the block hangs
**further below the felt than the reserve states**:

| Device                  | Overhang   | `--sp-hero-clear` |
| ----------------------- | ---------- | ----------------- |
| iPad mini portrait      | 75.2px     | 68px              |
| iPad Pro 11 portrait    | 76.4px     | 60px              |
| iPad Pro 12.9 portrait  | **86.8px** | 60px              |
| iPad Pro 12.9 landscape | 66.0px     | 60px              |
| large desktop           | 69.2px     | 60px              |

It clears on **spare vertical space, not on the reserve** — and every term in
that sentence is now a different kind of expression (the avatar a fraction of the
felt, the bar a clamp on the viewport, the reserve a constant), so they can drift
apart without anyone typing a new number.

Enlarging the reserve was the obvious move and is the wrong one: it feeds
`--sp-table-bottom`, so it would shrink the felt on every device to buy margin
against a failure that is not occurring. What the situation actually needs is
**notice**, so the spec now measures the plate against the bar as two rectangles
and fails if one covers the other. Mutation-tested with
`--sp-hero-clear: 0px !important` — 1 failed, 7 passed.

Also corrected along the way: that note reads "against the 34px it reserves
today". The declared values are 60px and 68px; 34px was the stale **fallback**
fixed in §5. The note was reasoning from a number the cascade never used.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/` — full suite green.
- `playwright test table-proportions hero-card-row multi-table` — green.
- The new hero assertions mutation-tested against a restored rung.
- Brace/comment balance checked programmatically on all four edited stylesheets
  after the scripted rule removal.

## Still open, deliberately

- **`CommunityCards.css` is the largest surviving ladder** — `--cc-card-w/h/gap`
  at 65/55/50/45px across four rungs, with **no `--table-w` reference anywhere in
  the file**. The board is the five biggest objects on the felt and the only one
  still sized entirely by breakpoint. Worse under MultiTablePage: the rungs are
  on `:root`, not `.table-scaler`, so all four tables get one board size
  regardless of their individual felt widths, while seats and cards get per-table
  sizing from the inline `--table-w`. This is its own pass.
- **Position chips, empty-seat art and `--sp-wrap-overlap`** are still px ladders
  inside the felt. `--sp-wrap-overlap` has no base declaration at all — above
  480px every reader silently uses its `6px` fallback.
- **Hero plate clearance on a large tablet** remains unverified. The hero slot is
  now ~106px on an iPad Pro against a constant 60px `--sp-hero-clear`; a static
  fixture cannot model it because the seat is positioned from inline styles React
  computes. It needs a logged-in look.
