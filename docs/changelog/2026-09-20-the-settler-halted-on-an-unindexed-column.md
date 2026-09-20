# The cash settler halted on an unindexed column, and four other findings

2026-09-20. Written while the poker engine was 44 hours into a freeze; that
freeze is a separate incident and is recorded at the end.

## The settler

`RakebackSettlerService` stopped at 2026-09-17 07:28:31 UTC and did not move
again for three days. Behind its durable cursor sat **264,835 positive cash
rake records carrying 485,712.99 of rake**. Not one of those hands produced an
agent commission, a rakeback basis, a VIP point or a `player_stats` row, and no
cash agent commission was written anywhere on the platform after
2026-09-17 07:29:05.

Nothing threw, and nothing alerted. Every cycle opened with
`fn_retry_cash_accounting_sources(50)` before it read any new work. That call
took ~20.6s. The engine's Supabase client gives up at `DB_TIMEOUT_MS`, 15,000ms.
The client aborted, the catch wrote `source_retry_holds_cursor`, the cycle
returned `halted`, and the cursor was never written - **while the server
transaction committed regardless**. `accounting_cash_source_receipts` grew by
exactly 50 rows an hour for days, 5,294 receipts for 150 records. The work was
being done and thrown away, once an hour, for three days.

### The cost, and where it came from

`public.rake_attributions` holds 1,175,365 rows in 1,117 MB. It is indexed on
`id`, on `hand_id`, on `(hand_id, player_id)`, on `(player_id, created_at)` and
on `(club_id, created_at)`. It was **not indexed on `rake_record_id`** - the
column the entire cash accounting path joins on. Measured with
`EXPLAIN (ANALYZE, BUFFERS)`:

    Seq Scan on rake_attributions
      Filter: (rake_record_id = ...)
      Rows Removed by Filter: 1175362
      Buffers: shared hit=8711250
      actual time=13.795..164.940 rows=3 loops=150

164.99 ms to find about three rows. The same rows through an existing index
cost 0.67 ms - **245x**. Settling one cash source performs four such scans
(`fn_process_cash_accounting_source` and `fn_accrue_cash_hand_commissions`
each fingerprint the source; `fn_accounting_cash_commission_plan` both checks
attribution ambiguity and walks the attributions). 4 x 164.99 = 660 ms of pure
scanning against 287 ms of real accounting work: **the scans were 70% of the
cost of settling a hand.**

### And why the batch never noticed

Two literals, each sized honestly, each outliving what it was sized against -
CLAUDE.md 1.1.7, _a number tuned to hardware and written down as a constant
outlives the hardware_:

- `CREDIT_BATCH_SIZE = 150` was chosen after 500 hit the **server's** ~8s
  statement timeout. The functions then set their own 300s server-side timeout,
  so the server stopped being the constraint - and nobody re-derived the
  constant against the one that still bound it, the client's 15s.
- Migration `20260917181100` then repointed `fn_credit_agent_commissions_batch`
  at `fn_process_cash_accounting_source`, taking one item to ~290 ms.
  150 x 290 ms = 43.5s. The batch size did not change, because a literal cannot
  notice that its own cost moved.

### What was done

1. `idx_rake_attributions_rake_record_id`, built `CONCURRENTLY` - a plain build
   takes SHARE on a table written for every player of every raked hand, and
   CLAUDE.md's DDL policy rule 7 exists because a lock on a hot table took the
   database down for four minutes on 2026-09-08.
2. `server/src/services/cashAccountingBatchBudget.ts`: both batch sizes are now
   **derived** from `DB_TIMEOUT_MS` and a named, measured per-item cost, and an
   unreadable budget reads as the _smallest_ batch, never the largest
   (CLAUDE.md 10.86 rule 1). At 15s that is 31 items, 8.99s - inside the budget.
3. A trigger refusing any cash accrual cutover armed **ahead of** the settler's
   cursor. That is how 150 hands were orphaned on 2026-09-17: the cutover was
   armed at `now()`, 18:24:04, while the cursor stood at 07:28:31 - 10.93 hours
   behind - so every hand in between was unreachable by the legacy writer and
   refused by the canonical one as `legacy_unverified`. Nothing in the schema
   forbade it. It pairs with the existing week-alignment guard: a cutover must
   be both week-aligned and already passed by the settler.

### What was deliberately NOT done

