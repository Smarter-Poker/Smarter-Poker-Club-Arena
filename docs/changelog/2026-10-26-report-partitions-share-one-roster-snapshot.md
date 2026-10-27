# Human-result report partitions share one read-only roster snapshot

Protected-main report40419703965 completed all28 queries but refused their
combined receipts. Reproducing the same historical partitions through configured
read-only database access found three roster digests. Every partition was valid
individually; their combined report correctly refused inconsistent identities.

The cause was opening a new PostgreSQL session and snapshot for every partition.
A profile created or reclassified during report execution changed its current
roster basis, making an otherwise complete report fail.

The CLI now runs its existing partition queries in one bounded psql session and
one REPEATABLE READ READ ONLY transaction. Each statement retains its five-second
limit; the whole session retains the ninety-second deadline and eight-MiB output
bound. Failed sessions publish no scores. The existing roster-consistency,
attribution, complete-window and score-validation predicates remain unchanged.
This needs no database schema change, engine restart or additional schedule.

The native PostgreSQL regression uses a real concurrent profile insert between
two actual partition SELECTs. READ COMMITTED reproduces the mismatched digest
refusal; the maintained repeatable snapshot passes the unchanged validator. The
actual CLI also retains its eight-partition, ordinary-name/URI connection and
private failure-diagnostic controls.
