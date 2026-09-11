# Workflow evidence: batch-decided-running-sweep

- run: wf_ea8b680c-2d3
- finished: 2026-09-11T08:25:32.155Z
- status: completed
- agents: 1
- summary: Batch the serial decided-but-RUNNING count sweep in the REGISTERING pass (368 serial counts, ~40 s)

## status

committed

## branch

perf/the-decided-sweep-counts-in-one-read

## commit

b25bcdc80348acdd82959e32f99c26474a58de7a

## worktree

/Users/smarter.poker/Documents/.agent-trees/club-arena/claude-decided-sweep

## summary

The decided-but-RUNNING sweep no longer runs one exact count per tournament. Committed locally on top of origin/main 53edbd4d10. Not pushed, no PR.

What changed:

- New file server/src/tournament/decidedRunningBoard.ts. It imports only the pagination helper (fetchAllRows), IN_LIST_CHUNK and reportError.
  - readPlayingCounts(ids, page, opts) dedupes the ids, splits them into chunks of 200, pages each chunk to the end by keyset on tournament_players.id, and never throws. Each chunk stands on its own: if one chunk fails, the chunks after it are still read.
  - decidedRunningVerdicts(reads) turns the rows and read status into one verdict per tournament: unknown, live(n), or decided(n) for 0 or 1 playing. verdictFor(map, id) returns unknown for any id no read covered.
- In GameServer.ts the sweep keeps the same board read. It now calls readPlayingCounts with a closure: `from('tournament_players').select('id, tournament_id').eq('status','playing').in('tournament_id', chunk).order('id',{ascending:true}).limit(want)` plus `gt('id', cursor)`.
  - The loop skips unknown before anything else (the PAYOUT-INTEGRITY comment is kept), then skips live.
  - The existing "is decided (N playing) - recovering the winner" log line is unchanged, and so are both recoveries: `requestEliminationSweep('stalled_decided_survivor')` on an existing manager, otherwise the same `ensureTournamentManagerAdmission(..., 'resume', ...)` / 'GameServer.stalled_decided_resume_failed' path.
  - One new warn line reports how many counts could not be read.
- Payout-integrity rule: any chunk whose read did not finish makes every tournament in it UNKNOWN, including one it had already seen a single row for. That covers a page that still fails after retries, the row ceiling, a missing cursor column, and a throw.
- Addition you did not ask for: recoveries are spaced DECIDED_RECOVERY_STAGGER_MS = 110 ms apart. The serial counts were the sweep's only brake. Without them, after a restart every managerless decided tournament would be resumed at once, which is the 2026-09-10 storm. On every pass, every managed one would also be queued as an urgent sweep at once on the 4-slot elimination scheduler. The first recovery never waits, the manager is looked up after the wait, and the loop stops if the generation is fenced.

Expected pass-time change (not yet measured on production):

- Sweep read cost goes from N x ~110 ms to about 0.5-0.7 s. That is about 40 s at the investigator's N=368, and about 75 s at N=683, measured at 08:06 UTC.
- The 683-tournament board with 2,387 playing rows is 4 chunks and about 5 requests. EXPLAIN ANALYZE shows 3-10 ms per page on the database, using idx_tournament_players_status for both page 1 and page 2.
- On a board with few decided tournaments, every discovery pass should be about 40-75 s shorter.
- Tonight it will not be: with K decided tournaments the spacing adds (K-1) x 110 ms. At 08:06 UTC 562 of the 683 were decided, so the sweep still takes about 62 s and a pass improves by only about 13 s until that backlog clears.

## tests_run

All run in the worktree on the Mac. vitest runs from server/ unless noted.

- server/src/tournament/decidedRunningBoard.test.ts: 24/24 pass.
  - 17 tests of the read and the verdicts: 0, 1 and 2+ playing; incomplete page leads to unknown, including the case where page one showed a Spin with 1 row and page two failed; failed chunk leads to unknown while other chunks stand; a throw; the row ceiling; a missing cursor column; a transient failure that the retry recovers; dedupe/blank/200-cap; empty board; 8 random seeded boards against the per-tournament count, including the exact request count.
  - 7 source pins on GameServer: uses the batch; no supabase/.from/.rpc/count inside the loop and the only await is the spacing sleep; the query shape; unknown and live skipped before the log; log line and both recoveries unchanged; spacing guarded and first recovery never waits; unread-count warn.
