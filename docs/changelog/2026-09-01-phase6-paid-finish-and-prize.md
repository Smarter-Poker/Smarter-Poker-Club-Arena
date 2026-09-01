# Phase 6 items 10 and 9 - a paid finish is not a bust, and the badge says what it is worth

2026-09-01. Branch `phase6/prize-and-finish`.

## Item 10 - a paid finish is not a bust

Only `position === 1` reached the celebration. Everyone else went out through
the busted door: a 2.5 second elimination beat, then the lobby.

At 10x and above a Spin pays 2nd and 3rd - 80/12/8 or 80/20. So a 100x
runner-up took a **fifth of the pool** and was shown the animation for losing
everything, then hurried off the table **faster than the winner**.

`elimData.prize` was already in hand two lines away and simply never consulted.

Now: a place that paid gets the same overlay the champion gets, carrying its
finishing place, and the same unhurried 7-second exit. A place that paid
nothing keeps the 2.5 second bust beat, which is correct for it.

`TournamentWinnerOverlay` takes an optional `position` defaulting to 1, so
every existing caller is unchanged and first place still reads CHAMPION. Other
paid places read IN THE MONEY over "2nd PLACE". The ordinal helper handles
11th/12th/13th, which a naive `n % 10` gets wrong.

The hold matters as much as the overlay: being shown the door faster because
you came second is the same bug wearing a stopwatch.

## Item 9 - after the wheel, say what it is for

The badge that replaces the wheel printed a bare `4x`, and the HUD carries
Level / Blinds / Next / Rank / Left / Avg. Once the wheel had gone, a player
could not find out what they were playing for - and at 10x and above, with 2nd
and 3rd paid, that is a decision input rather than trivia.

The prize pool is captured at the wheel's `onDone` (buy-in x multiplier,
exactly as the wheel computed it) and the badge now reads `4x | 40`.

**Deliberately NOT done:** the audit also suggests swapping the HUD's "Avg" for
Prize. Average stack is a real tournament statistic that a player uses to judge
their position, and trading one fact for another is not obviously a gain. The
felt badge is persistent and answers the question; if Dan wants the HUD segment
too, that is a small follow-up rather than a silent removal.

## Verification

- `npx tsc --noEmit`: clean.
- `tests/a-paid-finish-is-not-a-bust.law.test.ts`: 6 tests, green, registered
  in `docs/LAWS.md`. One pin keeps the 2,500 ms unpaid path alive - celebrating
  everybody is its own lie.
- The full client suite runs in CI on this pull request.
