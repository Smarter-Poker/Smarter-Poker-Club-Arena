# Could not load is not empty, and the last three migration leftovers

Date: 2026-10-01

## 1. The Club Data page said nothing when its first read failed

A live E2E diagnosis on the Club Data page found an empty Games list with no
message and no Try Again button; only the header said "Live Refresh Delayed".

**Cause, by line.** Every failure branch of `load()` in
`src/pages/club/ClubDataPage.tsx` (RPC error, unusable payload, timeout) did
this whenever the caller passed `preserveOnError`:

    setError(null);
    setLedgerSource('degraded');

`preserveOnError` means "keep the last verified ledger on screen". The 60-second
poll, the visibility refresh, the cache-restored first read, Refresh and the
list's own Try Again button all pass it. None of them checked that a ledger was
actually held. So once a first read had failed, the next failed poll or a
failed Try Again erased the error message and the list rendered as empty: a
read that could not complete was shown as an empty result (CLAUDE.md 10.86
rule 1). `loadPlayers()` had the identical branch for the Players list.

**Fix.** `src/pages/club/clubDataReadOutcome.ts` holds two pure decisions:

- `clubDataReadFailure` keeps the held ledger and marks it delayed only when a
  verified payload is actually held. With nothing held, the failure always
  sets its Title Case message and clears the unusable payload.
- `clubDataListState` decides what the Games list renders. `empty` requires a
  verified payload with zero rows; no payload and no request in flight is
  `unavailable` (the message plus Try Again), never empty.

Both `load()` and `loadPlayers()` route every failure through the first; the
Games list and the header's Offline / Ledger Unavailable lamp read the second.
A genuinely empty period still renders "No Games In This Period." exactly as
before. No CSS changed; the message row is the existing `stateRow`, already
laid out for 375px.

**Pinned by** `tests/unit/clubDataReadOutcome.test.ts` (the unknown and the
genuinely empty case paired) and a component test in
`tests/components/club-data-page-renders.test.tsx` that fails a first read,
fails Try Again, and asserts the message and Try Again are still there; then
returns a zero-row ledger and asserts "No Games In This Period.". Against the
unfixed page that test fails: the alert disappears after Try Again.

## 2. `20260930233000` and `20260930234000`

Re-checked after `git fetch origin`: both now exist on remote branches, under
the same version and name production recorded, on open PRs #5680
(`20260930233000_a_streak_milestone_never_takes_the_daily_reward_down.sql`) and
#5679 (`20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door.sql`).
Per CLAUDE.md 4.5 a second file under either version would never be applied, so
nothing was reconstructed here. For the owners: each branch file is production's
recorded statement plus one trailing newline (35,828 vs 35,827 bytes and
18,911 vs 18,910 bytes; the md5 of each file without its final newline equals
production's `8be44e92...` and `ecdd1cd1...`).

## 3. `20260929130144` (the supply check index migration)

Decision: apply, unchanged (not re-derived, not deleted). Evidence read from
production before applying:

- neither `ca_mint_ledger_asset_created_net_idx` nor
  `ca_mint_ledger_baseline_correction_idx` exists, and `ca_mint_ledger` has no
  reloptions, so nothing of the file is live;
- `fn_ca_mint_register_vs_supply` still runs the `asset = 'chips'` sums and the
  `register-opening-baseline-correction:%` sum the indexes were written for;
- `pg_stat_user_tables.seq_scan` on `ca_mint_ledger` is 118,743 (the file
  measured 31,304 on 2026-09-29), so the intent applies more now, not less.

PR #5678 had just made the file installable through `apply-merged-migration.yml`
(the settings now sit in one bounded transaction). Through that workflow:

- 00:41 UTC, dry run (run 36797407537): parsed two concurrent indexes and one
  transaction, then refused because fewer than 12 minutes remained before :50.
- 01:03:49 UTC, dry run (run 36799264118): `DRY RUN: nothing sent.`
- 01:04:20 UTC, live (run 36799309219, dispatched by a parallel session that
  owned #5678): both indexes built and validated (24.6 s and 37.9 s), the
  settings transaction committed in 123 ms, and version `20260929130144` was
  recorded under its own name. This session did not send a second apply; the
  installer would have refused it as already recorded.

Production readback after the apply, the file's own `@live-proof`: both indexes
present with `indisvalid`, and `ca_mint_ledger.reloptions` carries
`autovacuum_vacuum_insert_scale_factor=0.0` and the five sibling settings.

**Locks.** Both indexes are `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, sent one
at a time before the transaction: SHARE UPDATE EXCLUSIVE on `ca_mint_ledger`,
which does not block inserts, updates or reads on the money path; it waits for
transactions already open on the table and conflicts only with other DDL,
VACUUM and ANALYZE on it. The installer refuses to start with fewer than 12
minutes before :50 UTC. The `ALTER TABLE ... SET (autovacuum_...)` transaction
takes SHARE UPDATE EXCLUSIVE under `lock_timeout = '1s'` and
`statement_timeout = '5s'`.
