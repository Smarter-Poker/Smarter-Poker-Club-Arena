# The wheel said nothing to anyone who could not see it

2026-08-31, spins audit part 5.

## The gap

`SpinWheel` renders as `role="dialog" aria-modal="true"` with
`aria-label="Spin Multiplier Draw"`, and every moving part inside it is
correctly marked `aria-hidden="true"` — the beam, the starting tree, the
countdown numeral, the rim, the gloss, the confetti. All decoration, all
properly hidden.

Which left **nothing**. A screen reader announced "Spin Multiplier Draw,
dialog" and then said not one word for the 16.6 seconds the engine holds the
deal, after which the player was dealt into a tournament without ever being
told what they were playing for. The multiplier, the prize pool and the
payout split were visual-only.

`aria-modal="true"` makes it total rather than partial: it instructs assistive
technology to ignore everything outside the dialog, so there was not even the
felt to fall back on.

## Why this is the same law as reduced motion

CLAUDE.md 10.6 is binding: a player who turns motion off loses the MOTION and
keeps the MEANING. The audit earlier today verified exactly that for the
reduced-motion path — with every animation removed, the disc, the multiplier
and the prize all still resolve to opacity 1 and the result is announced for
its full hold.

This is the same rule on a different channel, and the wheel was failing it
completely.

The platform already knew how. `BBJHitNotification` — the Bad Beat Jackpot
moment — carries `role="status"`, `aria-live="polite"` and a one-sentence
`aria-label`, and `clubArenaAccessibilityFoundation.test.ts` already requires
"live-region semantics for loading and recovery states". So Club Arena
announced a Bad Beat Jackpot to a blind player and stayed silent about the
moment the Spin format exists for.

## What it says now

One polite live region, modelled on the BBJ precedent, carrying the three
facts the visuals carry:

- while the draw runs — `Drawing Your Multiplier.`
- on the result — `25 Times. Prize Pool 250. Paying First 200, Second 30, Third 20.`

The splits come from `spinTier(...).payouts`, the same source the visible
`sw__splits` row reads, so the two can never disagree about who cashes.

Two announcements, not a running commentary: `aria-live="polite"` never
interrupts, and a countdown read aloud three times would be worse than
silence.

**The region is rendered from the first frame and never removed.** A live
region inserted into the DOM at the same moment as its text is missed
entirely by several screen readers — so it is the dialog's first child, and
the test pins that it appears before the first phase branch.

## Verified, not assumed

`.sr-only` is the clip-based implementation (`position:absolute`, `clip:
rect(0,0,0,0)`) rather than `display:none`, which would hide the text from
assistive technology too. It ships in `assets/index-CbvJ3x5X-v6.css`, linked
directly from the served `index.html`, and `PremiumCard` already uses it on
the table page in production — so the region is invisible on the felt and
audible to a reader.

## Verification

- `clubArenaAccessibilityFoundation.test.ts` — 13 tests, including the new pin
  and a guard on the BBJ precedent it was modelled on
- `tests/components/SpinWheel.test.tsx` — 33 tests, green
- `npx tsc --noEmit` — clean (it also caught a dead `phase === 'idle'` branch
  in the first draft: the component returns null above it)
