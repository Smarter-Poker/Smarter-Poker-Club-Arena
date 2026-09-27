# A Blind Level Is Spent By Any Dealt Hand, And A Finish Hears The Database's Answer (2026-09-27)

## What Was Wrong

### The blind clock stalled while tables dealt

`advanceBlindLevel` holds a level that "came due with no hand dealt since it
began" (#5140, 2026-09-23). Its witness, `lastObservedHandCompletedAtMs`, is
written by the manager's `onHandComplete` callback. `postHandTasks` in
`ServerTableEngineSettlement.ts` only invoked that callback when a final stack
was zero, so the witness moved only when somebody busted. Every level that
came due after a bust-free stretch was held while the tables kept dealing.

Measured on production at 15:43Z on 2026-09-27, before the fix:

| RUNNING events with an engine lease that dealt in the last hour | 466 |
| ------------------------------------------------------------------ | --- |
| two or more levels behind `started_at` + level schedule            | 441 |

- NLH Heads-Up 20 `e0d497f5`, 3-minute levels: 293 hands in three hours, all
  at 10/20, level 0. Engine log: `Level 0 came due with no hand dealt since
  it began - holding it until this tournament deals again`.
- Sunday Funday Six-Card Closer `c7f21a83`, 12-minute levels: level 3 for
  days while hands were dealt.

The durable anchor (`tournaments.level_started_at`, thawed by
`fn_thaw_platform`, break overlap subtracted on resume) was already correct.
The level simply never went up.

### A finish that waited on the lane was reported as "outcome unknown"

`fn_complete_tournament_terminal` and `fn_resolve_tournament_terminal_outcome`
carry a 45-second statement ceiling and queue on the platform finish lane (G
shared, F exclusive, T(id) exclusive; each wait bounded by the 8-second
`lock_timeout` on `authenticator`). The engine asked them on the 15-second
game-data client, so an attempt queued behind the lane could be abandoned
before the database answered. The refusal then reached nobody, the attempt
counted as unproven, and the event was reported `atomic_finish_outcome_unknown`
with every table engine fenced. 12:47-15:47Z: 12 of 12 unknown outcomes ended
in `canceling statement due to lock timeout` or `supabase_timeout`.

## The Fix

1. `postHandTasks` invokes the hand-complete callback for every accepted hand.
   The zero-stack gate stays where it belongs, in the manager
   (`wireEliminationWake`): the witness is recorded for every hand and the
   elimination sweep is still woken only for a bust. A hand whose
   authoritative commit failed still reports nothing.
2. Every terminal completion attempt, replay and resolver call goes through
   `maintenanceSupabase`, whose 50-second deadline outlasts the functions' own
   45-second ceiling. Each attempt now ends in the database's answer: a
   receipt, or a SQLSTATE refusal that is retried as before.

No sweep, repair job or compensating write was added.

## What Happens To Events Already Behind

Nothing is rewritten. After the engine carrying this change is active, the
first hand on each table records the witness; an overdue level goes up once
and every later level runs its full duration from then. Blinds are corrected
going forward. They do not jump to where the schedule would have been, which
would post stacks that were played at the lower blinds into the pot before a
card is read.

## Tests

- `server/src/tournament/aLevelIsSpentByAnyDealtHand.test.ts`: the real
  `ServerTableEngine.postHandTasks` and the real manager wiring. Two tests
  fail on the gated engine and pass after.
- `server/src/tournament/aTerminalAnswerOutlastsItsCeiling.test.ts`: routing
  of every terminal call to the long-deadline client, a refusal stays proven,
  and the client deadline stays above 45 s. Two tests fail before.
- `tests/a-blind-level-is-not-spent-on-a-hand-that-was-never-dealt.law.test.ts`:
  new pin that the engine never gates the callback on a zero stack.
- Five existing source pins now name `terminalAuthority.rpc(`.

## Left Open, And Why

- Orphaned events (no lease, no hands, about 119): the committed but
  uncompleted F06 mixed custody transfers of 2026-09-26 09:33Z
  (`docs/changelog/2026-09-27-why-no-engine-release-landed-for-23-hours.md`
  section 3). Their clocks are correct in the database; they need their
  custody completed, not a clock change.
- Decided events waiting to finish: the elimination scheduler held 522 queued
  managers against four slots, oldest wait 931 s. A decided event reaches
  `finishTournament` late for that reason. That is the saturated-engine
  programme, not this change.
- The pool-finalization pair stays level-first until this engine is live and
  the per-event proof has been re-run (see the task report).
