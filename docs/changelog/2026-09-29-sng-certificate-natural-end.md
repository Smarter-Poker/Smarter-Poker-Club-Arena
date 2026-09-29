# 2026-09-29: the SNG live-table certificate tells a finished board from a lost table

Scope: `tests/e2e/production-live-table-realtime.spec.ts` (the SNG case of the
post-deploy "Live-table and engine verification" job) and its support files.
No engine or client source changes, no production writes, no synthetic hands.

## What the two SNG failures actually were

Both were traced from the run artifacts (Playwright JSON report, journal
attachments, trace) and the database. The first hypothesis, "the heads-up
board finished naturally and the spec read that as a transport failure", was
**wrong for both runs**.

### Run 36511851995 (engine fa480b9b): "SNG dce2f701 was unsubscribed while under observation"

- The case did not fail at the unsubscribe. It failed at the very last
  assertion, after the gameplay cycle, the forced network loss, the reconnect
  and every one-owner check had already passed. Table `dce2f701` kept dealing
  for another hour (its tournament was stamped COMPLETED at 03:19 UTC, the
  case ran at 02:26).
- The journal shows, on socket 1: SUBSCRIBE 1790648804709, SUBSCRIBE
  1790648805578, then **UNSUBSCRIBE and SUBSCRIBE in the same millisecond,
  1790648806188**, 1.7 s after navigation and before the table route had
  mounted. That is the client handing its facade over while the felt mounts
  (`EngineSocketMux.release()` followed by `acquire()` on the same transport).
  The observed hand cycle began about 700 ms later.
- The spec already accepts extra SUBSCRIBE frames during that window
  (`assertInitialTableOwnership`) but its last assertion counted any
  UNSUBSCRIBE since navigation, so the two halves of one handoff were judged by
  different rules. It fails only when the handoff happens to land, which is
  timing, which is why MTT and Spin usually pass.

### Run 36519478277 (engine c0c986ad): "did not resume causal gameplay after reconnect: no live poker event for 45099ms"

- The journal ends with `engine_restarting` for table `a93b5449` at 04:13:34.
  The engine log for that table reads `watchdog_kill: Engine self-terminating
  for restart: tournament_lease_lost`, then `hand number pre-allocation failed
  ... f06_allocation_unproven`, then `Stopped. Dealt 43 hands`, `Created`,
  `Last persisted hand on this table: #17175287`. `hand_history` has a 91 s gap
  (04:13:12 to 04:14:43) and then hands resume at their usual pace.
- That is the engine rebuilding one table under a spectator: an **engine
  defect**, not a natural ending and not a browser fault. The same window
  carries the "production had stalled tables before observation" refusal in
  the cash case, which ran right after: the cash case read health while tables
  were being rebuilt.
- The engine had 957 `tournament_lease_lost`, 498 `tournament_lease_proof_expired`
  and 1361 `start_failed:start_load_table` self-terminations since it started
  at 03:56 UTC (`docker logs`, counted by reason). This is engine-wide, not
  specific to this table, and it is outside this change.

## What a natural ending looks like (measured, and why it needed its own rule)

A heads-up SNG lasts 2 to 28 minutes and its finishing hand is nobody's fault.
The rows do not say COMPLETED when it happens. Read from production: a busted
board sits at `tournaments.status = RUNNING`, `current_players = 1`,
`tables.status = waiting`, one `table_seats` row, the loser in
`tournament_players` with `chips = 0` and `status = 'playing'`, for **10 to 20
minutes** before the tournament is stamped COMPLETED (for example NLH Heads-Up
20: last hand 04:07:55, still RUNNING at 04:27). A rule that waited for
`COMPLETED` would never fire inside a two-minute case.

## What changed in the certificate

- **`classifyUnsubscribes`** (`support/initialTableOwnership.ts`): the final
  "never unsubscribed" assertion now accepts exactly the mounting handoff and
  nothing else: an UNSUBSCRIBE on the observed transport, before the observed
  hand cycle begins, paired with a SUBSCRIBE on the same transport within 250
  ms, at most twice. An UNSUBSCRIBE during or after the observed hand cycle,
  on the recovered transport, without its partner, or a third handoff is still
  a violation and still fails with the original message. Accepted handoffs are
  attached to the report as `<tag>-initial-handoffs`.
- **`support/tournamentBoardEnding.ts`** (new, pure):
  - `classifyBoardEnding` reads the rows above: COMPLETED, or RUNNING with one
    survivor and a table that stopped dealing, is a natural completion.
    CANCELLED and every unknown state is not.
  - `boardEnduranceBigBlinds` / `orderByEndurance`: SNG selection now prefers
    the deepest boards (shorter stack in big blinds, from public `table_seats`
    and `tournaments.blind_level_state`), never selects a board that already
    ended or is one settled hand from ending, and re-reads the rows at
    acceptance so the very hand that made a table progress cannot have been its
    last.
  - `classifyCaseFailure`: after a SNG case fails, the failure is reclassified
    from evidence only. A table the engine rebuilt (`engine_restarting`) is
    named `TABLE ENGINE RESTARTED DURING OBSERVATION` and outranks everything.
    A natural completion needs the board proven RUNNING with 2+ players at
    selection, proven finished at failure, and silence that began at a hand
    boundary. Anything else is rethrown untouched with its evidence attached as
    `<tag>-failure-classification`.
  - `decideReselection`: a proven natural completion takes another
    already-running SNG, at most twice, only while at least 150 s of the case's
    one fixed deadline remain, never a board already watched. The case timeout
    is unchanged (390 s). Nothing retries a board, retries a failure, or turns
    an unproven failure green. If no board can be observed the case fails with
    every ending listed.
- Every existing assertion is kept: one owner, one subscription, no duplicate
  owners, no refusal, gameplay resumes after reconnect, release identity
  stable, spectator mutations refused. A re-selected board runs the whole case
  again from a fresh page.

## Tests

`tests/unit/sngNaturalEndCertificate.test.ts` (planted red: nine mutations of
the classifiers and the spec wiring each turn it red; the module does not exist
on main), and `liveTableRealtimeFormats.guard.test.ts` moved to the new
selection signature and to the post-recovery HUD reader.

## Not fixed here, and named

The `tournament_lease_lost` / `tournament_lease_proof_expired` storm and the
10 to 20 minute lag between a heads-up board's finishing hand and its
COMPLETED stamp are engine behaviours. The certificate reports them
faithfully; it does not paper over them.
