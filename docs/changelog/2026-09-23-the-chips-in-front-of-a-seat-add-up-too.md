# The chips in front of a seat add up too

The pot's pile was fixed on 2026-09-20 by handing `visualChipStacks` the whole
denomination ladder. The seat was not. It was still asking for four
denominations in compact form and five in full, and `maxStacks` is not a clamp -
it is `chips.slice(0, maxStacks)` in `chipDenominations.ts`. A group it removes
takes its VALUE with it, reports no `truncated`, and prints no badge.

The comment above those two constants said, in as many words, "Neither cap ever
changes the VALUE drawn". That was true of `maxPerStack` and of `maxTotal`. It
was never true of `maxStacks`.

## How wrong

Swept through the functions extracted from the shipped production bundle, over
every integer amount in each range:

| amount range | `maxStacks: 4` (compact) | `maxStacks: 5` (full) |
| ------------ | ------------------------ | --------------------- |
| 1 – 200      | 0.0%                     | 0.0%                  |
| 1 – 2,000    | 39.2%                    | 9.6%                  |
| 1 – 20,000   | 74.7%                    | 42.2%                 |
| 1 – 200,000  | 88.3%                    | 65.2%                 |

Those are the percentages of amounts whose drawn chips do not add up to the bet.
Micro stakes are clean, which is why it survived: a bet under 200 never needs
more than four denominations. A 7,432 bet drew 5000 + 1000×2 + 100×4 + 25 —
7,425, seven short, in front of a player, with nothing to say anything was
missing.

## The fix, and what it costs

`maxStacks` gets the whole ladder and stops being a cap. `maxTotal` is the cap,
and it is the honest one: it clamps the DISCS and the group it shortens keeps
its true count with `truncated` set, so the tower still adds up.

Measured at 393px against the shipped stylesheet, `.cp-chip + .cp-chip` being
`margin-bottom: var(--cp-chip-overlap)`:

| tower   | before | after (mid) | after (deep) | worst case |
| ------- | ------ | ----------- | ------------ | ---------- |
| compact | 55.9px | 62.9px      | 69.9px       | 90.9px     |
| full    | 83.9px | 83.9px      | 83.9px       | 90.9px     |

The full tower does not move at all below 200,000 — `maxTotal` is already 10 and
no amount under 200,000 needs more than eight denominations. The compact tower
grows by one disc (7px) at mid stakes and two (14px) at deep stakes. It reaches
eleven discs only at 6,606,631 and above, the first amount that needs one of
every chip on the ladder.

That growth is safe: `.seat__bet-chips` is `position: absolute` with
`translate(-50%, -50%)`, no height and no clipping, so the extra discs grow
symmetrically about the anchor into open felt and cannot reflow anything.

## The street pile is gone

`PotChipPile` carried a second `size: 'street'` form for a live-bets pill under
the POT pill. Nothing has rendered that pill since 2026-08-20, so nothing could
reach the branch — and it asked for THREE denominations, which draws chips that
do not add up on 97.5% of amounts. Unreachable code that is also wrong is a trap
for whoever wires it up next. Removed, along with its two stylesheet rules;
`tests/chips-on-the-felt.test.tsx` still pins the absence of a street pile.

## The guard that matters

Every instance of this bug has been a literal: `{ maxStacks: 3 }`,
`{ maxStacks: 4 }`, `{ maxStacks: 5 }`. So the new test reads the source of both
chip surfaces and fails on any `maxStacks:` whose value is a bare number. The
cap that belongs in a chip layout is `maxTotal`.
