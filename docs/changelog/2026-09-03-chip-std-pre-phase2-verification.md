# Chip standard - pre-Phase-2 verification (2026-09-03)

Dan's rule before Phase 2: everything built in Phase 1 must be verified fully
built, coded, wired in, tested, pushed and published. This is what the sweep
checked, what it found, and what it fixed. Numbers are measured, not intended.

## Verified clean

- Repo at origin/main 567043a40: root tsc 0 errors, server tsc 0 errors,
  root vitest 883 files / 12,035 tests green, server vitest 346 files / 4,744
  tests green. The seven CI gates (migrations applied, applied migrations
  recorded, telemetry exposure, definer authorization, chip conservation,
  rake-config parity, version collisions) all pass on main.
- Engine /health serves 567043a4 (deployed 11:55 UTC); the client publish
  workflow's last successful run is the same sha. The free-buy UI is live.
- Every chip-standard migration applied since 17:29 UTC on 09-02 (the prior
  agent's cutoff) is in the repo, normalised-equal to the production record.
  The one file that differed (20260903020000, Lane G) differs only by two
  trailing self-check DO blocks; both were run against production and pass.
- The production bodies of fn_settle_tournament_obligation,
  fn_ca_fund_overlay_on_lock, fn_award_satellite_seat, fn_ca_tournament_escrow,
  fn_ca_escrow_vs_counter_check, fn_rake_spec_checksum, fn_ca_trial_balance,
  fn_ca_money_path_log, fn_freerolls_are_free_buy, fn_ca_declare_ledger,
  fn_ca_epoch3_preflight and fn_ca_payout_structure match their last repo
  definition. All three chip-std triggers are attached and enabled.
- Engine wiring: settleObligation.ts is imported by TournamentManager,
  TournamentManagerEliminations and tournamentRecovery (8 call sites);
  rakeSpecGuard starts in GameServer boot; tournamentChipConservation is the
  pure decision in ServerTableEngineSettlement; seatStackCredit funds seats
  in TournamentManagerBase; config/buyIn.ts free-buy helpers are used by both
  tournament services, TableConfigPage, TournamentService and
  HorseOrchestrator. No legacy payer RPC is called anywhere in server/src.
  No TODO, FIXME, stub or "not implemented" in any file the chip-std commits
  touched.
- Production since the cutover (21:00 UTC 09-02): 12,963 structure payouts,
  0 places paid twice, 0 tournaments over pool, 0 over guarantee,
  settlement_suspense 0.00, ca_money_path_violations 0 rows since 22:04:27
  (the 24h clean window for Dan's R3 flip closes 22:05 UTC 09-03), payout
  freeze 0 open, player_wallets balance to the ledger to the cent since
  00:00 UTC, 11 of 12 bounty residuals paid at close (the twelfth by the
  hourly sweep, 38 minutes later - the layers worked).

## Found and fixed

1. **Fourteen placeholder migrations carried no body.** Files from the 08-31
   zero-drift programme were markers saying "export the body from prod".
   Among them the epoch-3 reset, the Midway burn-in gate, the promo accrual
   queue, the settle-hand-stacks guards, the three mint guards and the
   split-pot bounty ruling. A rebuild from the repo would not have had the
   epoch reset Dan ruled on. Exported byte-exact from
   supabase_migrations.schema_migrations in the repo's own BACKFILLED format.
2. **The overlay journal row lost a deadlock (18.00 chips, union bank).**
   At 00:31:49 UTC fn_ca_fund_overlay_on_lock debited the Midway bank 18.00
   for Late Night PKO (PLO4) and the chip_ledger INSERT hit 40P01 inside its
   exception block: money moved, no row. Balances were right; the trial
   balance carried union_banks -18.00 and the escrow shadow showed the event
   overpaid. Restored with fn_ca_post_correction (chip_ledger
   correction:lwf:704). Migration 20260903155801: the row retries a deadlock
   (three attempts, 40P01 only), the failure message names the bank it
   debited so fn_ca_repair_write_failure maps the store correctly, and the
   escrow shadow counts a bank -> prize_liability correction as overlay. The
   event now closes 0 / 0 / 0 in the shadow.

## Found, not mine, left for their owners (with numbers)

- 26 migrations applied since 08-27 have no file on main; every one I could
  trace sits on another agent's unmerged branch (diamond lanes, horse
  identity, restart programme, table-management perf). Their PRs mirror them.
- 92 BBJ pool auto-ledger rows refused by PLATFORM_FROZEN during the 05:00
  and 06:00 breaks (8.85 chips unjournaled while balances moved) - restart
  programme, already on the roadmap.
- table_stack moved about 400 chips more than the ledger in the 12:05-13:05
  hour (the engine restart hour); tournament_liability is at 0 over the same
  window, so it is not tournament money. Bomb pot / insurance ledger gaps
  are already open incidents from the nightly reconcile.
- Two hand writes on the 6:00 AM freeroll were refused at 11:49-11:50 UTC by
  fn_ca_settle_hand_stacks_absolute (two 1-chip rebuys granted between
  settlements, the engine's absolute stacks lagged one of them). The next
  hand's absolute write carried the correct state; nothing was lost. The
  "seat missing or left" refusals run at 10-80 an hour and predate Phase 1.
- post-deploy-e2e has failed on every main sha since 09-01 17:18 (waitlist
  control, Daily Missions E2E account sign-in, Club Data permission gate):
  E2E account and lobby issues, not chip accounting.
- Three obligations are owed 0.09-0.12 each (0.32 total) from 23:57 09-02:
  the reconciler's cent top-ups, correctly refused past the pool cap.
  Roadmap 1.7.
