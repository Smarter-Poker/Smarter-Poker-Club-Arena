# tests/a-migration-file-that-records-is-not-a-proposal.law.test.ts

This estate applies schema straight to production and does not always commit
the .sql file. Measured 2026-09-21 against
`supabase_migrations.schema_migrations`: 4,399 applied migrations carry
recordable statements and **2,460 have no file in either estate repo** (874 of
those at or after the 2026-08-25 floor). Closing that gap means adding files
whose only purpose is to write down what production already ran.

Four checks refused to let that happen, and each refused for a reason that is
correct about a PROPOSAL and meaningless about a RECORD: eleven SECURITY
DEFINER functions "a browser could call" whose live ACLs are
`{postgres=X, service_role=X}`; two "undeclared" money triggers that are
already live rows in `ca_declared_money_triggers`; a band-aid refusal aimed at
`fn_tournament_payout_reconcile`, which CLAUDE.md 10.9 names as the platform's
own idempotent settlement path; and a guard law whose only pardon needs a
SUCCESSOR FILE that is itself inside the gap - a mechanism unreachable from
inside the gap it exists to close.

One defect with four faces: a check treating an added file as a prediction
about what production will become, when the file is a record of what
production already is.

The distinction is a **sha256 against production**, not a marker and not an
allowlist: the file's bytes, trailing newlines stripped, must equal the applied
statements joined by newlines. To forge it for a migration production has not
run you would have to run it first, at which point it IS a record and the
question the check was asking is moot. One byte different and it is a proposal
again. The digests are read from `origin/main`, never the working tree, so a
pull request cannot add its own pardon; "could not tell" is printed and judged
as a proposal, because the cost of judging a record as a proposal is one
blocked file and the cost of the reverse is an unjudged migration.

This law pins both halves for all four checks: a byte-exact record is taken out
of each check's hands, and a genuinely dangerous NEW migration - a browser-
reachable SECURITY DEFINER writer that never asks who is calling, an undeclared
trigger on `table_seats`, and a repair-named function, all in one file - is
still refused by every one of them. It also pins that the legacy
`-- BACKFILLED` first-line marker, which `check-definer-authorization` used to
honour outright, pardons nothing any more: a marker is text, so anything could
claim it.
