# Spin fixture background maintenance isolation

The disposable Spin PostgreSQL fixture now disables ordinary autovacuum and
requires its existing privileged configuration readback to observe `off`.
The strict zero-unowned-backend guard and all financial assertions remain.
Production database settings and the installed Union accounting package are
unchanged.

CI run 35259484587 refused one unexpected backend before its candidate order
scenario. Successful run 35257089829 used identical fixture inputs and scripts
with zero other backends. The failed capture retained only a count, so the
backend's identity cannot be established. The fixture left ordinary autovacuum
enabled throughout its natural aging interval, contrary to its exclusive-session
requirement. PostgreSQL documents this default and its separate control in
[Automatic Vacuuming](https://www.postgresql.org/docs/17/runtime-config-autovacuum.html).

The new missing/enabled-setting regression failed before the repair; all 56
existing wrapper controls passed afterward. Exact hosted native execution remains
required before merge. This change does not certify the broader historical Spin
programme or the unresolved Union P&L source evidence.
