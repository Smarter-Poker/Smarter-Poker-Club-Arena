# tests/a-record-variable-must-not-shadow-a-table-alias.law.test.ts

`ca-ledger-replay-nightly` was `critical` in `fn_ca_cron_health()` with one run
and zero successes, raising `record "w" is not assigned yet` from
`SELECT COALESCE(sum(w.unkeyable), 0) ... FROM zz_replay_window w`.
`fn_ca_ledger_replay` declares two bare record variables on one line,
`r record; w record;`, and uses `w` as a table alias in two statements that run
before the `FOR w IN ...` loop assigns it. PL/pgSQL resolves the qualified
reference against the declared variable rather than the alias, so the function
reads a record that was never assigned and dies on its first statement after
building its temp tables; the nightly ledger replay had therefore never run, and
neither had `fn_ca_currency_meter()`, which the same cron command calls after
it. Migration 20260919160144 renames the two aliases to `zw` with `pg_temp.ca_patch`,
leaving the record variable and its loop untouched, and asserts the six
remaining `w.` references survive so that the collision cannot be removed by
deleting the wrong half. Measured across all 3,174 migrations, exactly one
carries this collision, `20260910065825_the_journal_window_is_a_snapshot_not_a_clock.sql`,
which is the one that introduced it, so the forward guard binds from 20260911
with the whole history before it clean. The detector took three attempts and is
self-tested here before it is trusted against the tree: the declarations share a
line, so a pattern anchored at line start sees only `r`, and a pattern that
consumes the separating `;` cannot match the next declaration after it. Both
earlier versions reported zero, and a guard that reports zero because it cannot
see is worse than no guard at all.
