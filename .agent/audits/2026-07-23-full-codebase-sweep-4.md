# Full Codebase Sweep #4 — 2026-07-23

Line-by-line audit of Club Arena (252k lines: 221k client / 30.5k server, 957 files),
against GitHub main HEAD (device checkout verified byte-identical to main via
recursive git-tree SHAs). Two subsystems audited to 100% coverage this pass;
three more are pending (agents interrupted by an API rate limit — see §5).

## 1. SHIPPED THIS SWEEP — live-money engine fixes (commit ed0e9353 on main)

Byte-verified on main. **NOT yet confirmed live on the Hetzner engine** — see §4.

- **P0-1** `HorseLifecycleManager.cleanupStaleSeats` (runs every 60s): force-cashed
  EVERY seat >4h old with no filter on table status / tournament / hand activity.
  `joined_at` is written once at seat insert and never refreshed, so a real cash
  player on a long session — or every seat at an MTT running >4h — was force
  cashed-out: tournament chips credited 1:1 into real PLAYER wallets, and cash
  in-flight pots minted/vaporized. FIX: skip tournament tables and tables with a
  hand in the last 30 min; only reap genuinely orphaned seats.
- **P0-2** `HorseLifecycleManager.cleanupStaleSNGs` (every 60s): used a DENYLIST
  including the non-existent status `'FINISHED'` (terminal status here is
  `'COMPLETED'`), so every COMPLETED SNG >2h old was refunded AGAIN (winner
  included) and flipped to CANCELLED. This is why prod has **329→350 CANCELLED
  SNGs and ZERO COMPLETED**. FIX: allowlist genuine pre-start states
  `['ANNOUNCED','REGISTERING']`.
- **P0-3** `supabase.ts atomicCashout`: soft-deleted the seat even when
  `credit_player_wallet` failed → transient 502/timeout destroyed the player's
  entire stack. Used on every real-player leave (`processLeavePending`) + both
  lifecycle sweeps. FIX: return early preserving the seat on credit failure;
  catch fallback only clears the seat once the credit committed.
- **P1-1** `GameServer.cleanupStaleData` (startup): deleted ALL table_seats even
  for users whose cashout credit failed → restart during a Supabase blip
  permanently destroyed stacks. FIX: spare failed-credit users' seats from the
  delete.
- **P1-2** `GameServer` startup pre-start tournament cancel: keyed on `created_at`
  (cancelled scheduled tournaments hours before start) and issued NO refunds. FIX:
  key on `start_time`; refund `buy_in_amount + buy_in_fee` to each registrant.

## 2. CONFIRMED but NOT YET FIXED — server (verified verbatim, next engine deploy)

- **P1-3** double-credit on retry: `GameServer.ts:2061-2077` (elimination prize),
  `2360-2376` (bounty), `2571-2587` (winner prize) — 3× retry loops around the
  non-idempotent `credit_player_wallet`; a 504-after-commit pays 2–3×. Needs an
  idempotency key on the RPC (DB + server coordinated change).
- **P1-4** table-move seats destination at stack 0 on a transient read failure:
  `GameServer.ts:2899-2915` (`executePlayerMoves`) — reads old stack AFTER marking
  the old seat left; a failed read re-seats the player with 0 chips → eliminated.
  FIX: read stack before marking left; abort on read failure.
- **P1-5** RakebackSettler has no re-entrancy guard:
  `RakebackSettlerService.ts:97-104` — overlapping 30-min runs after a backlog
  re-credit `agent_commissions` (live ledger) and double-count `player_stats`
  (watermark saved last). FIX: `isSettling` flag + per-chunk watermark checkpoints.
- **P2s (server):** dead double-elim guard (`count` always null, GameServer
  2042-2056); bounty knocker inferred from most-recent-hand race (2124-2137);
  refund loops delete `tournament_players` even when a refund failed (742/747,
  1147-1151); broadcast channel leaked on send failure (903-921);
  `waitForHandComplete` treats >1 open hand as none (2937-2943); lifecycle checks
  never-written statuses `'FINISHED'`/`'in_progress'` (HorseLifecycleManager 96,
  193, 270) so `cleanupFinishedTournaments` never reaps COMPLETED tournaments;
  `ensureHorseWallet` mints via direct `wallets` INSERT (supabase.ts 982-988);
  horses refunded buy-ins they never paid on tournament cancel; tournament-create
  retry can double-create.

