# 2026-09-10 - Spin launch: terminal reasons park, transient reasons back off

Branch `fix/spin-launch-terminal-reasons-backoff`. Engine only; no database
function changed, `fn_create_seat_first_game_atomic` untouched (D3 is separate).

## What

`fn_spin_draw_and_settle_atomic` says why it refuses a launch. The engine now
reads that answer before deciding whether to ask again.

- **Terminal reasons** (deterministic for the launch state as it stands) are
  asked ONCE per launch. The tournament is parked in an in-process registry
  with an exponential window (30 s, doubling, 15-minute cap, jitter of up to
  20 percent taken off the step), one financial alert is raised through the
  platform's existing `raiseFinancialAlert` -> `fn_raise_server_financial_alert`
  path keyed by tournament + reason (a second alert only if the reason
  changes), and one line is logged at warn. An ok from the authority clears the
  park and the strike count.
- **Transient reasons** keep today's three in-attempt tries at 250/500 ms, but
  the manager restart cadence now backs off too: 5 s, doubling, same cap. No
  reason of any kind can drive more than one call a second at a tournament.
- Every start door consults the registry: the seat-first fast lane skips a
  parked id before it stops or restarts anything, and
  `ensureTournamentManagerAdmission` refuses a parked `'start'`, which also
  covers the main discovery loop and the fully-paid stall watchdog.

### Classification (read from the live function body via pg_get_functiondef)

Terminal: `invalid_launch_request`, `invalid_spin_contract`,
`spin_field_unproven`, `spin_entry_escrow_unproven`,
`spin_paid_entry_unproven`, `spin_receipt_roster_mismatch`,
`legacy_spin_rules_unproven`, `projected_spin_draw_has_no_funding_proof`,
`spin_rule_manifest_invalid`.

Transient: `launch_lease_lost`, `launch_receipt_state_mismatch`,
`entry_purchases_frozen`, plus RPC transport errors, raised exceptions
(P0404 from booking/draw/settlement) and any reason the engine has not seen
before (an unknown answer is retried the way it always was, and the restart
backoff still bounds it).

## Why

C-stuck-spins (2026-09-10): the authority refused every Spin on the board with
`projected_spin_draw_has_no_funding_proof` (column DEFAULT 0 on
`spin_multiplier`, since fixed by migration 20260910034412). The engine treated
it like a lost lease. Path, on origin/main at 4d29dce4cd:

- `server/src/tournament/TournamentManagerBase.ts:3312-3348` - `for (let
attempt = 1; attempt <= 3 && !fundedSpin; attempt++)` calls the RPC
  (`:3314`), throws on `error || !data?.ok` (`:3320-3322`), sleeps
  `250 * attempt` (`:3333`), then `reportError(... 'Tournament.spin_draw_unavailable')`
  and `this.running = false; return;` (`:3339-3348`).
- `server/src/GameServer.ts:243` `SEAT_FIRST_START_INTERVAL = 1000`;
  `discoverSeatFirstStarts` (`:6434-6562`) finds the held manager not running
  (`:6533-6540`, `stopTournamentManagerIfOwned`) and calls
  `ensureTournamentManagerAdmission(id, 'start', ...)` (`:6543-6552`). The
  stall watchdog (`:4973-5001`) and the main loop (`:4884-4913`) reach the same
  front door (`:1224`).

106 boards x 3 calls / ~3.6 s = ~87 calls/s: 163,460 calls, 1,347 s of
database CPU, on an answer that could not change until a migration changed it.

## Measurements

`spinLaunchParking.test.ts` simulates the fast lane ticking once a second for
three hours against a permanently terminal refusal: 16 calls (30+60+120+240+480
s of doubling, then 15-minute parks) and one alert, against ~3,000 calls before
this change. A transient refusal: 3 calls then 5 s, 3 then 10 s, 3 then 20 s.

## Files

- `server/src/tournament/spinLaunchParking.ts` (new): classification,
  `SpinLaunchParkRegistry`, `proveSpinDrawWithParking`.
- `server/src/tournament/TournamentManagerBase.ts`: the draw site calls
  `proveSpinDrawWithParking`; stand-down on `!proven.ok`.
