# A ratchet nobody runs is decoration

Dan ordered a completeness audit of the zero-drift Phase 1 work before Phase 2
started: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR
WIRING ISSUES ANYWHERE AND EVERYWHERE." It found six, and every one was mine.

## The wiring gap

`fn_ca_unledgered_insert_paths()` and `fn_ca_undeclared_money_paths()` were
built earlier today as ratchets - detectors that were supposed to make it
impossible to quietly re-open a hole once it had been closed. Neither was
scheduled by anything. `cron.job` had no row for either. A detector nobody runs
cannot catch a regression; it can only make the repository look defended, which
is worse than an absent detector because it stops anyone else building one.

`fn_ca_ratchet_watch()` runs both hourly (`ca-ratchet-watch-hourly`, `35 * * * *`)
against a baseline in `ca_ratchet_baselines`. Growth past the baseline raises a
warning incident naming the ratchet and the delta. A shrink TIGHTENS the
baseline, so ground reclaimed cannot be given back later without the watcher
saying so. It never locks, closes, disables, suspends or freezes anything: it
writes one incident row and returns.

Baselines at first run: `unledgered_insert_paths` 0 (closed this morning),
`undeclared_money_paths` 139 (Phase 5 drains this one to zero).

Both directions were proved inside rolled-back probes: a simulated regression
raised exactly one incident and did NOT loosen the baseline; a simulated
improvement tightened 200 to 139 and raised none.

## The five defects in The Mint

The Mint shipped in the same branch and CI had been red on it since 17:44. All
five failures were the Mint's:

1. **Six discarded error reads.** `MintPage.tsx` called Supabase six times and
   never bound `error`. On a money page that is not a style problem: a failed
   read renders identically to an empty result, so an operator searching for a
   club, seeing nothing, and concluding the club does not exist would have been
   looking at a network failure. All six now bind the error, log it, clear the
   options and say so through the Toast layer.
2. **`.option:hover`** violated the no-hover law. Replaced with
   `:focus-visible` and `:active`, the two states the law names as its
   replacements.
3. **`/mint` was an orphan.** The page existed and the route resolved, but
   nothing anywhere linked to it - Dan asked for this in the admin panel and it
   was reachable only by typing the URL. It is now the first card in
   `FinancialAdminHub`.
   4-6. Three route-count pins in `globalHeaderRouteAudit` bumped for the new
   route, with the same annotation convention the file already uses.

## Three migrations that existed only in production

`resolution_law_closes_the_auto_repair_door`,
`state_the_money_rpc_sweep_is_service_role_only` and this one had been applied
to the live database with no file in the repository. They are mirrored here
now. New schema objects are declared in
`scripts/ci/schema-manifest.d/cowork-chip-drift.json` rather than in the shared
snapshot, per the README there.
