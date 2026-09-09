# 2026-09-08 — Final sweep: one door out for a busted seat, and four things the table said that were not true

Dan: "DO A FINAL SWEEP AND CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS,
REGRESSIONS OR WIRING ISSUES ANYWHERE AND EVERYWHERE." He does the live
verification; this is the code and the rows.

## How the sweep was run

Against `main` at `70acbb3fe0`: root and server `tsc` (clean), both suites
(client 17,283 / 17,283; server 7,741 / 7,741, 15 runtime-conditional
skips), `eslint src/` (0 errors), then three static sweeps (client wiring,
engine wiring, every `.rpc()` name against the live `pg_proc`) and a
production read of the cash board, the cluster event log, the financial
alerts and the reconciliation log.

What was NOT wrong, so nobody re-audits it: every RPC the client and the
engine call exists live (15 of them have no DDL in this repo, see "left");
zero unconditional test skips anywhere; zero real TODOs in `src/`; every
empty catch on a money path is a documented barrier with the real handler
elsewhere; every periodic sweep that moves money gates on the freeze except
the two named below; the horse data ledger is complete; the cluster board
had 0 games unticked, 0 seats at closed tables, 0 stale retire flags, and
its 45 `controller_tick_error` rows in 24 hours are 35 lock timeouts and 3
deadlocks across ~17,000 passes (each retried next pass) plus 6 from a
`pldbgapi2` debug session, not our SQL.

## Fixed here

### 1. One door out for a busted seat (10.5, 11.5)

Five copies of "this player is out of chips and not coming back" existed:
the human sweep in `standUpBustedCashPlayers`, two horse branches in
`recoverBustedSeatedHorses` (dead-table recovery), and two horse branches in
Settlement step 5. They disagreed in ways the felt could see:

- the human copy went through `atomicCashout` (the money path) and emitted
  `seat_left` only after the write confirmed; the four horse copies called
  `markSeatAsLeft` by hand;
- three of the four horse copies emitted **no `seat_left` at all**, so a
  busted horse's chair cleared on clients only when a snapshot happened to
  be diffed - the exact tell the 10.5 comment on the fourth copy was written
  to remove, still present on its three siblings;
- the fourth emitted `seat_left` **before** the write, so a failed write left
  every client showing an empty chair with the row still occupied;
- the Dealing sweep stopped a horse at a hard `>= 2` rebuys while Settlement
  had moved to the temperament's own `atRebuyStopLoss` - "two sites reloading
  on two different rules", in the words of the comment beside it.

`ServerTableEngineBase.releaseBustedSeat(player, reason)` is the one door:
`atomicCashout` (forced), then `seat_left`, then the trackers; on a failed
write it reports and returns false, and the caller leaves the roster alone
so the next sweep asks the same cashout again under the same idempotency
key. All five sites use it; both stop-loss checks are `atRebuyStopLoss`.
Reasons: `busted_no_rebuy`, `busted_stop_loss`, `busted_unfunded`.

### 2. Two seat-moving sweeps did not honour the freeze (13.5)

`standUpBustedCashPlayers` and `evictExpiredSitOuts` both cash players out
and neither checked `isMaintenanceFrozen()`, while the horse twin beside the
first checks it twice. The dealing loop parks on `maintenancePaused` before
either, but that flag is this engine's memory and the freeze is the
platform's - an engine booted mid-break has the one and not the other. The
gate the law names, in both, so it holds from every call site.

### 3. The off-path write queue spent its budget on the break

`pendingWrites` retries a money write the dealing path could not land, for
168 s. During the :55 break every such write is refused at the database
(`zz_freeze_guard`), so a write queued at the start of a five-minute break
burnt its whole budget on guaranteed refusals and then alarmed
(`alarmUnqueueableFee`) about chips that were never at risk. Frozen time is
now credited back to every entry and nothing is attempted while frozen.

### 4. A refused start left `engine.ready` pending for ever

`start()` throws three refusals before the `try` whose catch settles
`ready` false. A refused engine therefore left a promise nobody could
collect - and GameServer's readiness tracker, `GET /state`, `GET /actions`,
the tournament manager and the cluster controller's wake job all await it
with no deadline. Each refusal now settles `ready` false before it throws.

