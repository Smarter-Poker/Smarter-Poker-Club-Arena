# 2026-08-31 — A credit may fund an empty seat. It may not rescue a losing one.

Found in Phase 6 of the Spins audit, checking the one invariant a tournament
cannot be allowed to break: the chips that finish a game must be the chips that
started it.

## What was wrong

`creditSeatStacks` funds seats that are waiting on their stack. It asked one
question:

```ts
const stale = (seatRows ?? []).filter((r) => Number(r.stack) < target);
// ... then: .update({ stack: target })
```

That is the right question **before** a hand is dealt and the wrong one after
it. Every player who is losing is below the starting stack by definition, so
once play was under way this raised the loser back to a full stack and minted
the difference onto the felt.

## The evidence

Spins completed in 24 hours on production:

| Starting stack | Games | Drifted | Worst mint | 2x stack |
| -------------- | ----- | ------- | ---------- | -------- |
| 300            | 2,168 | 418     | +470       | 600      |
| 1,000          | 305   | 84      | +1,603     | 2,000    |

**Not one of the 502 exceeded twice the starting stack** — exactly the ceiling
of topping up the two players who can be behind in a three-handed game. Nothing
else in the engine has that signature, and it is the constraint that took this
from "chips do not add up" to a single line.

The felt agreed with the ledger, so this was not a denormalisation artifact:
on the game I opened, `table_seats.stack` and `tournament_players.chips` both
read 1,014 where 900 had been bought in.

It is engine-wide, not a Spin bug — heads-up SNGs drift too (13.9%). The MTT
variants also "drift", but legitimately: they have rebuys and add-ons, so
`seats x starting_chips` was never their expected total.

## Why it matters even though no money is minted

A Spin's prize is `buy_in x multiplier`. It does not depend on the chip count,
so no money is created directly. What is created is a **different winner** —
the engine decides the game on chips, and a player who was busting got their
stack back. On an MTT, where finishing position _is_ the payout, that moves
real money.

## Why it fired so often

All four callers are pre-deal by intent: `start()`, the post-reveal beat, its
safety net, and `resume()`. `resume()`'s own note scopes it exactly — "start()
defers the Spin credit to a timer roughly eighteen seconds out. A process
restart INSIDE THAT WINDOW threw the timer away" — but the code has no window
check, so it ran on every restart forever. One game in five.

## The fix

The question is now asked against the state of the game:

- **no hand dealt yet** — fund anything short of the target, unchanged;
- **play under way** — fund only a seat still sitting on zero, which is the
  stranded reservation `resume()` exists for. A losing stack is left alone.

If the probe itself fails, take the conservative branch and report it. The
stranded-at-zero case is still rescued either way; the only thing given up is
raising a placeholder tier, which the next call redoes. That asymmetry is
deliberate: this function already has a 2026-08-28 lesson about a discarded
read error that stranded a table at zero, so the failure is loud rather than
silent — but a blip must not be read as "no hands yet", because that is the
branch that mints.

## Not fixed here

81 of the 502 drifted the other way — chips _destroyed_, worst −1,000. That is
a smaller, separate residue with no signature I could pin to a single line, and
I am not going to invent a cause for it. It is written down rather than
guessed at.

## Verification

The guard is verified in both directions: reverting the filter to
`Number(r.stack) < target` turns exactly two of its five assertions red.

`npx tsc --noEmit` clean. Full server suite: **293 files, 3,302 tests, 0
failures.**