- `server/src/GameServer.ts`: the fast lane skips a parked id; the admission
  front door refuses a parked `'start'`.
- Updated pins in the same commit (CLAUDE.md 5.8): `SpinDrawIntegrity.guard`,
  `TheWheelFiresOnTheDraw`, `TournamentLaunchBoundary.guard`,
  `SpinBookedTier`, `SpinRevealSettlementBoundary` (the last two execute the
  real start fragment and now inject the loop and the alert; the boundary
  spec gains four terminal-reason cases: one call, one alert), and in the
  client tree `tests/config/spinEngineWiring.test.ts` and
  `tests/config/spinNullMultiplierRepair.test.ts`, which read the manager
  source through the pre-push hook.

## How verified

- `cd server && npx vitest run` on the eleven specs that read or execute the
  draw site and the fast lane, plus the new `spinLaunchParking.test.ts`
  (24 tests): all green. `npx tsc --noEmit` clean.
- Not verified on live hardware: the refusal that caused the loop no longer
  occurs in production since the migration. The next deterministic refusal is
  the live test; the alert `Tournament.spin_launch_parked` is what to look for.

## Not done

- The registry is in-process; an engine restart forgets parks (one fresh
  attempt per tournament at boot, then the schedule resumes). A durable row
  was not added because it would need DDL, which this workstream may not do.
- The engine still never refunds or cancels on a terminal reason. Parking plus
  the alert is the whole action; a money decision is a migration with a
  receipt (CLAUDE.md 10.9).

## Review pass (same day, same branch)

Line-by-line review of the first commit; each finding fixed here, with a test.

- `spinLaunchParking.ts` (registry): nothing ever dropped the entry of a
  tournament that later left REGISTERING. `forgetIdle` ran only inside
  `park()` and only after the entry had been idle for twice the cap, so a
  Spin cancelled or completed while parked stayed in the map until some
  other tournament's park swept it. Added `retain(stillRegistering, readAt)`;
  the main discovery loop calls it with the REGISTERING board it just read
  (the same place `lastMttRampAt` is pruned). An entry written after the read
  is kept, so a Spin created and refused inside one pass is not un-parked by
  a board that predates it.
- `spinLaunchParking.ts` (alert): `deps.raiseAlert` was awaited unwrapped.
  `raiseFinancialAlert` never throws by contract, but the loop takes the
  function by injection; a rejection would have escaped into `start()` as an
  unhandled failure of a launch holding three paid seats. Wrapped; a failed
  alert is reported under `Tournament.spin_launch_parked_alert_failed` and
  the park stands.
- `GameServer.ts` (stall watchdog): the fully-paid stall watchdog reported
  `seat_first_fully_paid_never_started` ("force-starting") once per stall
  window for a parked id, then had its start refused at the front door. It
  now skips a parked id without touching its clock, so the first pass after
  the park ends acts at once.
- Observability: `/metrics` gains `poker_spin_launches_parked`,
  `poker_spin_launches_parked_terminal` and
  `poker_spin_launch_park_oldest_age_ms` (age measured from the streak's
  first strike, not its latest park); `/health` gains `spinLaunchParks`
  with the same numbers plus up to twenty ids with reason, kind, strikes and
  `parkedUntil`. An operator sees a parked Spin without reading logs.

Checked and left as is: every reason string in the live
`fn_spin_draw_and_settle_atomic` body (read again via `pg_get_functiondef`,
twelve reasons) is in exactly one of the two sets; the front door gates only
`'start'`, and the registry is written only from the Spin branch of
`start()`, so a non-Spin admission is never refused; jitter is subtracted
from a cap-clamped base, so no park exceeds fifteen minutes; the registry is
module-level, so it survives the stop-and-rebuild of the manager; only the
leader runs the launch path, so leader and standby do not park independently.

Verified: `cd server && npx tsc --noEmit` clean; `spinLaunchParking.test.ts`
(30 tests), the five engine pins, `spinsAreObservable.law`,
`seatFirstStartStall`, `DirectEngineRecovery.guard`,
`theFleetNobodyIsRunning`, and in the client tree `spinEngineWiring`,
`spinNullMultiplierRepair`, `humanIsNeverLeftWaiting`, `GameServerAPI`: all
green.