### 5. Three engines reported to a console line and nowhere else

`StraddleEngine`, `ChipRaceEngine` and `TableBreakEngine` were constructed
with a callback that was only `console.log`, the defect class
`InsuranceEngine` and `TableBalancer` were repaired for on 2026-08-28. A
straddle is real chips posted, a chip race a chip transfer, a table break a
seat path. They now go out on the table's hub in snake_case. The client has
no handler yet and ignores unknown types, so nothing changes on screen; what
changes is that the fact reaches the wire and the shadow recorder.

### 6. Four things the table said that were not true (client)

- **HandReveal** offered a greyed "Reveal (10)" button that could never
  fire: `TableModalsLayer` never passed `userDiamonds` or `onPayReveal`, so
  the defaults (0 < 10) disabled it for ever - a dead button on a diamond
  price, the InsuranceModal defect of 2026-08-26 one file over. The paid
  reveal renders only when a pay handler exists; a loser gets Done.
- **WaitListModal** quoted "Est. Wait" as (position - 1) x 5 minutes from a
  default no caller ever overrode. The estimate prints only when a real
  average is supplied; the position stands alone otherwise.
- **TournamentBreakScreen** was handed `currentLevel={0}`, `topPlayers={[]}`,
  `prizePool={0}` and one table's seats as the field, so every break in every
  tournament said "Coming Next: Level 1", a prize pool of 0, no leaders and
  no hero line. Given the tournament id and the hero it now reads the level,
  pool, field, top five stacks and the hero's rank from `tournaments` and
  `tournament_players` when it opens - the same rows the HUD and the info
  panel read. The props remain as overrides.

Tests: `tests/unit/finalSweep20260908.test.tsx` (10), `PendingWriteOutcome`
+1 (the freeze credit), `ReadyIsNotDealing` +2 (both refusals settle), and
the two pins that named the old shape (`SitOutClockAndEviction`,
`RebuyRowCannotBeErased`) moved onto the new door.

## Left, found and not changed here

- **15 live functions have no DDL in this repo** (`fn_next_hand_number`,
  `fn_consume_rabbit_hunt_v2`, `fn_ca_fleet_policy_effective`, five union
  settlement checks, seven client-side ones). All exist and work in
  production; a database rebuilt from migrations could not deal a hand. Mirror
  them with `scripts/dev/export-applied-migrations.sh`, and add a CI gate
  that every `.rpc('<name>')` resolves to a `CREATE FUNCTION` in
  `supabase/migrations/**`.
- **Horses always decline insurance** (`ServerTableEngineRunout.ts:3202`,
  "horse chips are house chips anyway") - a 100% deterministic decline is a
  tell and the reasoning is the class 10.5 forbids. Product behaviour; Dan's
  call whether horses take insurance at some rate.
- **`leave_blocked`** is broadcast on the hub and nothing in the client
  listens; the HTTP refusal (`LEAVE_LOCKED`) is handled, so this is a
  redundant channel, not a silent failure.
- **Nine table components import nothing and are imported by nothing**
  (1,366 lines; `PlayerStats`, `RealTimeResults`, the table
  `QuickActionsBar`, `SpectatorOverlay`, `SessionStatsTracker`, `TimeBank`,
  `TimeBankDisplay`, `PotOddsDisplay`, and `MiniStatsCard` reachable only
  from a test). Sweeps keep maintaining them. Delete in a PR of their own.
- **`TableMenu.badgeCount`** is never passed, so the menu badge can never
  render; **`STORAGE_KEYS.CLUB_ORDER`** is read and cleared but never
  written.
- **`eslint server/src`** has 47 errors, all cosmetic classes
  (`prefer-const`, `no-require-imports` in tests, `no-useless-escape`); the
  repo's lint script covers `src/` only.
- **5,261 open `financial_alerts`, 115 older than 24 hours**, and one
  `frozen_wallets_pool` critical in the last day. That is the chip-accounting
  programme's board (`HANDOFF-CHIP-ACCOUNTING-CURRENT-STATE.md`), not this
  sweep's; it is listed so the number is not mistaken for clean.
