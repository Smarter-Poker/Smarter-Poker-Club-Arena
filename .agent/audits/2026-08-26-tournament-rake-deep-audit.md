# Tournament Rake Deep Audit — MTT / Spins / Heads-Up (2026-08-26)

Dan asked for a full deep-dive into tournament rake: how it is collected,
where it goes, how it is calculated, where it is held, how it is tracked —
and to fix everything found. This is the record.

## The money model (as designed)

1. **Collected at the till.** Entry fees are booked to `rake_records`
   (`is_tournament = true`, `tournament_id` set) by
   `fn_register_for_tournament`, `fn_register_horse_for_tournament` (both
   also debit the player wallet and bump `prize_pool` / `bounty_pool` /
   `total_rake` from `fn_tournament_entry_split`), by
   `process_tournament_rebuy` for rebuys and re-entries (add-ons are NOT
   raked — Dan 2026-08-20), and by `fn_spin_settle_game` for Spins (whose
   rake is engineered into the multiplier distribution — `buy_in_fee` is 0).
   Heads-Up is a seat-first SNG: `fn_take_seat_and_buy_in` delegates to
   `fn_register_for_tournament`, with a 5% fee cut at creation
   (`SNG_RAKE_RATE`).
2. **Held implicitly.** Between the till and completion the fee exists only
   as `rake_records` rows — no wallet holds it.
3. **Landed at completion.** The engine sums the tournament's fee ledger and
   credits the union rake treasury (`increment_union_wallet`) or the
   standalone club treasury (`credit_club_rake_to_treasury`). The weekly
   union rakeback close redistributes from there.
4. **Reversed on exit.** Unregister/cancel refund the player and write
   negative `rake_records` rows so a cancelled event's fees net to zero.

## What was broken (all verified against production data)

1. **Nothing guaranteed the landing — ~6,748 chips / ~940 events lost in
   30 days.** `settleTournamentRake` ran only on the engine's happy-path
   finish; a tournament finished by `recoverStuckCompletingTournaments`
   NEVER settled, and a failed wallet credit was reported and forgotten.
   30-day measurement: 160,792.24 chips booked across 31,022 completed
   events vs 154,044.36 credited to union wallets. No idempotency marker
   existed either, so a re-run of the finish path would have double-credited.
2. **Rebuy fees breached the 10% cap — 879 breaches / 729.20 chips in
   30 days.** `process_tournament_rebuy` used `GREATEST(1, round(...))`
   (the exact minimum-fee and round-up bugs banned for entries on
   2026-08-21) and divided the fee by `buy_in_amount` (the prize half)
   instead of the player-paid total.
3. **Unregister corrupted the pools.** It subtracted the full buy-in from
   `prize_pool` (over-subtracting by the bounty on bounty events), never
   decremented `bounty_pool` — so `fn_finalize_bounty_pool` would pay the
   champion an UNFUNDED residual (minted chips) after any
   register-then-unregister cycle — and never decremented `total_rake`.
4. **`atomic_cancel_tournament` was dead twice over.** It wrote the
   tournament id into `rake_records.table_id` (an FK to `tables(id)`) so
   every cancel of a fee'd event threw; separately it had no EXECUTE grant
   for `authenticated`, so the SPA's cancel had been failing on permission
   before ever reaching the FK bug. It also had no caller authorisation,
   refunded the CURRENT list price flat (minting for ticket/free entrants),
   decremented a `unions.total_rake` counter nothing increments, and
   DELETEd `tournament_players` (destroying refund evidence).
5. **Legacy free-entry hole.** `atomic_tournament_register` was still
   executable by `authenticated` and trusted a client-supplied total cost
   (0 accepted), with no status/capacity check and no fee/pool bookkeeping.
6. **Dead double-credit path.** `record_tournament_buyin_rake` (zero
   callers) credited wallets AT THE TILL — double-counting by design
   against settle-at-completion — and wrote to the retired `club_wallets`
   pool.
