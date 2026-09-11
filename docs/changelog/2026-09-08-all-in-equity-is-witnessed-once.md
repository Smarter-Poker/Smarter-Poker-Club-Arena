# All-in equity coverage no longer replays seven days of hand JSON

The stats witness used to rediscover whether a seat was owed an equity figure
by scanning seven days of all-in facts and reopening every matching hand's JSON
actions. At production horse volume the audit repeatedly reached its 120-second
deadline and competed directly with live hand settlement.

The table engine now records an obligation before the optional equity worker
starts. Settlement persists that exact per-seat answer as
`ca_hand_facts.all_in_equity_owed`. The audit reads a played-at-leading partial
covering index and counts missing figures directly. Existing facts are not
guessed into the new denominator; the seven-day window becomes entirely
witness-backed as new hands replace pre-deploy history.

The production cutover is deliberately staged. Migration `230007` installs the
column, the capable engine SHA is deployed and every prior process is drained,
the partial index is built concurrently, and only then do `230008`/`230009`
switch the audit. The concurrent-index script repairs PostgreSQL's invalid
same-name artifact after an interrupted build instead of letting `IF NOT EXISTS`
skip it forever.

Fleet readiness is never inferred from the earliest true fact. An operator
stamps one immutable row with the full writer SHA and the UTC instant after the
last old process exited. `ca_stats_health()` publishes that boundary and labels
the window `not_configured`, `collecting`, or `7d`. The existing `*_7d`
Prometheus gauges are `NaN` and the coverage alert is suppressed until seven
days have elapsed and an audit newer than both the full-window instant and the
stamp has run. The exact release sequence and receipts are in
`docs/runbooks/stats-equity-witness-cutover.md`.

The PostgreSQL 17 probe executes the exact predecessor hashes and all three
migrations, leaves a failed concurrent index behind and proves it is rebuilt,
checks an exact and conflicting boundary replay, rejects updates to the stamp,
proves a pre-stamp audit cannot make an aged boundary ready, validates the
single health snapshot, query plan, RLS/ACLs, and full replay.
