# Insurance Was Dark On Every Live Table, And A Horse's Constant Answer Was Why

2026-08-31 - Phase 3 of the live cash game audit.

## What the sweep found

Three cash features were measured against 24 hours of live traffic (40,038
hands across 27 live cash tables):

| Feature | Enabled on | Hands in 24h | Fired |
|---|---|---|---|
| Straddle | some | 4,434 | 3,770 |
| Run It Twice | 27 of 27 | 40,038 | 776 |
| Bomb pot | 0 of 27 | 0 | 0 |
| Insurance | 21 of 27 | 29,519 | **0** |
| Rabbit hunt | 27 of 27 | 40,038 | **0 recorded** |

Straddle and run-it-twice are healthy. The other three are not, and they fail
in two different ways.

## 1. Insurance: unreachable by arithmetic

`insurance_offer_events` holds 264 rows in its entire history. Every one came
from four hand-built tables - `PLO 2.00/4.00 INSURANCE`, `NLH 25/50 INSURANCE
TEST`, `NLH 2.00/4.00 INSURANCE`, and one 3.00/6.00 table. All four are closed.
The last row was written at 2026-08-30 14:56. Nothing since.

That is not a quiet feature. Over the same 24 hours, **270 hands on
insurance-enabled tables had two or more players all-in before the river** -
the exact precondition `checkAllInRunout` tests before it offers. Zero offers
were made on any of them.

The cause is a sequencing interaction that nothing was watching:

- `checkAllInRunout` asks the run-it-twice question FIRST (Dan's leader-seat
  sequencing, 2026-08-26: "THE INSURANCE PART PICKED UP ON THE TURN. AFTER THE
  RUN IT TWICE WAS DECLINED"). Insurance is reached only on the single-run
  branch.
- All 27 live cash tables have BOTH features enabled.
- `scheduleHorseRITResponses` answered the offer with a constant. A horse
  chooser picked 2 or 3 every time; a horse responder sent `'accept'` every
  time. There was no branch in the code that could produce anything else.

So every multiway all-in on the floor resolved to RIT accepted, the single-run
branch was never taken, and insurance was never offered. 573 of those hands
ran two or three boards; none of them could have run one. Nothing threw,
nothing logged, and both features reported themselves enabled.

### The fix

`horseRitVerdict(playerId)` - a deterministic verdict in (hand, player).
Roughly three hands in ten it returns `'once'`: a horse chooser picks 1 board,
a horse responder declines. Otherwise the behaviour is exactly as before.

This is section 10.5 compliant and is required by it twice over. It is not an
`is_horse` exclusion - nothing is withheld from a horse that a human gets. It
is the horse's input device choosing between two answers a human chooses
between, instead of being wired to one of them. And a seat that has agreed to
run it twice on every all-in it has ever faced is identifiable from outside
without seeing a hole card: the same rhythm leak the insurance responder was
rewritten to close on 2026-08-28 ("the old ~1s decline was a TELL").

The verdict is deterministic rather than random so a replayed hand answers the
same way twice, and so the rate is testable.

## 2. Bomb pots: dark by configuration

`bomb_pot_enabled` is set on exactly 2 of 925 live cash table rows, and both
are closed with zero seated players. One is named `E2E TEST TABLE - NLH 1/2`.
1,393 bomb hands have been dealt all time; the last was 2026-08-30 18:45.

No table on the floor has ever carried the flag. BombPotScheduler, the
double- and triple-board runout, and the multi-winner ledger repair from
Phase 1 are all exercising zero live traffic. Same shape as the Short Deck
dark-variant incident: the code is fine and nobody can reach it. This is a
floor-configuration decision, not a code defect, and it is recorded here
rather than fixed.

## 3. Rabbit hunt: no denominator

`rabbit_hunt_offers` and `rabbit_hunt_reveals` are both empty, all time, and
grep finds **no writer for either table anywhere in the codebase**. The
availability broadcast is in-memory only and the charge goes through
`fn_consume_rabbit_hunt`, so a reveal leaves a diamond ledger entry and
nothing else. The funnel has no denominator - exactly the gap
`insurance_offer_events` was created to close on 2026-08-28. Recorded as an
open finding; the tables exist and are waiting for their writer.

## Verification

- 8 new tests in `server/src/engine/HorsesCanDeclineRunItTwice.test.ts`:
  both verdict branches reachable across hands and across horses, the decline
  rate inside a 15-45% band, determinism on replay, both call sites read the
  verdict, the old constant is gone, and the single-run branch still hands off
  to `startInsuranceFlow`.
- `RunItTwice.multiway`, `RunItTwice.parity`, `RunItTwice.offerpath`,
  `InsuranceRitExclusivity`, `InsuranceLeaderHandoff`, `PacedAllInRunout`:
  38 tests, all green. `InsuranceRitExclusivity` already asserted both halves
  of the ordering ("chooser runs it ONCE -> insurance flow engages") - it was
  never reachable in production because no horse could pick 1.
- `tsc --noEmit` clean for this change.

## What to watch

`insurance_offer_events` should start receiving rows within hours of the
engine deploy. If it is still empty after a day of live multiway all-ins, the
`'once'` verdict is being produced and something further down the single-run
branch is swallowing the offer.
