# Leaderboard Isolation Keeps Private Restore Input Readable

The isolated restore prepares its complete ordered input privately on the host
before passing it to one PostgreSQL connection through standard input. Temporary
event-owner elevation, the validated remaining archive, and original role
attribute restoration remain in one `psql --single-transaction` operation with
`ON_ERROR_STOP`. Failed input preparation never invokes PostgreSQL.

The previous helper created owner-input files with mode 0600, then copied them
into a container whose PostgreSQL processes run as postgres. Docker copies
files into a container as root while preserving permissions, creating a
concrete unreadable-input hazard. The preceding qualification run 37573252577
failed during remaining restoration; its private error was deleted during
cleanup, so the exact first failing error is not claimed recovered.

No source database permissions, runtime role attributes, archive ownership,
catalog comparison or cleanup safeguards are weakened. Focused executable
contracts retain input order, complete preparation before execution, one
connection and transaction boundaries. Actual PostgreSQL restoration, Auth
and financial qualification remain separate pending proofs.
