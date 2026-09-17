# MTT preparation concurrency checks

The existing accounting PostgreSQL job invokes `test-mtt-unlimited.py --mode preparation`.
After the full eight-slice preparation chain, that runner executes these six
stock PostgreSQL specifications against the bound synthetic-future fixture,
then the two creation specifications against the bound legacy fixture. Each
case gets a fresh database cloned from the complete prepared catalog.

The existing strict `mtt_isolation_results.py` consumer requires one exact
permutation, every completed step, the fixture's actual `pg_blocking_pids`
observation and matching final assertion notice/result. Exit zero alone cannot
pass. The runner then checks that the case has no remaining connections,
drops its database and verifies its absence. Overall cluster cleanup is also
mandatory. Fixture/spec hashes are checked before and after execution.

The fixtures are preserved byte-for-byte from the separately qualified 070
component. Their old source-only header records their original authorship;
current execution is established by the runner receipt, not that header.
`satellite-restart-future.sql` selects a synthetic future ABI while loading
local test inputs. `satellite-creator-legacy.sql` retains the legacy ABI and
checks the actual accepted heads-up configuration and table. The real business
calls use enabled original guards and real captured authorities. These cases
assert unchanged financial stores and exact empty escrows; they perform no
funded entry or payout journey.

This is preparation branch qualification. It does not apply or qualify the
real activation transaction. The six activation race requirements remain
explicitly pending in `source-binding.json`. Installation, old-writer
compatibility, publication and live behavior require separate evidence.
