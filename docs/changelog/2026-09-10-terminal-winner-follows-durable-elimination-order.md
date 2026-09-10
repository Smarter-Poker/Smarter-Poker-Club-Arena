# Terminal Winner Candidate Uses Durable Elimination Order

Observed September 10, 2026. Base: 09c01fba4.
Scope: the actual manager's zero-survivor finish path, including satellites.

## Root Cause And Correction

The manager selected the last eliminated entrant by eliminated_at. The atomic
satellite authority accepts the unique greatest elimination_sequence. Equal
timestamps and out-of-order callbacks therefore let the manager repeatedly
submit a candidate the database correctly refuses.

TournamentManagerEliminations.runEliminationSweep now filters out missing
sequences and submits the greatest durable sequence to finishTournament. An
absent witness remains pending and asks the existing scheduler for another
bounded pass. The database continues to validate the complete field and refuse
ambiguous or incomplete evidence. No new payer, compensating write, cron or
historical repair is introduced.

This corrects candidate selection, not the ranking policy that creates the
sequence. It does not settle ties by timestamp or infer that every simultaneous
elimination already follows industry rules.

## Executed Verification

- Root TypeScript check: exit 0.
- Server TypeScript check: exit 0 after using matchers supported by its types.
- Four focused server files: 80 tests passed.
- Eight new cases invoke the actual manager method with isolated transport:
  reversed timestamps in satellite and MTT, equal timestamps, unsequenced rows,
  absent witness, count/read failures, and a surviving player.
- Reinstating only the old timestamp query made four of those eight cases fail.
  The corrected source was restored before final verification.
- git diff --check: exit 0.

The new test controls database transport and finishTournament to inspect which
candidate reaches the existing atomic authority. It does not claim a live
PostgreSQL payout, installed engine adoption, or whole Phase 3 completion.

## Industry Comparison And Remaining Satellite Work

Primary sources retrieved September 10, 2026:

- https://www.pokerstars.com/poker/tournaments/rules/ (rules 2.1, 2.2 and 2.3).
- https://www.pokerstars.com/poker/tournaments/types/ (Satellites).

PokerStars ends equal-prize events when the remaining field receives identical
awards. Same-hand eliminations use hand-start stacks; equal stacks share rank
and prizes. A synchronized hand-for-hand batch treats eliminations across
tables as simultaneous. These are published operator rules, not evidence that
one universal cash-substitution policy applies to Smarter.Poker.

B11 remains open: the offered multi-seat satellite still reaches completion
only with at most one survivor, and the atomic finalizer requires one winner
plus uniquely sequenced eliminated entrants. A proper multi-survivor change
must coordinate synchronized hand completion, tied placement representation,
threshold-crossing recipients, and the existing atomic receipt. Merely raising
the manager's stopping threshold would still be rejected by the database.

The payout lane independently confirmed T08's current sequence reflects commit
order and does not yet establish the required shared-hand tie contract.
Existing cash substitution and ordinary-cash satellite refund rules remain
governed by docs/LAWS.md. Upstream #4096 preserves prior refund acceptance but
explicitly leaves source-to-target escrow acceptance open; it does not close
B07-B11. No shared progress-register states were changed in this lane.
