# A break the sweep starts is finished (2026-09-29)

## What was wrong

The $100 Freeroll 6:00 AM (87a68e55, 41 playing) and $100 Freeroll 6:00 PM
(cb8f2dd1, 48 playing) stopped dealing around 03:31Z and 03:34Z with 33 and 37
one-player tables. Their table breaks (`smarter_private.f06_operations`) never
reached `acknowledged`. Read at 04:32-04:37Z:

| event    | break    | source   | state           | rev | custody generation | members / winners / seated |
| -------- | -------- | -------- | --------------- | --- | ------------------ | -------------------------- |
| 87a68e55 | 390e1e90 | e56c79b2 | begun           | 8   | c8ceea24 (live)    | 3 / 0 / 3, then 3 / 3 / 0  |
| 87a68e55 | a119a63b | f0d514bb | park_requested  | 8   | c8ceea24 (live)    | pre-manifest, 3 seated     |
| 87a68e55 | c0328a41 | fe583a79 | begun           | 8   | c8ceea24 (live)    | 3 / 1 / 2                  |
| 87a68e55 | 192437a7 | b66887e4 | begun           | 8   | c8ceea24 (live)    | 3 / 3 / 0                  |
| 87a68e55 | 4576ca30 | bbbd1f5a | begun           | 11  | c8ceea24 (live)    | 3 / 3 / 0                  |
| 87a68e55 | 7b44499f | aa24784d | close_confirmed | 3   | 301699b5 (dead)    | 3 / 3 / 0, table closed    |
| 87a68e55 | 086b55a3 | b806b939 | close_confirmed | 5   | 2b8de265 (dead)    | 3 / 3 / 0, table closed    |
| cb8f2dd1 | f1af44bb | f8d9e48b | begun           | 8   | cdcc68e1 (live)    | 2 / 0 / 2                  |
| cb8f2dd1 | 57b3961c | d5fbf305 | park_requested  | 8   | cdcc68e1 (live)    | pre-manifest, 3 seated     |
| cb8f2dd1 | b862c92e | 68206216 | park_requested  | 8   | cdcc68e1 (live)    | pre-manifest, 3 seated     |
| cb8f2dd1 | e487977d | b6af1747 | park_requested  | 9   | cdcc68e1 (live)    | pre-manifest, 3 seated     |
| cb8f2dd1 | eb53ed4f | d6873e2b | close_confirmed | 2   | 0d8cef85 (dead)    | 2 / 2 / 0, table closed    |

None of them was refused. None was being visited. The engine log since the
03:55Z restart names only one of the twelve (`Break f1af44bb members not
dispatched: destinations_unread`, 04:30:36Z), and the discovery cursor
(`smarter_private.f06_cursors`) of 87a68e55 went from revision 28 to 29 in
fifteen minutes (04:22-04:37Z) while its live generation held the lease; that
one visit moved break 390e1e90's three players at 04:34:33Z. cb8f2dd1's cursor
advanced once in the same window.

Three things compounded, all in `TournamentManager.visitTournamentBreakPage`:

1. **The work budget cut a visit wherever it ran out.** Every step of a visit
   (`tableBreakRpc()`, `eligibleBreakDestinations`, the retirement `current()`
   closure, the dispatch guards) asks `eliminationMutationAllowed()`, which is
   false once the sweep's five-second budget (`SWEEP_WORK_BUDGET_MS`) is
   spent. The elimination scheduler had 223 managers queued on four slots with
   an oldest wait of 277 s, and the balance stage runs late in an admission,
   so a visit started with little budget left and stopped after the claim, or
   inside the destination read (that is what `destinations_unread` was: the
   `tables` read returned, then the budget said no).
2. **The cursor had already moved on.** `fn_f06_discover_breaks` advances the
   server cursor before the visit, so the half-visited break was not looked at
   again until every other open operation had had its one visit per admitted
   balance stage. At one operation per admission and an admission every five
   minutes or more, a round of seven operations is well over half an hour.
3. **Every new lease generation wasted its first pass.** The manager's cursor
   revision starts at `'0'`, so its first discovery is always
   `cursor_revision_conflict`; the conflict returns the real revision, but the
   pass ended there. During the lease storm the generations of both events
   changed every four to five minutes (04:08, 04:13, 04:17, 04:21Z), so most
   generations never visited a single break.

The pieces that complete a break are sound: break aec45ff6 (source 54f49f08),
close_confirmed in the custody of dead generation b16497dd, was claimed by the
live generation c8ceea24 through `fn_f06_claim_custody` (revision CAS),
acknowledged `verified_absent`, and released, as soon as it was visited.

## What changed

`server/src/tournament/TournamentManager.ts`:

- **Discovering one operation and visiting it is one unit.** A window
  (`tournamentBreakVisitOpen`) opens before the discovery call advances the
  cursor and closes when that operation's visit returns. While it is open the
  spent work budget does not refuse the visit's steps; manager stop and the
  sweep's abort still do. This is the rule the bust stage adopted on
  2026-09-27 (`openEliminationMutationBatch`): the clock decides only whether
  a pass may START. The unit is bounded: one operation, at most ten members, a
  fixed sequence of receipted doors.
- **The clock is asked again after each unit.** Further operations are
  visited in the same admission only while the budget remains, each at most
  once per pass; an empty page or a wrap back to an operation already visited
  ends the pass. Retained ACK cleanup still rides with the first page only.
- **A cursor conflict is answered in the same pass**, with the revision the
  conflict returned. A second conflict (another writer) ends the pass and is
  logged once.
- **Every early exit names itself** (CLAUDE.md 10.86 rule 1):
  `retireTournamentBreak` logs `Break <id> not retired: <reason>`
  (`members_unresolved:<n>_of_<m>`, `terminal_handoff_required`,
  `manager_authority_unavailable`, `reconcile_refused:<reason>`,
  `state_not_retirable:<state>`, `original_owner_lifecycle_changed`) once per
  change, and `destinations_unread` now carries why the destination read
  answered null (`mutation_not_allowed`, `tables_unread:<message>`,
  `balancer_snapshot_incomplete`).

No SQL, no migration, no scheduler change, no new job. Every chip still moves
only through the existing receipted doors (`fn_move_tournament_player` via the
break attempts, `fn_f06_close_break`, `fn_f06_ack_cleanup`), and every other
case still refuses exactly as before.

## Pinned by

- `server/src/tournament/aBreakTheSweepStartsIsFinished.law.test.ts` (new):
  six of its seven pins fail on the previous `TournamentManager.ts`.
- `server/src/tournament/aRefusedBreakRosterIsReread.law.test.ts`: the
  `destinations_unread` case now carries its reason.

## Not in this change

- The elimination scheduler's throughput (223 queued, 277 s oldest wait) is
  the scheduler stream's work. This change makes each admitted balance stage
  finish what it starts and use the budget it has; it does not admit sweeps
  more often.
- The lease storm itself (generations expiring every few minutes) is owned by
  the lease work.
