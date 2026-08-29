# A lost bomb-pot award unit cannot stay silent

2026-08-29 — continues the bomb-pot work handed off after PR #1685.

## The handoff said one thing; the code said another

The handoff I picked this up from named an open bug: the award-unit ledger
"silently skips fold-win bomb hands", roughly one hand in sixty, because the
uncontested and `skipDistribution` WINNERS emits carry `winners: []` and no
`perPotAwards`. Its evidence was hand `3309072` (2026-08-28 19:12:41Z): a turn
fold-win, money correct, zero ledger rows.

That is not what this code does, and I checked before changing anything.

`determineWinners` pushes the uncontested winner's per-pot entry before it ever
reaches an evaluator — `PokerEngine.ts`, the `activePlayers.length === 1`
branch, which fills `perPotOut` and returns. Driving the real `HandController`
confirms it end to end:

```
FOLDWIN   stage flop  b1 3 b2 3
          winners [{"userId":"u1","amount":12,"potIndex":0}]
          perPot  [{"userId":"u1","potIndex":0,"low":false,"amount":12}]
RIVERFOLD stage river b1 5 b2 5
          winners [{"userId":"u1","amount":12}]
          perPot  [{...,"amount":6,"board":1},{...,"amount":6,"board":2}]
```

Production agrees. Hand `3366646` (2026-08-29 02:48:02Z) is a turn fold-win with
exactly one award unit, and it reconciles.

The handoff's evidence was real but pre-dated its own fix. Hand 3309072 settled
at 19:12; PR #1685, which widened the ledger write from multi-board hands to
every bomb hand, reached production at 22:38. Every gap before that timestamp is
the partial era, by design.

Three pins now say so, in `HandController.doubleboard.test.ts`, so nobody has to
establish it a third time: a flop fold-win carries one award unit, a river
fold-win carries one per complete board, and a triple-board river fold-win
carries three — each summing to exactly what the winner was credited.

## The bug that IS open

Reconciling every bomb hand since #1685 landed leaves exactly one that does not:

```
hand 3364829 · 2026-08-29 02:35:08Z · table c4874708-d17e-43cb-ab91-4db6f7526757
pot 88.00 − rake 3.35 − bbj 0.50 = 84.15 ; paid 42.07 + 42.08 = 84.15   money fine
two complete boards · full showdown · 2 winners · award units: 0        ledger empty
```

Its neighbours at 02:31:42 and 02:37:11 both wrote their rows. Nothing about
this hand is unusual, which is the point: the write failed once, transiently.

The award-unit write is deliberately fire-and-forget — `logHandHistory` has
already recorded the money, and a ledger that only NARRATES a settlement must
never be able to fail the hand it narrates. That part is right. What was wrong
is that "cannot fail the hand" had been built as **one attempt, then a
`console.warn` on the Hetzner host**. So a single transient error lost a hand's
award units permanently AND silently, and the only way anyone would ever learn
is by writing the SQL by hand — which is how this was found.

## What changed

**1. The write survives a transient failure.**
`ServerTableEngineSettlement.ts` retries three times with a linear backoff
(`BOMB_LEDGER_WRITE_ATTEMPTS`, `BOMB_LEDGER_RETRY_BASE_MS`) and reports the
third failure through `reportError`, not a log line. Still `void`, still
awaited by nothing, still incapable of failing a hand.

**2. Whatever still slips through becomes loud.**
`fn_bomb_pot_ledger_gaps(p_since, p_grace, p_epoch)` lists every settled bomb
hand whose award units do not sum to its net winnings, and
`reconcile_ledger_nightly` files each one as **critical** under the new
`bomb_award_ledger_gap` entity type.

Deliberately the same shape CLAUDE.md §11.5 settled on for seat-stack exits: a
guard that can REFUSE a settlement is more dangerous than the thing it guards
against, so make the failure loud rather than impossible.

Two parameters carry the judgement:

- `p_grace` (default 10 minutes) — the write is asynchronous by design, so a
  hand that settled four seconds ago legitimately has no rows yet and is not a
  gap. Ten minutes is far longer than three attempts at 250/500ms can take.
- `p_epoch` (default `2026-08-28 22:38:00+00`) — the moment production was
  verified serving #1685. Before it, bomb hands are missing rows by design;
  reporting them would bury the one real signal in known history. Pass an
  earlier epoch to audit the partial era deliberately.

Verified live after applying both migrations:

```sql
SELECT * FROM public.fn_bomb_pot_ledger_gaps('30 days'::interval);
-- 1 row: hand 3364829, net 84.15, ledger 0.00, 0 units

SELECT * FROM public.reconcile_ledger_nightly();
-- total_checked 10 · critical 5 — one of which is:
-- bomb_award_ledger_gap | critical | 84.15 | 0.00
--   {"hand_number":3364829,"board_count":2,"award_units":0,"trigger_reason":"every_n_hands"}
```

## What I deliberately did NOT do

**No historical backfill.** The ledger's first row is 2026-08-28 18:20:49Z;
everything before that is missing and cannot be honestly reconstructed. For a
fold-win it would be trivial, but for a multi-board showdown the merged
`hand_history.winners` list does not record WHICH BOARD each winner took — that
is precisely the fact the award ledger exists to preserve. Recovering it would
mean re-evaluating stored hole cards against both boards and writing the result
as though it had been recorded at the time.

A ledger of reconstructions presented as a ledger of records is worse than an
honest hole, and this repo has been bitten by exactly that before (CLAUDE.md
§10.5: an invention presented as a design decision is worse than a plain bug).
Hand 3364829 stays visible in the gap report instead. The report's nightly
window is one day, so it clears itself rather than becoming permanent red noise
that trains people to ignore the alarm.

## Files

```
server/src/engine/ServerTableEngineSettlement.ts       retry + reportError
server/src/engine/HandController.doubleboard.test.ts   3 fold-win award pins
tests/unit/bombPotGuards.test.ts                       retry + reconciliation pins
supabase/migrations/20260829_bomb_award_ledger_gaps_are_loud.sql
supabase/migrations/20260829_reconcile_reports_bomb_award_gaps.sql
```

One existing pin moved anchor. `the award-unit ledger covers EVERY bomb hand`
sliced its window by climbing two levels out from the `.upsert(`; the retry loop
added a nesting level between the two and the window silently stopped covering
the gate it was written to guard. It now anchors on the `if` condition itself,
which cannot drift no matter what is nested inside it — the exact failure mode
`tests/helpers/sourceWindow.ts` was written to end.

## Still open from the handoff

- On-device 375px triple-board pass (cannot be done from a terminal).
- `once_per_orbit`, `bomb_pot_only`, PLO5/PLO6 overrides and the board-count
  downgrade path have never run in production — unit-tested only. The permanent
  E2E table (`d2e23e79-…`, horse-only, timed/3-board/PLO4) is the technique for
  proving them.
- Manual-trigger read cost: one extra `SELECT` per non-bomb hand on bomb tables.
