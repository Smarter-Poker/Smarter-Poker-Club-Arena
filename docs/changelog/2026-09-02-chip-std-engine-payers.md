# 2026-09-02 - chip standard, Lane A2: every engine tournament credit goes through `fn_settle_tournament_obligation`

Branch `fix/chip-std-engine-payers`. Implements `docs/CHIP-ACCOUNTING-STANDARD.md`
3.2 step 5 / rule R3 on the ENGINE side: the only thing in `server/src` that
credits a player from a tournament is now one module,
`server/src/tournament/settleObligation.ts`, and the only RPC it calls is
`fn_settle_tournament_obligation` (Lane A's, signature in
`docs/SWARM-BRIEF-CHIP-STANDARD.md`). No SQL in this lane.

**Depends on Lane A's migration (`tournament_obligations` +
`fn_settle_tournament_obligation`). Do not merge before it.** Verified against
`pg_proc` while writing this: the RPC does not exist in production yet
(`fn_settle_tournament_obligation` returned no row). Every test in this lane
mocks it.

## What was observed before the change

Eight direct `fn_credit_and_log` sites in the engine, each carrying its own
hand-built `tourney:` idempotency key, each with its own idea of what was owed.
The standard's 2.2 measured the result: 5,330 chips overpaid across 82 MTT
events in 36 hours. Two of the eight sites put the AMOUNT in the key
(`prizeadj:{user}:{place}:{amount}`), so a re-run after the pool changed was a
brand-new payment on top of the old one.

## Sites repointed (file:line before -> after)

| #   | Path                                                     | Before (`origin/main`)                                                                                                                                                     | After                                                                                                                                                                    | Obligation                                        |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 1   | `server/src/tournament/TournamentManagerEliminations.ts` | :1628 `rpc('fn_credit_and_log')` key `tourney:{id}:prize:place:{position}`, 3x retry loop                                                                                  | :1631 `settleTournamentObligation(...)`                                                                                                                                  | `kind:'place', place:N` (places 2..N at bust)     |
| 2   | `server/src/tournament/TournamentManagerEliminations.ts` | :1734 `rpc('fn_credit_and_log')` key `tourney:{id}:bubbleprotection:{user}`                                                                                                | :1713 `settleTournamentObligation(...)`                                                                                                                                  | `kind:'bubble_protection'`, user-keyed            |
| 3   | `server/src/tournament/TournamentManagerEliminations.ts` | :2890 `rpc('fn_credit_and_log')` amount `difference`, key `tourney:{id}:prizeadj:{user}:{place}:{correctPrize}`                                                            | :2884 `settleTournamentObligation(...)` amount **`correctPrize`** (what is owed; the RPC pays the delta)                                                                 | `kind:'late_reg_adjustment', place:N`             |
| 4   | `server/src/tournament/TournamentManagerEliminations.ts` | :3164 `rpc('fn_credit_and_log')` key `tourney:{id}:ftd:{user}`                                                                                                             | :3155 `settleTournamentObligation(...)`                                                                                                                                  | `kind:'final_table_deal'`, user-keyed             |
| 5   | `server/src/tournament/TournamentManagerEliminations.ts` | :3559 `rpc('fn_credit_and_log')` key `tourney:{id}:prize:place:1`, 3x retry loop                                                                                           | :3552 `settleTournamentObligation(...)`                                                                                                                                  | `kind:'place', place:1` (winner at finish)        |
| 6   | `server/src/tournament/tournamentRecovery.ts`            | :157 `rpc('fn_credit_and_log')` key `tourney:{id}:cancelrefund:{row.id}`                                                                                                   | :162 `settleTournamentObligation(...)`                                                                                                                                   | `kind:'refund'`, user-keyed (cancel refunds)      |
| 7   | `server/src/tournament/tournamentRecovery.ts`            | :674 inner `credit()` -> `rpc('fn_credit_and_log')`; step 2 key `tourney:{id}:prize:place:{place}` (:872), step 3 key `tourney:{id}:prizeadj:{user}:{place}:{owed}` (:935) | :680 inner `credit()` -> `settleTournamentObligation(...)`; step 2 `{kind:'place', place}` (:885), step 3 `{kind:'late_reg_adjustment', place}` amount **`owed`** (:951) | stuck-COMPLETING places + top-ups                 |
| 8   | `server/src/tournament/TournamentManager.ts`             | :785 `payCash()` -> `rpc('fn_credit_and_log')`; four `prize:place:{position}` sites (:810, :867, :896, :946) and one `satremainder:{user}:{position}` (:979)               | :788 `payCash()` -> `settleTournamentObligation(...)`; `{kind:'place', place}` at :814, :871, :900, :950; `{kind:'satellite_remainder'}` at :983                         | satellite cash fallbacks + remainder (user-keyed) |

