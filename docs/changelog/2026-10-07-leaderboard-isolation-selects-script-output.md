# Leaderboard Isolation Selects Script Output

The remaining schema archive renderer now explicitly selects standard output
with `pg_restore --file=-`. PostgreSQL requires either a database or an output
file selector; the previous script-only command supplied neither and refused
before processing the archive. The owning qualification run 37571095313 failed
at this rendering stage. No source database mutation was performed.

The actual extracted renderer command has a focused regression for stdout,
schema-only selection, preserved archive list, and absence of database/create
or transaction-boundary options. A finite installed-client argument-parser
check shows the former command refuses the missing selector and the corrected
command reaches archive validation. That check is not PostgreSQL 17 restoration
proof. The atomic restore, original owners/grants, exact catalog comparison and
verified owned cleanup remain unchanged. Actual Auth and financial qualification
remain pending a successful faithfully restored runtime.