- Pagination and law tests pass: PagedReadsAreDeterministic.law, PagedReadsCannotLieAboutBeingComplete, paginationCursorKey.guard, supabase/pagination.test, SqueezeAndPagination.law, plus aStalledTournamentIsNoticed.law and TournamentFixes.guard. Together that is 8 files and 127 tests.
- All 64 server test files that read GameServer.ts, plus the above: 69 files, 903 tests pass.
- Full server suite: 672 files pass, 1 skipped; 9,242 tests pass, 145 skipped.
- Root (repo-level vitest): the 18 test files that read GameServer.ts pass, 252 tests. The full root suite has 1,384 of 1,386 files passing. The 2 failures are nativeForegroundAndLocalNotifications and nativeStoreAndPush, which cannot resolve @capacitor/app and @capacitor/push-notifications from the shared node_modules. They are client native code, not affected by this change.
- tsc --noEmit -p server/tsconfig.json: clean, before and after formatting.
- prettier --check: clean on all 3 files. eslint: clean on the 2 new files.
- The pre-commit hooks (identity/clone/mass-deletion guards and lint-staged prettier) ran and passed; the commit did not use --no-verify.

## proved_failing_on_old_code

(1) Full origin/main tree plus the new test file: the file fails to load with "Failed to resolve ./decidedRunningBoard.js", so no test runs and the exit is 1.
(2) New helper present but GameServer.ts restored from origin/main: all 7 GameServer wiring pins fail and the 17 helper tests pass (7 failed | 17 passed). The failures are:

- "no longer awaits a count - or any read - inside the loop" and three other pins: sliceMethod cannot find "for (const t of decidedBoard)".
- "builds its verdicts from one batched read": GameServer does not import decidedRunningBoard.js.
- "reads the same rows the old count counted": the sweep has no .select('id, tournament_id').
- "says so when a count could not be read": no decidedUnread warn.
  After both runs the new GameServer and helper were restored and the full suites were re-run green. No existing test pinned the old loop: I grepped server/src and tests/ for stalled_decided_survivor, 'is decided', maybeDecided, decidedCutoff and the log text. The only matches were the engine's own playingCount pins and the never-dealt sweep's stillPlaying pin, and none of them change.

## concerns

```json
[
  "Behaviour choice beyond the literal ask: I added 110 ms spacing between recoveries (DECIDED_RECOVERY_STAGGER_MS). This keeps the old maximum rate at which the sweep resumes or wakes tournaments. Without it, removing the reads would turn a large decided board into one burst of resumes after a restart and one burst of urgent wakes every pass. The catch is that tonight's pass only gets about 13 s faster, not 40-75 s. If you want the full gain even with a big backlog, the wake branch could go unspaced, since the scheduler caps concurrency at 4 and dedupes per tournament, at the cost of live tournaments' eliminations queueing behind the decided ones. The resume branch should stay spaced either way.",
  "Production observation, separate P0 (read-only SELECTs, 08:06 UTC): 562 of 683 RUNNING tournaments started more than 10 minutes ago have exactly 1 playing row. All 562 are under live leases held by the single instance 1-941a631f (engine c58dfafd). The count went from 401 to 465 to 562 within about 20 minutes. Completions collapsed after about 03:00 UTC: 2-3 per 20 minutes now, against 4,531 in 24 hours. engine_alerts has ClubArenaEngineKillStorm firing (1,428 kills in 15 minutes at 07:01). The stalled_decided_survivor wake is not finishing these tournaments. That is why the pass-time gain is small tonight, and it should be chased separately.",
  "Left unchanged, and it predates this change: the candidate board read (tournaments RUNNING and started_at older than 10 minutes) has no ORDER BY, is not paged, and ignores its error. It fails safe, because nothing unread is treated as decided, but beyond PostgREST's 1,000-row limit the extra RUNNING tournaments would silently never be checked. Today there are 683.",
  "A chunk that needs more than one page is not a single snapshot. In a narrow race, a count can come out low: for example, a rebuy on page one's side of the cursor and an elimination on page two's side, both within one round trip. That can only cause an extra wake or resume, never a payment: the manager's finish stage re-reads its own exact count, and skips the cycle if that count is unreadable, before finishing anything. Failed or incomplete reads are still always treated as unknown.",
  "eslint reports 2 prefer-const errors in GameServer.ts at lines 695 and 827 that predate this change and were not touched; lint-staged does not run eslint on server files."
]
```