Line numbers are from the diff as committed; they will drift.

## Sites enumerated and deliberately LEFT ALONE (Lane A repoints them inside the database)

These engine calls do not credit a player themselves; they call a database
function that does. Each of those functions is on Lane A's list in the
standard, section 5, and Lane A repoints its internals at
`fn_settle_tournament_obligation`. Changing the engine call would only add a
second caller.

| Path                                                          | Call                                     | Why untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/src/tournament/TournamentManagerEliminations.ts:2000` | `rpc('fn_collect_bounty')`               | PKO/bounty collection; the task brief says leave it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `server/src/tournament/TournamentManagerEliminations.ts:2717` | `rpc('fn_mystery_bounty_pay')`           | Credits recipients inside the DB (its `prosrc` references `fn_credit_and_log`). The task mapping said `'mystery_bounty'` user-keyed; I did NOT move it into the engine because one user can win several chests in one event and a user-keyed obligation (`UNIQUE (tournament, kind, user)` with `owed = max(owed, amount)`) would silently deny the second chest unless the engine passed cumulative totals. Lane A owns `fn_mystery_bounty_pay` and should settle per award there. **Flagged for Lane A / the orchestrator.** |
| `server/src/tournament/TournamentManagerEliminations.ts:3102` | `rpc('fn_final_table_deal')`             | Records the chop in `tournament_payouts`; the engine then settles each share (site 4 above). Lane A should make sure its record rows and the obligation RPC's `tournament_payouts` write do not double up.                                                                                                                                                                                                                                                                                                                     |
| `server/src/services/RakebackSettlerService.ts:1010`          | `rpc('fn_tournament_payout_sweep')`      | DB-side sweep -> `fn_tournament_payout_reconcile`; Lane A repoints the reconciler.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `server/src/GameServer.ts:3808`                               | `rpc('fn_backpay_spin_unpaid_winners')`  | DB-side back-pay arm on Lane A's list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `server/src/GameServer.ts:3934`                               | `rpc('fn_pay_backed_payout_shortfalls')` | DB-side back-pay arm on Lane A's list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Non-tournament credit that stays as it is: `server/src/engine/ServerTableEngineSeating.ts:340`
`rpc('atomic_credit_wallet_and_log')` (cash-table add-on refund) - not one of
the three banned primitives, not tournament money.

## Cross-lane contract notes Lane A must honour

1. **`late_reg_adjustment` is told the TOTAL owed, not the difference.** Sites
   3 and 7-step-3 pass the new correct prize / `owed`. Per the brief, the RPC
   raises `amount_owed` to `max(owed, amount)` and pays `owed - paid`. That only
   yields the delta if the late_reg_adjustment settle sees what the `place`
   obligation already paid. If Lane A implements `late_reg_adjustment` as a
   separate row from `('place', N)` with `amount_paid = 0`, **it will pay the
   whole prize again**. Either treat `late_reg_adjustment` as a top-up against
   the `('place', N)` row, or change these two sites to `kind: 'place'` with
   `source: 'late_reg_adjustment'` (one-line change each; the tests pin
   `late_reg_adjustment` today).
2. `refund` is user-keyed here (one refund obligation per user per tournament);
   the amount passed is everything that user paid net of refunds already given,
   exactly as before.
3. A replay must come back `ok: true, paid: 0` (never an error); the recovery
   watchdog relies on `paid` to tell "just paid" from "already paid".

## The helper (`server/src/tournament/settleObligation.ts`)

- `settleTournamentObligation(client, { tournamentId, kind, place?, userId, amount, source, memo?, adjustmentId? }, options?)`
  -> `{ ok, paid, already_paid, refused_reason, obligation_id, idempotency_key, transport_error? }`.
- Retries ONLY when the RPC cannot be reached or throws (3 attempts, back-off
  `attempt * 1000ms`, injectable). Never retries `ok: false`.
- Never throws. `escrow_short` -> `raiseFinancialAlert('critical', 'Tournament.escrow_short', ...)`
  with a `dedupe_key` in the context (`raiseFinancialAlert` has no dedupe
  parameter; the alert RPC's per-source flood guard is the throttle). Any other
  refusal -> critical `Tournament.obligation_refused`.
- Transport failure after retries -> `refused_reason: 'transport'`; the call
  sites keep their pre-existing critical alerts (`Tournament.prize_credit_failed`,
  `Tournament.winner_prize_credit_failed`) for exactly that case, so a refusal
  and a transport failure each raise ONE critical, not two.
- The recovery watchdog's inner `credit()` THROWS on `!ok` on purpose: it
  already leaves the tournament in COMPLETING for the next pass, and continuing
  would stamp `prize` on a row that was never paid.

## Tests

- New law: `server/src/tournament/OneSettlePathForTournamentMoney.law.test.ts`
  (15 tests). (a) source scan: no file under `server/src` except
  `settleObligation.ts` may `.rpc(` any of `fn_credit_and_log`,
  `credit_player_wallet`, `fn_credit_player_wallet_once`; allow-list is an
  exact-path map (empty today). (b) `escrow_short` -> critical alert, one RPC
  call, resolves `ok:false`; replay raises nothing; transport retried 3x then
  reported, not thrown. Negative controls run inside the file AND were run for
  real: appending a `rpc('fn_credit_and_log'` line to `tournamentRecovery.ts`
  made (a) red (1 failed / 14 passed); deleting the `raiseRefusalAlert` call in
  the helper made (b) red (4 failed / 11 passed). Both restored.
- `docs/LAWS.md` row added.
- Updated pins (each was asserting the retired key strings):
  `server/src/tournament/NoPodiumFromPlayersWhoNeverSat.guard.test.ts`,
  `NoResultWithoutAHand.law.test.ts`, `moneyPathAudit.guard.test.ts`,
  `recoveryFieldGuard.test.ts`, `satelliteDoubleQualification.guard.test.ts`,
  `satelliteSecondWinIsNeverZero.test.ts`, `tests/config/prizeLedgerIdempotency.test.ts`
  (engine-side block only), `tests/config/walletCreditIntegrity.test.ts` (site
  floor 9 -> 1, reason recorded), `tests/unit/prizeKeyIsPlaceScoped.test.ts`
  (rewritten to the obligation shape: every `'place'` settle carries a place,
  no engine file builds a `tourney:` key).

## Verification run

- `cd server && npx tsc --noEmit` -> clean.
- `cd server && npx vitest run src` -> 324 files, 3606 tests, all green.
- root `npx tsc --noEmit` -> clean.
- root `npx vitest run` on every test that reads the touched engine files or
  the touched test helpers (12 files) -> 180 tests green, including
  `tests/law-registry.law.test.ts`.

## Not done / for Dan or the orchestrator

- `fn_mystery_bounty_pay` and `fn_collect_bounty` stay DB-internal payers
  until Lane A repoints them (see table above).
- `docs/CHIP-ACCOUNTING-STANDARD.md` and `docs/SWARM-BRIEF-CHIP-STANDARD.md`
  were present in the worktree untracked; this lane does not commit them
  (whoever owns them should, once, to avoid seven conflicting copies).
