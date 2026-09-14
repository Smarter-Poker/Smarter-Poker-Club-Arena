# A Horse Turn That Is Abandoned Says Why

Before: `scheduleHorseAction` guards six stages of a horse's turn with one fence — abort signal, turn token, hand controller, hand number, lifecycle, current seat, engine lease generation. Every one of those six answered a failure with a bare `return`.

Abandoning the turn is correct. A superseded turn must not act, and a table that has lost its engine lease must not act on its behalf. What was wrong is that abandoning was **silent**: the horse was never scheduled, never asked the decision worker for anything, and was counted nowhere. The seventeen-second clock then resolved the seat as a forced check/fold, so the only trace left was `poker_horse_turn_timeouts_total{kind="timer"}` — a number that names the clock, not the cause.

## What that looked like on 2026-09-11

|                                                 |                                     |
| ----------------------------------------------- | ----------------------------------- |
| `poker_horse_decision_fallbacks_total`          | **0**                               |
| decision worker queue depth                     | **0**                               |
| decision worker compute                         | **4.9 ms**                          |
| decision worker expired jobs                    | **0**                               |
| `poker_horse_turn_timeouts_total{kind="timer"}` | **19-40 / min**                     |
| hands dealt                                     | 164 / min                           |
| engine lease losses                             | **1,652 / min across 1,570 tables** |

Roughly one horse turn in eight was being folded by the clock while every gauge describing the horse decision path read perfect. They were not lying. The worker genuinely was idle and healthy — it was never asked, because the fence had already refused the turn and said nothing.

The correlation is clean rather than inferred. In the quiet window 22:10 to 22:40 the engine logged **zero** lease losses and timer timeouts ran at ~0/min. During the storm both moved together, peaking at 1,652 lease losses a minute against 40 timeouts a minute. The lease renewal RPCs themselves average 1.0 to 12.1 ms and the leases expire _before being renewed_, so the renewal call is late rather than slow — and it runs on the single authoritative loop.

The alerting was not blind, and that is worth saying plainly: `HorseTurnTimeoutStorm` (critical, SMS) and `HorseForcedSitOuts` (critical, SMS) both fired and both delivered, at 23:05:49 and 23:03:49. The platform said the horses could not play. It could not say why.

## Correction

`fenceIsCurrent()` becomes `fenceIsCurrent(stage)`, and the conditions move into `fenceRefusal()`, which returns which one refused:

- `aborted` — this turn's controller was aborted;
- `superseded` — a newer turn replaced this one;
- `hand_replaced` — the hand controller or hand number moved on;
- `lifecycle_locked` — the table may not mutate right now;
- `seat_moved` — the table is no longer on this seat;
- `lease_lost` — the engine lease generation changed or stopped verifying.

Each of the six call sites names its own stage: `schedule`, `fallback`, `fast_result`, `deep_start`, `deep_result`, `commit`. A `commit` abandonment is the expensive one — the decision was computed and then dropped.

The checks are unchanged, in the same order, with the same outcomes. Only their silence is.

`poker_horse_turns_abandoned_total{reason,stage}` carries it, on the always-on registry and zero-seeded across all thirty-six combinations. Both of those are lessons from earlier the same day: `poker_hands_total` lived on a flag-gated registry that is enabled nowhere in this estate and left `SLOHandsAreNotBeingDealt` (critical, SMS) structurally unable to fire, and thirteen other metric names were found with no producer at all, every rule against them evaluating to an empty vector that reads exactly like health.

`HorseTurnsAbandonedByLostAuthority` fires at the same 5/min threshold as `HorseTurnTimeoutStorm`, deliberately: the two describe the same seat from opposite ends, and a threshold that differed would let one fire without the other and invite the wrong conclusion.

## What this does not fix

The lease churn itself. 1,652 losses a minute across 1,570 tables is a real defect and it has its own shape: the storm begins when a full floor resumes at once after a maintenance thaw, then sustains itself, because each lost lease restarts a table and each restart is more work for the loop that was already late on renewals. It decayed on its own tonight as the tournament field drained, from 1,652/min at 23:20 to 275/min at 23:28, and it will return at the next thaw with a full floor. That needs its own pass.

The lease losses are also not metered anywhere — they exist only as log lines, and `poker_lease_conflicts` read 0 throughout. `reason="lease_lost"` on the new counter is the first number that will move when this happens again, which is enough to find it, and not enough to describe it.
