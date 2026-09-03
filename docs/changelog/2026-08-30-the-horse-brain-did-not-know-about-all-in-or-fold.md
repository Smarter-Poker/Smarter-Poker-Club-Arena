# 2026-08-30 — The brain did not know about all-in-or-fold

Found while sweeping for bugs shaped like the big blind ante one, at Dan's
instruction to check for similar bugs before starting Phase 2.

## The shape being hunted

The ante bug was: **a rule the brain does not know, applied downstream, so the
brain's answer is silently rewritten into something strategically wrong.** That
is a class, not an incident. The sweep covered every place a table rule is
enforced, asking one question each time — does the brain know?

| rule                     | brain knows? | live now                     | consequence when blind                |
| ------------------------ | ------------ | ---------------------------- | ------------------------------------- |
| **all_in_or_fold**       | **no**       | 0 running (8 tables, 3 MTTs) | opening range becomes a shoving range |
| `cap_enabled` / `cap_bb` | no           | 0 running                    | benign — clamp only, fixed 2026-08-27 |
| fixed limit (flh, flo8)  | no           | never played                 | plays limit as no-limit               |
| straddle                 | yes          | 1 running                    | —                                     |
| ante / big blind ante    | **now yes**  | live                         | fixed earlier today                   |

Also swept and cleared: every `* seats` multiplication on a money figure (only
AnteMath), the bomb pot ante (`bigBlind * multiplier`, one convention), rake
percent (whole-percent everywhere), and the rake cap's BB-versus-chips
ambiguity (already documented on the column, and every table inherits).

## The bug

`ServerTableEngineTurns` said it plainly in its own comment:

> The horse brain does not know about AoF, so its decision is coerced here:
> any non-fold intent becomes the all-in.

So at an AoF table every hand the brain would have opened for 2.5bb, and every
hand it would have called a raise with, became a shove of the entire stack.
Measured across the strength range:

| depth | shoved, before | shoved, after |
| ----- | -------------- | ------------- |
| 12bb  | 46.7%          | **46.7%**     |
| 25bb  | 51.8%          | 38.5%         |
| 50bb  | 54.9%          | 23.1%         |
| 100bb | **54.9%**      | **15.9%**     |

At a hundred big blinds it was shoving better than half of every hand dealt,
risking 100bb to win 1.5bb. **A coercion guarantees legality. It cannot fix a
range.**

## The fix

The brain is told. `allInOrFold` now travels from `tables.all_in_or_fold`
through the horse state into the preflop context, and AoF takes a jam-or-fold
branch for every variant.

The thresholds are **the push/fold block's own**, deliberately, so AoF does not
become a second set of numbers for the same decision — plus one depth term,
because a shove risks the whole stack to win the blinds and that price rises
with depth. It is anchored at 12bb, where those numbers are already tuned and
tested, and the 12bb row above shows the anchor holding **exactly**: 46.7%
before, 46.7% after. A short AoF table behaves precisely as push/fold does
today; only depth changes anything.

The downstream coercion stays, as the legality guarantee. The fix makes it a
no-op instead of a strategy.

## Verification

- `npx tsc --noEmit` clean in both roots.
- engine and services suites green; 10 new tests.
- **Two mutations, green restored after each:** setting `AOF_MAX_TIGHTEN` to 0
  fails the depth test; making the brain ignore the flag again fails four.
- A range sweep asserts an AoF table can only ever emit `fold`, `check` or
  `jam` — across five depths, every strength, and one, two and three raises.

## What this does NOT claim

`AOF_TIGHTEN_PER_BB` is a first cut. It is monotone, bounded, anchored at a
tested point, and enormously better than shoving 55% at 100bb — but no AoF
table is running, so there is nothing to measure it against yet. It is a
tuning knob, and it is named so it can be found.

Fixed limit stays unfixed on purpose: `flh` and `flo8` have never been dealt,
so tuning a limit strategy now would be inventing behaviour for a game nobody
is playing. It is recorded here instead.
