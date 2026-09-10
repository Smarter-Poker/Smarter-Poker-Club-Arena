# tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts

A migration that redefines one of the functions on `fn_ca_guard_watchlist()`
must call `fn_ca_declare_guard_redefinition('<guard>', 'migration <name>')` in
the same transaction, so the baseline moves with the definition and
`fn_ca_guard_defs_watch` has nothing to report. A declared change is recorded;
an undeclared one - a hand edit, an unreviewed CREATE OR REPLACE, a silent
rollback - still moves the hash away from its baseline and still raises. The
watchlist is read out of the newest migration that defines it, so adding a
guard extends the law automatically. The test also pins that the watcher itself
was never muted or narrowed.
