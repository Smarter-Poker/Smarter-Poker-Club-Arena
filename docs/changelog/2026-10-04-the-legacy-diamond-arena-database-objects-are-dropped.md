# The legacy Diamond Arena database objects are dropped (2026-10-04)

Poker Arena Diamond build programme, Phase 12 of 12, line 7: "Remove exclusive
obsolete database functions, triggers and tables through new forward migrations
after reconciling balances and obligations. Preserve historical migration files
and financial journal evidence."

Migration: `supabase/migrations/20261004214251_the_legacy_diamond_arena_database_objects_are_dropped.sql`.

**State when this was written: the migration is on a branch. It is not merged
and not applied.** Nothing below describes production after the change; the
"live evidence" is what production held before it.

## What each object was, and the live evidence

Read from production (project `kuklfnapbkmacvwxktbh`, Postgres 17.6) between
21:30 and 21:45 UTC on 2026-10-04, with read-only queries.

| object                                                      | what it was                                                                                                                                                                              | evidence that it is inert                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public.fn_arena_deposit(integer,text)`                     | The chip-backed manual arena deposit of `20260908034530`. `20260909065458` (custody) replaced its body with `RAISE EXCEPTION 'Manual arena deposits are retired; use game reservation.'` | `pg_get_functiondef` md5 `0eee60a9c665445960e282de503da96f`, body 87 characters. No other function body, view, trigger or policy names it except the wallet guard's allowlist. No caller in Club Arena or the World Hub. No statement in `pg_stat_statements` names it.                                                                                                     |
| `public.fn_arena_withdraw(integer,text)`                    | The withdrawal twin; raises `'Manual arena withdrawals are retired; use game release.'`                                                                                                  | md5 `fcf9a0a122a172e35e8d59b0f372900c`. Same reads, same result.                                                                                                                                                                                                                                                                                                            |
| two lines in `public.fn_guard_profile_privileged_columns()` | The guard admits a `profiles.diamonds` write when the call stack names a listed function. Both doors were listed.                                                                        | Guard preimage md5 `d40c547c47f3d0516dc24f22ab53da7e`, the text `20260930121500` left, equal to the `ca_guard_defs` baseline.                                                                                                                                                                                                                                               |
| `public.diamond_arena_events`                               | The retired standalone Diamond Arena's trivia event log (`score`, `correct_count`, `prize_awarded`, `entry_fee`, `diamonds_delta`). Not a financial journal.                             | 0 rows; 0 inserts since statistics began; no trigger; no inbound foreign key; in no publication; named by no function body; no application statement in `pg_stat_statements`. Two outbound foreign keys, to `auth.users` and `profiles`. One policy, select for everyone.                                                                                                   |
| `public.profiles.diamond_arena_preferences`                 | The standalone arena's per-player settings (`jsonb`).                                                                                                                                    | 1,841 rows `NULL`, 3 rows `{}`, none holding a value. No default, index, constraint, view, trigger or policy depends on it. Named by two function bodies, `update_page_preferences` (md5 `d98e1becf64a5c606d310b26b0a1e49c`) and `fn_close_account` (md5 `3e00cb1086da53eac75ba2d34001a75a`). Its own grant is `SELECT` to `authenticated`. No reader in either repository. |

Balances and obligations: `poker_diamond_custody` holds 0 rows and both
`ca_arena_settings` switches are false. None of the five objects holds or moves
a Diamond or a chip.

## What the migration does

One transaction, `lock_timeout` 2 s.

1. **Preimage.** Refuses unless the five function texts are the ones above, no
   other function names a dropped object, the arena is closed, custody is
   empty, both register rows are `retired`, the table has no trigger, inbound
   foreign key or publication, and the column has no dependent.
2. **The wallet guard.** Reads the live text, removes the two lines, executes
   the result, and requires the installed text to equal the intended one byte
   for byte (postimage md5 `b140541b68ba8f97ce74d7e0a5e7680f`). The guard is on
   `fn_ca_guard_watchlist()`, so the redefinition is declared through
   `fn_ca_declare_guard_redefinition`, as `20260919223115` and `20260930121500`
   did. The body is never re-typed.
3. **The two functions naming the column.** Edited the same way.
   `update_page_preferences` loses the name from its allowlist (postimage
   `8cd27b35b801feb60a239bdf1c0c51cd`); `fn_close_account` loses it from the
   list it blanks (postimage `b563620364f47288038818f2f0e24ad9`). Grants are
   compared before and after.
4. **Locks.** `profiles`, `auth.users` and `diamond_arena_events` are taken in
   one `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` under a 250 ms timeout, retried
   after 100 ms, at most 40 times, then the file gives up with nothing applied.
   `auth.users` is in the list because dropping the table removes the
   foreign-key triggers it placed there, which takes that lock anyway; taking
   the three together is what keeps the file out of a lock-ordering deadlock
   (`docs/changelog/2026-10-01-a-drop-trigger-takes-the-auth-schema-hostage.md`).
5. **Emptiness, read under the locks.** 0 rows in the table; no
   `diamond_arena_preferences` other than `NULL` or `{}`.
6. **The drops**, with no `CASCADE` and no `IF EXISTS`: the column grant and the
   column, the table, the two functions.
7. **Postconditions**, including that both register rows are still there.

It declares six `@live-proof` lines, one per end state.

## The register rows

`ca_money_rpc_registry` keeps `fn_arena_deposit` and `fn_arena_withdraw` as
`retired`. No reader reports a retired row whose function is absent:
`fn_ca_money_rpc_drift` walks `pg_proc` for unregistered writers and joins the
register to `pg_proc` only for status `closed`; `fn_ca_second_writer_check` and
`fn_ca_undeclared_money_paths` start from functions that exist. Six retired
rows already have no function (`fn_poker_diamond_recover_releases` among them)
and `fn_ca_money_rpc_drift()` returns nothing. So nothing was changed there.

## What was deliberately not dropped

- `fn_ca_arena_diamonds`: repurposed, it reads the custody float.
- The `arena_deposit` and `arena_withdraw` journal kinds: the custody doors
  write them today. No `diamond_transactions` row is touched.
- `ca_arena_settings`: it holds the two switches.
- `fn_ca_arena_seat_is_same_asset` with DR15, and the `arena_withdrawals`
  payout-freeze scope (`fn_ca_open_payout_freeze`): open owner questions.
- `public.poker_hands`: 0 rows, no function names it, no statement in
  `pg_stat_statements`, one policy pair, a foreign key to `poker_tables`. It is
  not an arena object: `20260419214617` tightened its RLS months before the
  arena existed, and `poker_tables` holds 4 rows read by eight poker-near-me
  functions. It may well be dead, but that is a World Hub poker-near-me
  question and was left alone.
- Historical migration files: untouched.

## What moved in the repository with it

- `scripts/ci/schema-manifest.d/the-legacy-diamond-arena-database-objects-are-dropped.json`:
  tombstones for the table and both functions. `diamond-arena.json` no longer
  promises the two functions (a name cannot be both added and removed). The
  convention has no column tombstone; the column leaves the nightly snapshot.
- `tests/sql/diamond-concurrency-doors.sql` and its manifest: the guard block,
  its pin, its line in the proof list and its two manifest entries are the
  postimage.
- `tests/law/DiamondTransfersGoThroughOneDoorAndAGiftIsOneTransaction.law.test.ts`:
  "the pair raises" is now "the pair is dropped".
- `tests/law/DiamondArenaMoneyHasTwoDoorsAndBothAreRegistered.law.test.ts`: a
  header note that it pins the foundation migration as history.
- `tests/the-legacy-diamond-arena-database-objects-are-dropped.law.test.ts`,
  new, with `docs/laws.d/the-legacy-diamond-arena-database-objects-are-dropped.md`.
- `scripts/ci/check-stranded-writers.mjs`: `diamond_ledger` was labelled
  "Diamond Arena orb". It is the shared Diamond wallet ledger.

Captured fixtures that were **not** changed, because each is a point-in-time
preimage pinned by the migration or probe it serves, not a pin of the current
estate: `tests/sql/diamond-transfer-door-fixture.sql` (the guard of 2026-09-19,
which `20260919223115` pins), `tests/fixtures/accounting-delivery/diamond-games/`
(catalog capture of 2026-09-16 with sha256 witnesses), `tests/sql/diamond-concurrency-schema.sql`,
`tests/fixtures/full-weekly-accounting/`, and every `inputs/schema.sql`,
`provider-check.sql` and `provider-supplement.sql` under `scripts/ci/probes/`
and `scripts/qualification/fixtures/` (sha256-pinned in their manifests, loaded
into a disposable cluster, regenerated by no script in this repository).

## How it was proved, and what was not

Proved on a disposable local Postgres 16.15 cluster, never on production
(CLAUDE.md section 2 rules 3 and 7). The fixture held the seven production
function texts byte for byte (each rendered to its production md5 locally), the
`profiles`, `auth.users` and `diamond_arena_events` shapes with both foreign
keys and the policy, and the register and guard-baseline tables.

- Clean apply: both doors, the table and the column gone; the three postimage
  md5s installed; grants unchanged; the guard baseline moved and declared; both
  register rows kept.
- A second apply is refused at the preimage.
- Refusals, each leaving the estate untouched: a row in the table; a real
  preference value; a guard that moved; a view on the column; another function
  naming a door; an open switch.
- With `profiles` held by another transaction the file gave up after 14.0 s
  with nothing applied.
- `DROP TABLE` alone was measured to take `AccessExclusiveLock` on `auth.users`
  and `profiles`; `DROP COLUMN` takes it on `profiles`.

Not proved:

- The apply on production. Postgres 17.6 with Supabase's `supautils` hooks was
  not exercised. The file writes no `DROP TRIGGER` and no `DROP POLICY`, the two
  statements that hook is known to widen, but whether it intercepts `DROP
TABLE` or `LOCK TABLE auth.users` was not measured.
- The Diamond concurrency suite (`run-diamond-concurrency.py`) needs Postgres 17
  binaries, which this sandbox does not have; only its static pin check was
  run. CI runs the suite.

## Found on the way, not changed

`update_page_preferences` tests `FOUND` after `EXECUTE ... INTO`. `EXECUTE`
does not set `FOUND`, so on the local cluster the unchanged production text
raised `Profile not found` for a valid caller and a valid column. If production
behaves the same, no World Hub page preference saved through this function is
persisted. It predates this change, is outside it, and is reported rather than
fixed here.
