# Phase 6 - no dead felt, and the rule behind it

2026-09-01. Branch `phase6/no-dead-felt`.

Dan, verbatim: **"THERE SHOULD NEVER BE THIS 14 SECONDS OR 10 SECONDS OF DEAD
ANYTHING ANYWHERE."**

That is a rule, not a bug report, and it now has a law: `tests/no-dead-felt.law.test.ts`.

## What he was looking at

The Spin wheel scheduled its own exit off its own sequence. Under reduced
motion that sequence is about **2.4 seconds**:

| beat        | normal   | reduced motion |
| ----------- | -------- | -------------- |
| lead-in     | 1,000 ms | 0              |
| countdown   | 3 x step | 200 ms         |
| chase       | full     | 400 ms         |
| result hold | 3,200 ms | 1,800 ms       |

The engine, meanwhile, holds the deal for `spinRevealToDealMs()` regardless -
the wheel plus the chip drop plus the button draw. So the wheel unmounted and
handed back an **empty table**: zero-chip seats, no cards, and nothing on
screen saying why, for roughly fourteen seconds.

It was never only a reduced-motion problem. The same gap opens, smaller, for
anyone whose Animation Speed is set fast, and it opens **completely** for a
client that joins late - every phase resolves to zero, the wheel flashes, and
the player is left looking at felt.

## The fix

The wheel does not hand the felt back until the engine is ready to use it, and
it says what the wait is for while it holds:

- the exit fires at `Math.max(at(ownEndMs), dealAtMs - Date.now())` - the LATER
  of this component's own sequence and the moment the engine deals. Either half
  alone is a bug: the sequence alone leaves an empty table, the deal moment
  alone would cut a full-length wheel short;
- `dealAtMs` comes from the shared clock plus `spinRevealToDealMs()`, NOT from
  `revealDeadlineMs` - the socket path sets that field and the fallback
  row-derived path does not, so a client the socket never reached would have
  had no deadline to hold for at all;
- the result card stays up with a live **"Dealing In N"**, ticking at 250ms so
  the number is never stale by a whole second.

Speeding the ANIMATION up is a preference and is still honoured - `ownEndMs`
is scaled by both `speed` and `reduced`. Being shown nothing is not a
preference, it is an empty screen, so `dealAtMs` is scaled by neither. A pin
enforces exactly that.

This slows nothing down. A wheel already running to full length reaches
`ownEndMs` at or after the deal moment and is untouched.

CLAUDE.md 10.6 says reduced motion collapses MOTION, never MEANING. A
collapsed animation that leaves the player staring at felt has thrown the
meaning away too, so the countdown is marked `data-motion="keep"`.

One correctness detail worth naming: the ticker is an interval, and it is
cleared with `clearInterval` through its own ref rather than being pushed into
the timeout array. `clearTimeout` on an interval id is not reliable outside a
browser, and a ticker outliving the wheel would set state on an unmounted
component every 250 ms. That is pinned too.

## Verification

- `npx tsc --noEmit`: clean.
- `tests/no-dead-felt.law.test.ts` (6), `animations-always-play.law.test.ts`
  (59), `spin-sweep-books-the-seats-that-sold.test.ts` (8),
  `law-registry.law.test.ts` (40): **113 tests, all green**.
- Registered in `docs/LAWS.md`.
- The full client suite runs in CI on this pull request.

---

## Phase 6 staleness sweep

Fourteen other items were checked against current `main` before any of them
were touched, because this audit was written on 2026-08-31 and a great deal
has shipped since. No symbol named in it has been deleted, though four files
moved paths.

| #   | item                                                                   | verdict                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every Spin card says "300 chips / Turbo"                               | still reproduces                                                                                                             |
| 2   | The 100x celebration is 2/3 invisible (confetti clipped past index 24) | still reproduces                                                                                                             |
| 3   | One tile's wheel blanks all four tiles                                 | still reproduces                                                                                                             |
| 4   | Reduced motion leaves dead felt                                        | **fixed here**                                                                                                               |
| 5   | Late reconnect: 4-frame flash, then suppressed                         | still reproduces                                                                                                             |
| 6   | Animation-speed preference ignored by the wheel                        | still reproduces                                                                                                             |
| 7   | Fallback wheel animates off a different column                         | still reproduces                                                                                                             |
| 8   | "Play Again" can land you on a full table                              | still reproduces (both halves)                                                                                               |
| 9   | After the wheel, nothing says what the prize is                        | still reproduces                                                                                                             |
| 10  | Paid 2nd/3rd exit through the "you busted" door                        | still reproduces                                                                                                             |
| 11  | Heads-up is never announced on a Spin                                  | still reproduces                                                                                                             |
| 12  | Accessibility                                                          | half fixed - the screen-reader silence and the buy-in Escape are closed; focus management and the fake `role="table"` remain |
| 13  | Landscape / short viewports clip the reveal                            | still reproduces                                                                                                             |
| 14  | No seat-fill indicator or ETA                                          | mostly reproduces - a 30s stall message was added, the dots and ETA were not                                                 |
| 15  | Registration RPC retried with no idempotency key                       | still reproduces                                                                                                             |

Next, in this order, on impact: **3** (one missing prop blanks three unrelated
live tables), **15** (money-adjacent, and the repo already has the
`p_client_token` pattern), **10** (`elimData.prize` is in hand and simply not
consulted), **1** (a factual misstatement on the highest-traffic surface),
**8** (the capacity predicate is absent and the fallback URL is provably dead).

Items 5, 6 and 7 are the same family as this change - all three are the wheel
disagreeing with the shared clock - and are worth doing together.
