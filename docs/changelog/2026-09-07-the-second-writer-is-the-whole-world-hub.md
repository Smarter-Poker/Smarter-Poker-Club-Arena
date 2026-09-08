# The second writer is the whole World Hub, not one directory

2026-09-07, 22:35-23:05 UTC. The deep dive over phase 7 (#3565 here, #1561 in
the World Hub), run to Dan's standing order before phase 8 opens. Migration
`20260907224656_the_second_writer_check_speaks_about_money_doors`, applied and
proved in-transaction, byte-identical to the recorded statements. Branches
`fix/phase-7-deep-dive` here and `fix/the-legacy-engine-and-the-register` in
the World Hub.

## What held

- #3565 merged as `179e216`; every phase 7 file is on `origin/main`
  (`git cat-file -e`, twelve paths); #1561 merged as `098e553` and the five
  removed routes are gone from the World Hub's `main`.
- Both phase 7 migrations byte-identical to `schema_migrations.statements`
  (`025bfdcd…`, `418c78be…`); `fn_ca_chip_statement`, `fn_ca_second_writer_check`
  and `increment_column` live with the grants the migrations state (statement:
  anon no, authenticated yes; the other two service_role only); both generic
  doors `approved` in the register.
- The statement, re-run on the busiest wallet of the evening after the merge:
  reconciles, 525 ms.

## What did not - four defects, and the fourth is the shape again

**1. The check watched one directory of the second writer.** It scanned
`pages/api/club-arena/` and said "0 errors". The coverage test asked what it
was NOT looking at and scanned the whole World Hub server side - `pages/api`,
`src/lib`, `lib`: 1,076 files, 323 `.rpc()` calls. Outside the directory it
watched, the legacy World Hub poker engine (`src/lib/poker-engine/LobbyManager.js`,
imported by `pages/api/poker/engine/*`) was calling **two doors the register
closed on 2026-09-04** - `award_bbj` on every bad-beat trigger,
`add_bbj_contribution` on every raked hand - and `increment_settlement_counters`
with `(p_club_id, p_rake, p_hands)` against a live `(p_club_id, p_period)`, plus
`record_insurance_transaction` twice with fields the live signature does not
take. The engine has no production request in seven days of Vercel logs (the
Hetzner engine took every table), so no chip moved wrongly; the check simply
answered confidently about a scope nobody had stated. It now scans all three
roots, recursively (sparse checkout of the same three), and its unit test
pins the walk.

**2. The scanner leaked nested keys.** `p_details: { hand, equity }` put
`hand` and `equity` into the parameter list and reported four correct calls
(`record_arena_audit_log`, `fn_ca_operator_mark_executed`,
`purchase_vip_with_diamonds_atomic_v3`, `fn_training_cache_record_event`) as
mismatches. The payload is now walked with balanced braces, strings and
comments skipped, and only top-level keys are taken;
`tests/unit/auditSecondWriterScanner.test.ts` pins nested objects, arrays,
strings with commas, comments with commas, spreads, and the provisioning-zero
rule for direct writes.

**3. The check had one severity, so widening it would have paged on chips
about things that are not chips.** Widened, it also finds five calls whose
parameter names match no live signature on functions the register has never
heard of: `pages/api/rg/self-exclude.js` sends `p_until` where the live
function takes `p_duration_hours` - **responsible-gambling self-exclusion has
answered PGRST202 on every call**; `rg/session/reality-check.js` sends `p_ack`;
`admin/check-auth-uuid.js` sends `email_pattern` for `p_email`;
`lib/game-engine-service.ts` sends `p_level_id`; and `stripe.js` carries a
deliberate fallback to a renamed function. Real defects, their lanes' to fix,
named in the World Hub audit note. Severity is now the database's word: a
finding on a money door (in the register, any status, or a balance writer) is
an error and fails the run; on any other function it is a warning, reported in
full with `money: false`. `closed_door` is always an error. Proved in the
migration against five calls whose truth is known.

**4. The scanner had no unit test and could not be imported without running.**
`main()` is now guarded by `import.meta.url`; `scanRoute`, `objectBody`,
`topLevelKeys` and `walkRoutes` are exported and tested.

Also: a `second-writer-exempt: <reason>` annotation on the line above a call
is reported under "exempt (a written reason on the call; still a
disagreement)" and never counted as fine - the same device CHECK 18 uses
(`freeze-exempt:`), for the two insurance calls in the dead engine that cannot
be rewritten without guessing fields.

## The World Hub side (`fix/the-legacy-engine-and-the-register`)

The two closed-door calls are removed - each handler says once that the Club
Arena engine pays the jackpot from the pool - the counters call sends
`{ p_club_id }`, and the two insurance calls carry their written exemption.
Against that branch: 323 calls, 288 checked, 33 unchecked, 2 exempt, **0
errors on money doors**, 5 warnings, 0 direct balance writes.

## The statement

Its footer now says what the balance is NOT: the wallet only - chips on a
table or in a tournament are not in it until they come back, and promo chips
are a separate wallet. The audit block was already computed on that basis; the
words were missing.

## The reader, exercised

`schema-manifest-refresh.yml` was dispatched by hand after #3565 merged so the
`second-writer` job's App-token checkout of the World Hub and its RPC call ran
once under CI before the next hourly cron. Its outcome is recorded below the
line when this branch is pushed.

## For a decision - not done here

- **Delete the legacy World Hub poker engine** (`src/lib/poker-engine/`,
  `pages/api/poker/engine/*`): dead in production, still holds money calls,
  and is imported by `manage-table.js` and `update-table-settings.js`, so it
  is not a one-file removal.
- The thirteen uncalled money routes from the phase 7 changelog, unchanged.
- The four unregistered writers `fn_ca_money_rpc_drift` reports for other
  lanes' work today, unchanged.
