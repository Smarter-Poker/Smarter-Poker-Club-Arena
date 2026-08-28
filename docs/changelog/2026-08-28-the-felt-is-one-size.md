# The felt is one size. Nothing changes it.

**Dan, 2026-08-28, verbatim:** "NO, THAT SHOULD NEVER HAPPEN, PREVENT IT AND FIX
IT. THATS A GLITCH, NOT CODE SMH"

He is replying to me. In the previous pass I made the felt's reserve static and
then wrote this in my own report:

> "One residual I will not hide: the felt still changes size once — when you sit
> down or stand up. That is deliberate... and it cannot happen mid-hand."

That was wrong, and the reasoning was wrong in a way worth writing down: **"the
user's own tap caused it" is not a defence.** Nobody taps an open seat in order
to resize the table. A table that changes size is a glitch whatever triggered it.

## What was still moving it — three inputs, not one

`.table-scaler` derives its WIDTH from the height left over, so **every term in
`--sp-table-h` is the oval's size**:

```
--sp-table-h = --sp-page-h - --sp-table-top - --sp-table-bottom
```

I had audited that chain for JavaScript writes. I had not audited it for **CSS
state** or for **unstable units**. Three things could still move it:

**1 + 2. The sit-down jump — TWO rules, not one.** I had only counted one:

| rule                                                                  | seated       | spectating   |
| --------------------------------------------------------------------- | ------------ | ------------ |
| `.table-page[data-hero='false'] { --sp-action-reserve }`              | 96px + inset | 22px + inset |
| `.table-page[data-hero='false'] .table-container { --sp-hero-clear }` | 60px         | **6px**      |
| **`--sp-table-bottom` total (desktop)**                               | **156px**    | **28px**     |

A **128px** jump the instant anybody took a seat, and back when they stood up.
Both rules are deleted.

**3. `100dvh`.** `dvh` is the _dynamic_ viewport height: on a phone it grows and
shrinks as the browser's URL bar collapses and reappears. `.table-page`'s own
`height: 100dvh` should track that — it is a box that must fill the screen. But
`--sp-page-h` is not a height, it is what the felt sizes itself from, so in `dvh`
**the oval rescales whenever the browser chrome animates.** Same glitch as the
ResizeObserver, arriving through a different door, and it would have shown up on
exactly the device Dan reviews on.

`--sp-page-h` now uses `svh` — the _small_ viewport height, the viewport with
chrome fully shown, which is constant for a device and orientation. All three
declarations (route, embedded, `<=480px` embedded) move together inside one
`@supports (height: 100svh)` block, so the table cannot be one size in the lobby
and another in a tab.

`@supports` rather than writing `svh` directly: a custom property accepts any
token sequence, so a browser that does not know `svh` would store it happily and
then fail at computed-value time inside `--sp-table-h`'s `calc()`, taking the
scaler's entire `width` down with it. Asking first means an old browser keeps
today's `dvh` behaviour instead of losing the table.

## What this costs, stated so nobody optimises it back

A spectator now has `--sp-action-reserve + --sp-hero-clear` of page under the
felt holding nothing — they have neither an action bar nor a hero plate. On
2026-08-25 that strip was reclaimed for exactly that reason. **Latest
instruction wins, and this one is absolute.** If the dead band is ever worth
addressing, address it _without changing the felt's size_: move what is drawn in
the band, not the box above it.

## The guard — and the guard that was lying

`tests/unit/feltReserveIsStatic.test.ts` gains three assertions:

1. **No geometry property may be declared behind a component-state selector.** A
   `@media` breakpoint may change these — that is the viewport changing, the one
   legitimate reason the oval may differ. `[data-…]`, `:has()`, `.ca-raising`,
   `--hero-turn`, `:hover` and friends may not.
2. **Every `dvh` declaration of `--sp-page-h` must have an `svh` partner.**
3. **The two deleted spectator rules must stay deleted**, named explicitly.

**Assertion 2 was green for the wrong reason and I caught it by mutation
testing.** I wrote `/\bdvh\b/` — and there is no word boundary between the `0`
and the `d` of `100dvh`, so the pattern matched nothing and both sides of the
equality were zero. Deleting every `svh` declaration left the suite green. Fixed
to `/\d+dvh\b/`, plus a floor assertion (`dvh.length > 0`) so it can never again
pass by matching nothing.

Every new assertion is proven to fail on reintroduction:

```
MUTATION: spectator --sp-hero-clear back      -> 2 failed | 6 passed
MUTATION: spectator --sp-action-reserve back  -> 2 failed | 6 passed
MUTATION: strip every svh declaration         -> 1 failed | 7 passed
           "6 --sp-page-h declaration(s) use dvh but only 0 use svh"
restored                                      -> 8 passed
```

## Results

```
npx tsc --noEmit        TSC=0
npx vitest run tests/   517 files, 8085 tests, 0 failed
npm run build           build exit=0
```
