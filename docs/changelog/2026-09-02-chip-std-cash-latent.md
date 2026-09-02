# 2026-09-02 - Chip Accounting Standard, Lane D: cash-side latent defects

Branch `fix/chip-std-cash-latent`. Standard: `docs/CHIP-ACCOUNTING-STANDARD.md`
section 2.3 (defects C1 C2 C3 C5 C6; C4 is a fork for Dan, below). Law:
`tests/law/OneCashOutPathOneSeatCreator.law.test.ts`.

This lane was resumed after the first agent was cut off with the main
migration ALREADY APPLIED and no engine or client code changed. The first
thing done on resumption was the urgent half of C3 (the engine did not know
a rebuy had become a pending row), then the rest.

## Migrations applied to production (all listed in `supabase_migrations.schema_migrations`)

| File                                                          | Applied (UTC)       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260902174500_cash_one_cashout_path_one_seat_creator.sql`   | 17:51 (prior agent) | C3 `atomic_table_rebuy` debits the wallet and writes `table_pending_addons(kind='rebuy')`, never `table_seats.stack`. C1 `atomic_table_cashout` is a wrapper over `atomic_seat_cashout_locked`; `atomic_table_withdraw` gains a key checked BEFORE the stack moves (4-arg overload dropped). C2 `fn_ca_guard_seat_creation` defined, five seat creators declare `app.money_path`, `seat_horse` dropped. C5 `player_leave_table` / `fn_cashout_seats_for_closing_table` declare `table_cashout`/`table_stack` and delegate. |
| `20260902174600_the_seat_guard_watches_before_it_refuses.sql` | 18:43               | Attaches `trg_ca_guard_seat_creation` to `table_seats` in DRY-RUN form (Dan's ruling: nothing high-risk for live play is enforced). The body LOGS what it would refuse to the new service-role-only table `ca_seat_guard_dryrun` and never raises. The never-applied `..._takes_its_lock_alone.sql` (which RAISED) was deleted from the worktree.                                                                                                                                                                          |
| `20260902185000_mirror_production_only_cash_rpcs.sql`         | 18:46               | C6 byte-exact mirror of `fn_ca_settle_hand_stacks_absolute` (the body Lane F installed at 17:44 today), `resolve_pending_addon`, `fn_add_chips`, `credit_club_wallet_rake`. Read over a READ ONLY `pg` connection (application_name `lane-d-mirror-readonly`); md5 of each body in the header; pre-flight aborts if production has moved on so a re-apply can never revert a newer body; post-apply md5 assertions passed, which also proves the transcription was exact.                                                  |

A fourth, grants-only file was added after the pre-push hook's
`check-definer-authorization` read the two files above and found three
SECURITY DEFINER writers with no grant statement in the file
(`fn_cashout_seats_for_closing_table`, `fn_ca_settle_hand_stacks_absolute`,
`credit_club_wallet_rake`). Production already held service_role-only EXECUTE
on all three (verified live first); `20260902192000_the_cash_definers_say_who_may_call.sql`
(applied 19:15 UTC, GRANT/REVOKE only, no PostgREST reload) states it in the
repo for those three plus `resolve_pending_addon`, `fn_add_chips` and
`player_leave_table`. One thing that file's header records for a follow-up:
`fn_ca_settle_hand_stacks_absolute` gates on `current_user IN ('postgres',
'service_role')`, which inside a SECURITY DEFINER body is the owner for every
caller; the grant is what keeps a browser off it. The body is Lane F's today
and a mirror must not edit it.

No money was moved by any migration. No probe touched a wallet.

## What was observed, not intended

- **No unresolved rebuy rows.** `select * from table_pending_addons where
created_at > now() - interval '2 hours'` returned zero rows at 18:25 UTC:
  nothing had gone through the new rebuy path yet, so nobody was stranded by
  the window between the RPC change and this engine fix landing. The engine
  half is not deployed until this PR merges and the :55 restart picks it up;
  until then a human bust rebuy lands as a row the running engine only sweeps
  at its next start. The stand-up grace (10s) then releases the seat and
  `resolve_pending_addon` refunds the wallet on the next start - the player is
  not out money, they are out a seat. This is why the PR is marked urgent.
- **The dry-run seat guard has logged nothing.** 10 seats were created in the
  minute after it attached; `ca_seat_guard_dryrun` stayed empty. Browser
  inserts into `table_seats` are already refused by RLS (policies: public
  read, service_role manages), so the guard's only live job today is to name
  any SECURITY DEFINER path that creates a funded seat without declaring
  itself.
- **The browser's cash leave has been failing since 2026-08-26.** EXECUTE on
  `atomic_table_cashout` was revoked from `authenticated` that day, and
  `TableService.leaveTable` still called it unconditionally, so every
  between-hands leave came back `success: false` with no error while the
  engine had already cashed the seat out. Money was never at risk (the engine
  path is keyed); the player lost their session summary and the app treated
  it as "no active seat". Fixed as part of C1 below.
- **There is no engine `/rebuy` route.** The brief asked for the sweep flag to
  be set from one. The browser calls `atomic_table_rebuy` directly, so the
  engine learns about a rebuy only by asking the ledger; it now asks in the
  two places that decide a busted seat's fate (the pause and the stand-up).
- **`record_table_cashout` is service-role only** but the browser calls it on
  the client-cleanup leave path. Pre-existing, unchanged: it warns and moves
  on. The 2-hour re-entry restriction it feeds has not been written by a
  browser leave since that revoke. Noted, not fixed - it is not a money path.

## C3 - the engine half of "a rebuy that cannot be erased"

`server/src/engine/ServerTableEngineBase.ts`

- `pendingAddOnSweepGen` beside `pendingAddOnSweepNeeded`, and
  `requestPendingAddOnSweep()`. The flag alone lost a race once rows could
  arrive from outside the engine: settlement step 8e and the rebuy pause run
  concurrently, and 8e's late "nothing pending, flag = false" erased a
  request the pause had just made. A sweep now clears the flag only if the
  generation it captured at start is unchanged.
- `usersWithPendingLedgerChips(userIds)`: which of these users have an
  unresolved `table_pending_addons` row (any kind) on this table; a hit
  requests a sweep; `null` when unreadable so each caller picks its own
  fail-open direction.
- `waitForRebuyDecisions`: after the stack read, an unresolved row counts as
  "the player answered". An unreadable ledger never shortens the pause.

`server/src/engine/ServerTableEngineSeating.ts`

- `processPendingAddOns` captures the generation and gates both flag clears
  on it; the mid-hand add-on path and the unresolved-row path use
  `requestPendingAddOnSweep()`.
- `leaveTable` return type gains `clientCashout?: boolean`, set on the
  reserved-seat ack only (see C1).

`server/src/engine/ServerTableEngineDealing.ts`

- `standUpBustedCashPlayers` asks the ledger for every broke seat before
  releasing any; a row keeps the seat and requests the sweep; an unreadable
  ledger stands nobody up this tick (the grace keeps running).

Order of operations after a bust, verified against the loop: pause (row
found, sweep requested), `await postHandTasksPromise` (8c `syncStacks` ran
before 8e, and 8e resolves rows into memory), `loadSeatedPlayers`, idle-tick
`processPendingAddOns` (before the active-player filter), deal. The chips are
in engine memory before the next absolute stack write, so `syncStacks`
persists 200, not the 0 it would have written before.

`src/pages/TablePage.tsx`: `confirmBustRebuy` mints ONE idempotency key per
(bust event, amount) in `bustRebuyKeyRef` and reuses it on retry; cleared
only when the RPC succeeds. It minted a fresh UUID per attempt, which is a
second debit in exactly the window the key exists for.

Test: `server/src/engine/RebuyRowCannotBeErased.test.ts` (8 tests): the
pause returns on a row and requests the sweep, waits the full window with no
row (negative control), the stand-up keeps a seat with a row / releases one
without / releases nobody on an unreadable ledger, the generation counter
survives a mid-read request and still clears in steady state, and the
end-to-end pause-then-sweep delivers the row into the next deal's memory
stack.

## C1 - one cash-out path, browser side

`src/services/TableService.ts` `leaveTable`, cash branch: when a LIVE engine
acknowledged the leave the engine owns the cash-out (it waits for settlement
to persist the final stack, then calls `atomicCashout`); the browser returns
`{ success: true, chipsReturned: 0, deferred: true }` and the session card
reconciles against the engine's `wallet_transactions` row exactly as it does
for a mid-hand leave. The browser cashes out only when the engine explicitly
hands it the cleanup: `clientCashout: true` (new; set by the `/leave`
handler's no-engine reply and by the engine's reserved-seat ack) or the older
no-engine `note`, and then through `atomic_seat_cashout_locked` (authenticated
may execute it, it guards `auth.uid() = p_user_id`, keyed per seat occupancy).
A browser cash-out racing the engine's would have credited the pre-hand stack
and stamped `left_at`, after which `fn_ca_settle_hand_stacks_absolute` refuses
the whole hand ("seat missing or left"); that race is now impossible.

Deploy skew: the client (Vercel via World Hub sync) and the engine (Hetzner
at :55) land at different times. Old client + new engine: unchanged from
today. New client + old engine: a RESERVED-seat leave (player never dealt in)
is deferred instead of cashed out by the browser, and the seat's buy-in is
returned by the sit-out eviction (`player_leave_table`, keyed) rather than
immediately. Bounded to at most one restart cycle; no money at risk.

`src/services/HydraService.ts` `removeHorse` refuses (reports
`HydraService.removeHorse_refused_client_cashout`, returns false). Its
`atomic_table_cashout` call was dead twice over: the revoke, and the RPC's own
`auth.uid() <> p_user_id` guard. The engine owns horse seats.

`tests/unit/tablePagesAuditRound9.test.ts`: the fork-position pin now names
`atomic_seat_cashout_locked`. Updated in the same commit as the behaviour.

## C2 - one seat creator, browser side

`HydraService.seatHorse` (browser `table_seats` INSERT with a browser-chosen
stack, no debit) deleted with its unused circuit breaker and three imports.
Its only caller, `seedTable`, has refused since 2026-08-28.
`src/services/TournamentService.ts:1325` still INSERTs tournament seats from
the browser (play chips, not wallet money); RLS refuses it today and the
dry-run guard would log it. Left for the tournament lanes.

## C4 - FORK FOR DAN (behaviour NOT changed)

`GameServer.cleanupStaleData` (`server/src/GameServer.ts` ~1990-2090) cashes
out and deletes HORSE seats only on boot; a human's seat survives a restart
and the engine rebuilds from it. That asymmetry was put in on 2026-08-18
after Dan was removed from a live table twice by the previous every-seat
sweep. CLAUDE.md 10.5 says horse and human treatment must be identical.
`TablePage.tsx` ~8200 tells the player the opposite of what happens. Options:

1. **Sweep nobody.** Horse seats survive restarts the way human seats do; the
   fleet re-adopts them (it already rebuilds from `table_seats`). Cost: a
   horse whose treasury club is gone sits with chips until the 4-hour
   orphan sweep. Simplest and identical.
2. **Sweep everyone.** Reintroduces the 2026-08-18 incident for humans. Not
   recommended.
3. **Keep the asymmetry** and document it as a sanctioned one like the
   hand-history retention rule.

Nothing in this PR changes which seats the boot sweep touches.

## Follow-ups

- **Enable the seat guard** once `ca_seat_guard_dryrun` has stayed empty for
  24 hours: swap the body back to the RAISE version in
  `20260902174500_...` (section 3) in a new migration. If rows appear, each
  names a seat creator to add to the sanctioned list or to fix first.
- Engine deploy of this PR is what closes the rebuy window; until the :55
  restart after merge, a human bust rebuy is delivered at the next engine
  start.

## Test output

- `cd server && npx vitest run src/engine src/handlers`: 152 files, 1709 tests passed.
- `npx vitest run tests/law/OneCashOutPathOneSeatCreator.law.test.ts`: 25 passed.
  Negative controls (each one pin red, files restored byte-identical, md5
  checked): generation gate removed; per-attempt rebuy UUID restored; a
  mirrored body edited; the guard made to RAISE; the browser made to always
  cash out; `removeHorse` regrown.
- `npx vitest run tests/unit/tablePagesAuditRound9.test.ts tests/unit/HydraService.test.ts tests/unit/HorseOrchestrator.test.ts tests/unit/cashoutAddonRace.test.ts tests/unit/tournamentShowdownAndLobbyRules.test.ts tests/unit/sessionSummaryPendingSettlement.test.tsx tests/unit/seatFirstExitAndRecovery.test.ts tests/unit/useTableStore.test.ts tests/all-in-cannot-leave-and-the-hud-slot.test.ts tests/unit/horsesAreTreatedIdentically.test.ts`: all green.
- `npx tsc --noEmit -p tsconfig.json` (root) and `npx tsc --noEmit` (server): clean.