7. **Mirror drift stripped micro fees.** The client `clampRakeToCap` moved
   to cents on 2026-08-25 (Dan: "fractional fees need to be allowed");
   the server copy still rounded to whole chips. The restart re-cut in
   `ScheduledTournamentService` had the same whole-chip cap, so every
   restarted 1-chip event silently lost its 0.10 fee into the prize.
8. **Standalone-club settlements were untraceable** —
   `credit_club_rake_to_treasury` writes no transaction row, and union
   credits carried only the tournament NAME in the note, which is why the
   backfill below had to match heuristically.

Checked and found sound: Spin economics and `fn_spin_settle_game`
(idempotent via `spin_reserve_ledger`), cancel reversals netting to zero in
data, bounty pools of completed events, BBJ paths, the entry-fee split
itself (`fn_tournament_entry_split` + `feeToCents`), and the paid-gate on
Spin/HU starts.

## What was shipped

**Migration `20260826_tournament_rake_settlement_integrity` (applied to
production via Supabase MCP, asserted):**

- `tournament_rake_settlements` — one row per terminal tournament; the PK is
  the idempotency claim. Every settlement now has a durable, queryable
  record with amount + destination.
- `fn_settle_tournament_rake(tournament, source)` — atomic
  claim-then-credit. Terminal statuses only; sums the fee ledger; credits
  union rake wallet (note now carries the tournament id) or club treasury;
  a failed credit rolls the claim back. Service-role only.
- `fn_sweep_unsettled_tournament_rake(days, limit)` — settles anything
  terminal with fee rows and no settlement row; failures go to
  `financial_alerts`. Service-role only.
- `process_tournament_rebuy` — fee floors to CENTS at ratio
  `fee/(prize+fee)`, hard 10% ceiling, no minimum.
- `fn_unregister_from_tournament` — reverses the exact entry-split
  components (prize/bounty/rake) registration added.
- `atomic_cancel_tournament` — rewritten: club-admin authorisation
  (service role trusted), evidence-based per-player refunds from the wallet
  ledger under the engine's own idempotency key family
  (`tourney:<id>:cancelrefund:<tp.id>` — the two cancel paths dedupe
  against each other), per-player fee reversal from `rake_records` net,
  `table_id` NULL (FK-correct), player rows closed not deleted. Granted to
  `authenticated`.
- `atomic_tournament_register` revoked from `anon`/`authenticated`;
  `record_tournament_buyin_rake` dropped.
- **Backfill:** 30,179 historical settlements (154,398.72 chips) matched to
  their union credits (club + exact amount + note prefix + ended_at window,
  mutual-nearest, three passes) so the sweep cannot re-credit them.

**Engine (PR #1381):**

- `settleTournamentRake` now calls the RPC (3 retries; loud on failure).
- `recoverStuckCompletingTournaments` settles rake before the COMPLETED
  flip — the recovery population was exactly the one losing its rake.
- GameServer discovery loop runs the sweep every 10 minutes.
- Server `clampRakeToCap` mirrored to the client's cents arithmetic; the
  scheduled-restart re-cut caps in cents while preserving the player-paid
  total to the cent.
- `tests/unit/tournamentRakeMirror.test.ts` pins the two buyIn copies to
  each other so the next mirror drift is a red test.

The stranded ~6,748 chips land automatically on the deployed engine's first
sweep passes (200 events per 10-minute cycle, oldest first).

## Deferred / known gaps

- `fn_register_for_tournament` still books no fee row when a tournament has
  no `club_id` (zero such fee'd events exist today; worth a guard if
  clubless events ever appear).
- `tournaments.total_rake` drifted historically (unregister never
  decremented it before today); the settlement ledger, not that column, is
  the audit source of truth. `rake_records` remains authoritative.
- Old union credit notes (pre-fix) carry no tournament id; new ones do.
- ~843 unmatched historical events settle via the sweep rather than
  backfill matching; a handful may be events whose credit landed outside
  the ±2h matching window. The mutual-nearest matcher makes double-credit
  unlikely but not impossible for same-club same-amount restarts inside one
  window; magnitude per event is a single event's fee.