## 3. CONFIRMED but NOT YET FIXED — client (TablePage/MultiTablePage/TableConfig)

- **P0-1 (client)** `TablePage.handleWithdrawChips` (1512-1567): client-authored
  money math — credits wallet then writes a client-computed `newStack` straight
  into `table_seats.stack` with NO engine call (unlike addChips). Engine's next
  snapshot overwrites it → 500 credited to wallet AND still on table (duplicated),
  or stale-closure mid-hand corrupts the DB stack. FIX: route withdraw through a
  server API / atomic RPC; treat the next snapshot as the only stack source.
- **P1 (client):** header "Add Chips"/"Top Up" buttons open a seat buy-in modal
  that always fails for seated players (5602-5607/5769-5774/6399-6408 +
  onConfirmBuyIn 6768-6800); infinite render loop in MultiTablePage
  (`onTableInfoUpdate` new-arrow-every-render feedback, 479-481/538-540/222-224 +
  TablePage 1185-1207); hole-card recovery poll stops before cards applied
  (2255-2266) → hidden hero cards after mid-hand reload; tournament break/bounty
  channels destroyed on hero seat change and never recreated (3222-3244) → seated
  players miss breaks/eliminations/level-ups; MultiTablePage global 1-4/Tab
  keyboard handler hijacks typing in chat/raise inputs (242-268).
- **P2 (client):** pre-action executed by BOTH server and client → spurious
  "action rejected" toast; Rabbit Hunt fabricates random cards on fallback;
  auto-switch-on-urgent-timer dead (hardcoded 15s); addChips wallet debit with no
  revert path; GAME_START recovery writes non-existent `stage` field; TableConfig
  Toggle/Slider defined inside the component → remount every change, sliders drag
  one step per gesture; dead delete-table handler; `reportError(isMounted,...)`
  passes a boolean; union standalone-table guard fails open on query error.

## 4. HETZNER DEPLOY STATUS — NOT CONFIRMED LIVE

The §1 fixes are on `main` (server/** changed → should trigger
`auto-deploy-hetzner.yml`). As of ~18 min after the final commit, `hand_history`
shows **765 hands over 25 continuous minutes with zero gaps >45s** — the single
engine process has NOT restarted, so the fixes are NOT yet running live. The CI
deploy is either still queued, or failing (build/secret), or not firing. Could
not be confirmed from the audit environment (no Actions-run API tool; browser
control returned "Chrome not running" for content reads). **ACTION NEEDED:\*\* check
the Actions run for `auto-deploy-hetzner.yml` on commit ed0e9353; if failed, read
the log (likely a secret or a `docker build`/tsc issue — though the 3 changed
files parse clean and use only patterns/columns already present); if stuck,
re-run it or dispatch `manual-deploy.yml`. The engine will not carry the P0/P1
fixes until it restarts on the new image.

## 5. AUDIT COVERAGE — this pass

DONE (100% line-by-line): `server/src/GameServer.ts`, `index.ts`, `router.ts`,
`types.ts`, `services/supabase.ts`, `RakebackSettlerService.ts`,
`TournamentRecurringService.ts`, `HorseLifecycleManager.ts`, `AutoRebuyService.ts`,
`errorReporter.ts`; `src/pages/TablePage.tsx`, `MultiTablePage.tsx`,
`TableConfigPage.tsx`.

PENDING (agents interrupted by API rate limit — re-run after reset):
`server/src/engine/*` (ServerTableEngine, HandController, StateMachine,
PotManager, etc.), `server/src/engine/HorseLogic.ts` + `.test.ts` (rewritten
TODAY in 1cff0e7b — highest fresh-bug risk), `server/src/services/HorseFleetManager.ts`,
and the client money services (`src/services/` Wallet/Credit/Settlement/
Commission/Union/Agent/VIP/Referral/Bonus/Promotion/Cashier/BBJ). Also not yet
swept: remaining `src/pages/*`, `src/components/*`, `src/hooks/*`, `src/core/*`.

## 6. NOT A REGRESSION FROM TODAY'S HORSE V2 (verified sound)

`services/supabase.ts` horse_profile passthrough + `types.ts` widening are
consistent with `resolveHorseStyle()`; no defect. (HorseLogic.ts internals not
yet fully audited — see §5.)
