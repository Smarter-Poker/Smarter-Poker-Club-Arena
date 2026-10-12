# tests/a-merged-migration-must-be-live.law.test.ts

A migration could merge to main, never be applied, and look shipped: merged,
green, closed. `check-migrations-applied.mjs` asks only of the migrations a
pull request ADDS, only about the objects they declare, and only against a
nightly snapshot, so once a branch merges nothing asks again;
`check-applied-migrations-are-recorded.mjs` asks the opposite direction. On
2026-09-19, across the 202 migrations merged in the preceding seven days,
three had never reached the database: the responsible-gaming SELECT policy,
without which `fn_rg_require_not_excluded` - not SECURITY DEFINER, so reading
with the caller's privileges - could not see a player's own row and turned that
invisibility into permission, telling a self-excluded player `ok: true` for six
days; thirteen anon EXECUTE grants the repository described as revoked; and 27
Early Bird fees still held in escrow. `check-migrations-are-live.mjs` decides
by evidence in three steps and only accuses when it can prove: a
schema_migrations row matching the name, else every object the file creates
existing in the live catalogue, else a proof the file declares about itself as
`-- @live-proof: <boolean SQL>`. Name matching alone produced ten candidates of
which seven were false, because the apply transport stamps its own version and
often a different name - a check that accuses at that rate gets switched off,
which is how the estate already lost `Applied Migrations Are Recorded`. Step 3
exists because an eighth candidate was misclassified by hand, by reading the
settlement function for the wrong lock mode, and what corrected it was the
migration's own assertion refusing on apply: a migration knows what it did
precisely enough to be machine-checked, and a person reading it later does not.
The forward guard is that from 20260920 onward no migration may create nothing
and prove nothing, because that is the exact shape every silent miss had; the
check runs hourly in Production Integrity Audit, so it has a named reader.
Extended 2026-09-30 with the mirror of the same rule: a proof the check COULD
NOT RUN is not a proof that came back false. `declaredProofs` reads one line,
so the three migrations on main whose proof spans several comment lines reached
the database truncated, and 20260929130144 was reported as `proof false:
(SELECT count(*) FROM pg_index i -> rejected: ERROR: syntax error` - the check
reading back its own truncation and presenting it as an answer from production.
`proofIsRunnable` now refuses unbalanced or unterminated text before anything
is asked, which also keeps it out of the shared UNION ALL, and psql runs with
VERBOSITY=verbose so a rejection carrying SQLSTATE 42601 is known to be about
the text we sent while 42883 / 42P01 / 42703 stay failures as before. An
unrunnable proof exits 2, COULD NOT TELL, never 0 and never 1, under the
precedence FAIL > COULD-NOT-TELL > PASS.
