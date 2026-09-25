# A recording is verified, not asserted - and the guards were wrong 32 times out of 33

2026-09-23. Issue #5008. Ten migration files that only RECORD SQL production
had already executed were refused by four rules across three guards, plus a
fifth in a law test. This lands eight of them, fixes what was actually wrong in
the guards, and writes down what production says about every finding they
raised. The last two need the guard fix to be ON main first; see the end.

## What was refused, and what production says

All ten were recovered from `supabase_migrations.schema_migrations.statements`
as `array_to_string(statements, chr(10))` and NOTHING else - no header, and no
trailing newline the database does not already have - so each file's md5 equals
the md5 column of `public.fn_ca_migration_text(version)`. The oldest,
`20260916111614`, ran against production on 2026-09-16.

That is a correction worth naming. Issue #5008's table, and the ten files PR
#5110 landed, use `array_to_string(statements, chr(10)) || chr(10)`, which
appends a newline nine of these ten already had. One extra invisible byte is
harmless on its own and fatal to the idea the mechanism rests on: it is not
byte-exact, and `scripts/ci/money-trigger-recovery-policy.json` - which was
already on main, and hashes `array_to_string(statements,'')` - cannot bind a
file that carries it.

| rule | what it claimed | what production says |
| --- | --- | --- |
| definer, writer rule | eight SECURITY DEFINER writers a browser role can execute and that never consult `auth.uid()` | none of them is reachable by any browser role. Every one is a `CREATE OR REPLACE` of a function that already existed and was already revoked; a replace PRESERVES grants, which this guard's own header records as the case its "silence means open" reading gets wrong |
| definer, anon rule | ten functions reachable without an account | nine were never reachable. The tenth was, and is covered below |
| definer, roster rule | `get_current_settlement_period` is an unscoped set-returning definer a browser can reach | `proacl` is `{postgres=X/postgres}`. No browser role |
| money trigger | 33 undeclared triggers on money tables | 32 of the 33 are not triggers any of these files create. They are text inside dollar-quoted JSON blobs the migrations pass to `jsonb_array_elements()` to ASSERT that a trigger is present and unchanged. The one real one was declared, ten hours late. `fn_undeclared_money_triggers()` returns zero rows platform-wide |
| band-aid | three repair-shaped functions being declared | all three were first declared between 2026-08-24 and 2026-08-31 and hold rows in `docs/BAND-AIDS-REGISTER.md`. One of the ten files is 10.12 being obeyed: it REMOVES the branch of the minutely reconciler that rewrote `tables.stakes`, because a trigger now owns that column |
| guard-defs law | `20260917181100` redefines `fn_ca_post_correction` without declaring it | true, and already repaired: `20260921022420_declare_three_installed_guard_redefinitions` applied the forward declaration on 2026-09-21, and `ca_guard_defs.declared_ref` has named this exact migration since 02:25:53Z that day |

## The one that was real

`fn_notification_has_personal_destination(uuid, uuid)`, created by
`20260916111614`. The migration wrote
`GRANT EXECUTE ... TO anon,authenticated,service_role`, the function is
SECURITY DEFINER, and it never calls `auth.uid()`. So a caller with no account
could execute it.

It was open from **2026-09-16 11:16:14Z until 2026-09-19 07:13:57Z - 2 days,
19 hours, 58 minutes** - and was closed by
`20260919071357_anon_grant_from_public_is_the_one_that_mattered`, before this
work began. Read live on 2026-09-23: `proacl` is
`{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` and
`has_function_privilege('anon', ...)` is false.

`authenticated` keeps EXECUTE, deliberately. The function is the qual of RLS
policy `personal_notification_destination` on `public.notifications`; a policy
expression evaluates as the QUERYING role, so revoking it would deny every
SELECT on notifications to every logged-in player. It is STABLE, read-only,
takes two uuids the caller must already know, and answers one boolean about
whether one notification has an operational destination row. Left as it is,
with the reason written here.

Nothing was widened. No allowlist grew. No guard assertion was weakened.

## What changed in the guards

**1. The blanket bypass that was already there is closed.** `-- BACKFILLED` on
line one has skipped all four definer rules since 2026-09-01 with nothing
checking that the file recorded anything - `check-migrations-applied`'s own
header names "a BACKFILLED marker on a file that was not backfilled" as a
dishonest escape it did not want to leave open, and it was open the whole time.

`scripts/ci/recording-only.mjs` replaces it with a claim that can be checked:

- a row in `scripts/ci/recorded-migrations.manifest.json` naming the version,
  the path and the md5 of the FILE BYTES;
- the file hashing to exactly that md5;
- that md5 being what production's `schema_migrations` holds for that version.

The first two are offline. The third is the lock, and it is the reason this is
a category rather than a flag: **a genuinely new migration cannot be made to
hash to a version production already has**, so it cannot wear the marker. The
negative test in `tests/a-recording-is-verified-not-asserted.law.test.ts`
proves it - a migration that creates a browser-reachable SECURITY DEFINER
writer, a trigger on `table_seats` and an `fn_backpay_*` function is still
refused by all four rules with a forged manifest row in place.

