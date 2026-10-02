# A ledger-refused hand is held, not replayed and rebuilt

2026-10-02. Launch plan phase 1a: a ledger-invariant refusal must never fail
silently. This is the engine half. The database half records each refusal
outside its rollback (migration 20261002135708, see
`2026-10-02-a-ledger-refusal-is-recorded-outside-its-rollback.md`).

## What the engine did with a refused hand

The ledger invariant can refuse the accepted-hand transaction at COMMIT
(`fn_ca_commit_hand_settlement` or `fn_ca_commit_hand_submission`). PostgREST
then returns `{ code: '23514', message: 'REFUSED: balance_moved_...' }`.
`logHandHistory` never read the code, so the error counted as an ambiguous lost
response. What followed:

- Thirteen identical replays, about 41 s of sleep plus up to 15 s per call.
- `[DB] authoritative hand commit failed ... after 13 identical attempts`.
- `killForRestart('authoritative_hand_unreachable')` and a critical
  `ServerTableEngine.authoritative_hand_unreachable` alert, which named the
  wrong cause.
- The successor asked `fn_ca_resume_hand_submission` for the retained hand and
  was refused the same way. `REFUSED:` was not a standing refusal, so this
  became `retained_hand_submission_readback_failed`, then `start_failed`, then a
  rebuild about every five seconds. The table never dealt again.

The rollback had already left every seat at its pre-hand stack. No chip moved.

## What it does now

- `isLedgerInvariantRefusal(error)` matches SQLSTATE 23514 plus the two
  refusal names, and nothing else. Other 23514 errors, such as
  `tournament_full` and the four-table limit, are untouched.
- **In the commit loop** the refusal becomes
  `atomic hand commit refused (ledger_invariant): <message>`. That is
  deterministic, so it gets one attempt and no replay. The existing semantic
  path then terminates the generation and raises
  `ServerTableEngine.authoritative_hand_semantic_refusal`, once per table and
  hand, carrying the refusal text.
- **At restart**, `resumeRetainedHandSubmission` names the refusal as a
  standing one (`RetainedHandSubmissionRefusedError`, code
  `LEDGER_INVARIANT_REFUSED`). The table is held the way every other standing
  refusal has been held since 2026-09-29 (`GameServer.holdRetainedHandRefusal`):
  exact lease release, one report, a recheck on its own schedule, and no
  watchdog rebuild loop.

## Why the hand is held, not voided

The refused hand has a winner. Voiding it automatically would take the pot from
that winner because of a defect in our door (CLAUDE.md 10.9 rule 3). The
retained submission and the pre-hand stacks are both intact. When the door is
fixed, the same request replays and pays exactly what was won. Meanwhile the
refusal is a critical incident on the drift board, carrying the account, the
amounts and the function.

## Proof

`server/src/services/supabase/handHistory.test.ts`, "a ledger-invariant refusal
of a hand":

- The classifier matches both refusal names and nothing else.
- Through the direct door and through the retained-submission door, the hand is
  refused once, by name, never replayed and never swallowed.
- A lost response is still replayed.
- A restarted engine whose retained hand is refused gets the standing refusal,
  while a statement timeout stays transient.
