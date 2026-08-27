# Create Flow — Phase 3 (2026-08-27)

Follow-up to `.agent/audits/2026-08-27-create-flow-full-audit.md` (Phase 1 PR
#1408, Phase 2 PR #1420). Two deep read-only investigations preceded this
work, and both CORRECTED the Phase-1/2 conclusions. Recording that, because
the corrections matter more than the fixes.

## 1. `addon_break_minutes` was NOT dead — it was worse

Phase 1 listed it as "written, never read". Wrong: a working add-on break has
existed since 2026-08-22 (`TournamentManagerBase.triggerAddOnPeriod`). It had
three defects, and the first is the serious one:

1. **The level clock kept running.** The break parked the tables with a
   hand-rolled `pauseAfterHand` loop and never called `suspendLevelClock()`,
   so blinds escalated while the field sat frozen. Worse, because `onBreak`
   stayed false, an `advanceBlindLevel` firing mid-break could reach
   `finalizeAfterAddOn` and CLOSE the add-on window while nobody could act on
   it. On a turbo with a 3-minute break that is the normal case, not an edge.
2. **The reapers did not know.** Both zombie reapers trust
   `isPausedByDesign()` only up to `MAX_HEALTHY_PAUSE_MS` (10 min), and the
   budget requested was break + 2 min grace — up to 12. A long add-on break
   had its tables torn down and rebuilt UNPAUSED, mid-break.
3. **Nothing was persisted and no client listened.** It broadcast an
   `addon_break` event with zero listeners anywhere in `src/`, so the table
   simply stopped dealing behind no overlay; and with no `on_break` row a
   redeploy inside the break lost it.

**Fix:** go through the break machinery instead of beside it. `pauseForBreak`
gained a `BreakOptions` parameter (`synchronized`, `kind`); an unsynchronized
break stamps its own `break_ends_at` (there is nothing to wait for) and
broadcasts the `tournament_break` event the overlay already renders, so the
add-on break inherits the full break UI with no new client plumbing. Resume
goes through `resumeFromBreak`, which clears the row, un-parks and re-arms the
clock with the time the level had left. Clamp lowered 10 -> 7 minutes in all
four writers so break + grace fits under the reaper ceiling.

Also fixed: `TournamentClock` recomputed its countdown from a hardcoded `300`,
so EVERY break that was not exactly five minutes displayed wrong — invisible
while the :55 break was the only break that existed.

## 2. `late_reg_mins` held a LEVEL COUNT in a minutes column

Phase 1 called it write-only. It is not: `fn_register_for_tournament` reads it
as a real minutes window whenever `late_reg_levels = 0`. Every writer on the
platform stored the level count there, so a 12-level late reg persisted as
"12 minutes". Dormant only because of evaluation order — and one row with
`late_reg_levels` zeroed would silently reopen registration.

Measured: 1,692 rows carry `late_reg_mins = late_reg_levels`; 21 already sit
in the minutes-window state (all COMPLETED, so no live game was affected).

**Fix:** all five writers now store 0 unless a caller deliberately sends
`lateRegistrationMinutes` (no UI does). `fn_create_tournament` patched by
surgical string replacement of the single INSERT argument — verified before
and after that the fee formula and every validation survived (10877 -> 10878
chars). OPEN tournaments backfilled; settled history deliberately untouched.

## 3. The client start path was actively destructive

`TournamentService.startTournament`, wired to TournamentPage's "Start
Tournament" button:

- **It cancelled tournaments.** Under 3 registered it flipped the row to
  CANCELLED and refunded the field — what "TOURNAMENTS RUN. THEY DO NOT
  CANCEL." exists to forbid. The button was then disabled below 3 players to
  hide that, removing the one case an owner most wants.
- **It built tables no engine could see** (`status: 'RUNNING'` uppercase vs
  the lowercase every adoption query matches), with hardcoded 9 seats and
  'nlh' and no deck clamp — the PLO5/PLO6 over-seating deadlock reopened.
- It skipped paid-seat verification, the spin draw, guarantees, table
  adoption, engine attachment and blind-timer arming.

**Fix:** deleted, and replaced with `fn_owner_start_tournament_now` — an RPC
that only moves `start_time` to now and lets the engine's discovery loop start
it through the real path. Every guard applies for free; it cannot cancel
anything or create a table (asserted in the migration). The button works at
ANY player count now, because the engine fills a short field with horses
rather than cancelling.

## 4. Spin "hyper" was three lies in one control

`SPIN_MULTIPLIERS.standard` and `.hyper` were the SAME array reference;
`spinSpec.ts` has no `spin_type` branch anywhere; and both advertised EVs
(2.24X / 2.33X) belonged to ladders deleted on 2026-08-20 — the real
expectation is 2.7638. The helper text promised variance that does not exist.

**Fix:** control removed; `SPIN_MULTIPLIERS` collapsed to a single
`SPIN_DISPLAY_TIERS`. `tournaments.spin_type` still defaults 'standard', so
nothing downstream changes.

## 5. Live creation preview

New panel under the name field on TableConfigPage, priced with the same
helpers the server uses: cash shows stakes, buy-in range and the resolved rake
(schedule row, or an override — which may only ever take LESS); tournaments
show the entry split at the REAL per-format rate and the paid places.

## Verification

- client `tsc` clean; client suite **7,311 passed / 0 failed**
- server `tsc` clean; server suite **1,924 passed / 0 failed**
- Migrations applied to production with passing assertions:
  `owner_start_tournament_early`,
  `late_reg_mins_stops_holding_a_level_count`
- Three tests updated in the same commit where behaviour deliberately
  changed (BreakClockIntegrity, tournamentRakeAndBreaks, TournamentService),
  each pinning the new invariant rather than deleting the old assertion.
- `EngineStartResilience` timeouts seen mid-run are a pre-existing
  parallel-load flake: the file passes in isolation both with and without
  this branch's changes.

## Still open

Realtime creation discovery (5s polling works); one unified creation surface
(the modal and the page tabs still have different capabilities); template UX
(`table_templates` still has zero user rows); the `'RUNNING'` special-case at
GameServer.ts can now be removed since the uppercase writer is gone, plus a
one-off `UPDATE tables SET status = lower(status)` sweep.