Three outcomes, not two (10.86 rule 1): `new`, `recorded`, and `unknown` for a
claim that could not be checked. `unknown` never reads as `recorded`; the file
is judged strictly and the guard says out loud that it could not tell.

The old marker is FROZEN, not revived: honoured below `RECORDING_BINDS_FROM`
(`20260915`), refused at or after it. 577 files carry it and the newest is
`20260914130826`, so the cutoff refuses nothing that exists. The law refuses
any attempt to move it forward.

**2. The exemption has a reader, and it is named.**
`scripts/ci/check-recorded-migrations-evidence.mjs` runs inside
`Applied Migrations Are Recorded`, which already holds the database
credentials and already files an issue when it goes red. Per manifest row it
asks production: does `schema_migrations` hold this version with this md5; is
anything the file declares in `fn_definer_exposure_audit()`; is any trigger it
names in `fn_undeclared_money_triggers()`; does every repair-shaped name it
declares already have a register row. Exit 3 is COULD NOT TELL and is not
success.

**3. `check-money-trigger-declared` could not see dollar-quoted data.** It
stripped comments with two regexes and read every byte of every `$tag$ ... $tag$`
block as SQL the migration executes. A block is now treated as code only when
it follows `AS`, `DO` or `EXECUTE` - a function body, an anonymous block, or
plpgsql dynamic SQL, which are the three places a real `CREATE TRIGGER` can
hide. Single-quoted literals are still kept, because the declaration lives in
them. Findings on these two files: **33 to 1**, and the 1 is the real one.

**4. `check-definer-authorization` was quadratic, and a guard too slow to run
is a guard nobody runs.** It rebuilt `branchSql` per file and rescanned the
whole string once per function name, so cost was files x functions x total
bytes. Measured on this set (1.9 MB, 196 declared functions): 128 seconds for
the 1.67 MB file alone, and no verdict at all within 25 minutes for the ten
together - in CI a job timeout, which is a guard that does not answer rather
than one that refuses. The scan is unchanged; it is memoised, and the
GRANT/REVOKE statements are parsed once into a ledger instead of once per name.
**128 s -> 5 s for the whole set**, and all 55 existing gate tests still pass.

## Out of scope, found and left alone

`fn_definer_exposure_audit()` reports one live `unauthenticated_writers` entry
on the platform: `recalculate_leaderboard_ranks(p_promotion_id uuid)`,
SECURITY DEFINER, `authenticated=X`, no `auth.uid()`. It is not declared by any
of these ten files. Its whole body recomputes `promotion_leaderboards.rank`
from `dense_rank() OVER (ORDER BY score DESC, updated_at ASC)` for one
promotion, so a caller can force a recompute to the correct value and nothing
else; it moves no money and cannot set an arbitrary rank. It is reported here
and on issue #5008 rather than changed, because an unrelated production grant
does not belong in a guard change.

The workstation's `SUPABASE_SERVICE_ROLE_KEY` in `.env` is rejected by
production with `Unregistered API key`, so the live half of the evidence check
could not be exercised from this machine; every live claim in this changelog
was read through the Supabase MCP and through `psql` on the pooler instead, and
the evidence script correctly exits 3 rather than green when it cannot ask.

## The two that are not in this change, and why

`20260917060339` and `20260917181100` are the only two of the ten that
`check-money-trigger-declared` says anything about, and the required
`Money trigger declaration authority` check cannot see this branch's fix.

That check is `Trusted Money Trigger Recovery`, and it is right to be built
that way: `pull_request_target`, `actions/checkout` at the DEFAULT BRANCH,
policy loaded only from reviewed main code, live evidence read by the trusted
job itself, never from a PR artifact. It therefore runs MAIN's copy of
`offenders()` - the dollar-quote-blind one - which finds 8 phantom triggers in
`20260917060339` and 25 in `20260917181100`, and refuses both for want of a
recovery contract. A guard that deliberately does not trust the PR is a guard
the PR cannot fix in the same breath.

So the two are a follow-up, and everything they need is in this change:

- the dollar-quote fix, which on main takes `20260917060339` to zero findings
  and `20260917181100` to one;
- the recovery contract for that one, added to
  `scripts/ci/money-trigger-recovery-policy.json` with the live evidence:
  `chip_ledger.accounting_tournament_recognized_bank_immutable`, a
  refusal-only BEFORE DELETE OR UPDATE guard that writes nothing, declared in
  `public.ca_declared_money_triggers` on 2026-09-18 04:18:09Z by migration
  `20260918041452`, whose file is already on main. The row binds the original
  file's sha256, the declaration file's sha256, and the live trigger
  definition, function and register note, so a byte changed anywhere in it
  evaporates the contract.

The entry for `20260917181100` in
`tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts` moves with
the file, for the same reason its own bound list requires both halves present.