Moving the cutover was the obvious fix and it is the wrong one, four times over:
`fn_accrue_cash_hand_commissions` looks up the batch row and returns _before_
it reads the cutover, so the 150 `legacy_unverified` verdicts are **latched**
(a rolled-back probe returned `duplicate:true` verbatim); both tables are
immutable by trigger; the requested value is refused by
`ca_cash_cutover_is_week_aligned`; and the only week-aligned instant at or
before the cursor entangles 70,465 hands that already hold legacy commissions.
Under 10.9 that is not a clear path - the outcome cannot be stated from rows
today - so it is left as a deliberate, separately scoped decision rather than
smuggled into an index fix.

**Still owed:** those 150 hands - 266.61 of rake, 459 attributions, 119
players, 2 clubs, earned 2026-09-17 07:28:33 to 07:34:04 - proven to hold zero
`agent_commissions`, zero `accounting_cash_rake_sources` and zero
`rakeback_stats_applied` rows. They are 0.05% of what the index unblocks, and
they are recorded in the table comment so the next agent finds them rather than
rediscovering them from 5,294 receipts.

**The index alone does not restart the settler, and this file does not claim it
does.** It clears the call that halts the cycle first (20.6s -> ~4.2s, inside
the budget); the credit batch then halts at ~43.5s until the derived batch size
ships with the engine. Both are in this change; only the migration can land
while the engine is frozen.

## Four smaller findings, fixed the same day

- **Four closed money doors were still executable.** The 2026-09-17 close used
  `CREATE OR REPLACE FUNCTION`, which preserves the existing ACL, so the revoke
  its registry note claimed never happened. The bodies are tombstones, but a
  tombstone reachable by `authenticated` is a door. Revoked.
  `fn_ca_money_rpc_drift` 4 -> 0.
- **A retired cron was still demanded by the guard baseline.** Migration
  `20260920070402` retired `ca-bbj-repair-unbanked-15m` under law 10.12 and did
  not deactivate the `ca_guard_inventory` row requiring it, so the integrity
  check filed a CRITICAL for a guard whose absence was the intended outcome.
  Failing guards 1 -> 0.
- **Twelve diamond prizes carried no club.** `drift_since_baseline` reported a
  member adrift by 75.08. Nobody was short or over: twelve posted
  `union_wallet -> player_wallet` prize credits carried `club_id IS NULL`,
  because `fn_ca_autoledger` derives the club from the row it journals and
  `union_wallets` has no `club_id`. The meter counted the balance but not the
  movement. Attribution backfilled; the writer-side fix is separate.
- **An orphan settlement period held the one NULL-club open slot.** Period
  37/2026 had a third, club-less row created by the now-tombstoned implicit
  creation path: zero totals, no invoices, unreachable by every club-scoped
  predicate in `fn_process_weekly_accounting_scope`. Closed.

## The board

`ca_drift_incidents` held 170 open rows, 131 critical, against roughly 13 live
conditions. The root cause was not a missing closer but an unconfigured one:
`fn_ca_incident_escalation_tick` has run every minute since Phase 6.3 and
already held the retirement rule, keyed on
`ca_detector_registry.auto_resolve_hours` - which was NULL for all 26 sources
holding an open incident. Fifteen event-mirror sources were configured with
windows **derived** as `ceil(3 x p99 inter-arrival gap)` floored at 24h, each
measurement written beside its value.

The mechanism also lied: it closed silence-retired rows with
`correction_ref = 'verified: ...'`, the same prefix a genuinely re-measured
all-clear uses. 43 rows carried that wording. Silence is _I could not tell_,
not verification (10.86 rule 1), so it now has its own `closure_basis`, the
prefix is fenced in both directions inside `fn_ca_resolution_needs_a_cause`, an
aged-out incident no longer marks its `financial_alerts` row resolved, and the
43 historic rows are corrected forward.

`fn_ca_close_incidents_the_check_no_longer_finds` was dropped: no caller, and
defective in the dangerous direction - it re-ran each check as a bare
`count(*)`, discarding the tolerances the sweep registered, so
`fn_tournament_chip_conservation_check` would have been re-measured 100x more
permissively and closed while still being raised.

Board: **170 open / 131 critical -> 37 / 11.**

## The engine freeze this was all found under

The engine has been on sha `8825af51` since 2026-09-18 21:56 because
`server/src/tournament/mixedF06Custody.ts` (PR #4907) called five RPCs whose
migration `20260918232558` was never applied. `check-engine-doors-exist.mjs`
correctly refused every build - twelve consecutive Engine Releases, including
`56c722f8ec`, the fix that bounds the restart gate. The migration has now been
applied and the door check passes; the release gets further and is being worked
separately. 707 F06 permits remain `reserved` and 470 of 485 RUNNING events
have dealt nothing for over 24 hours until the engine can be replaced.
