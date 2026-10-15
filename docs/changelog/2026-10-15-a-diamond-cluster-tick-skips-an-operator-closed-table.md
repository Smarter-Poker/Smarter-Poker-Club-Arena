# A Diamond Cluster Tick Skips An Operator Closed Table

Migration `20261015181551` (held draft; the owner installs it).

## What Happened

The owner's `close_cash` of 2026-10-15 17:01 UTC left the nine tables of the
Diamond must-move game `f141626a` with status `closed` and lifecycle `live`,
which is how an operator close leaves a cluster table until its resume. From
17:01:16 every pass of that game failed with `23514
diamond_cluster_table_not_admitted`: 633 `controller_tick_error` rows by 18:09,
which is the `ClusterPassErrors` page. After the 18:10:56 resume every other
cluster reopened its tables; the Diamond game could not, because opening a
table projects the cluster first and the projection refused the whole cluster
for its closed siblings. It kept failing (103 more rows by 18:19).

## The Line

`fn_poker_diamond_project_cluster` asked `fn_poker_diamond_plain_cash_table`
of every table whose lifecycle is not `closed`, and that answers false for a
table whose status is `closed`. A closed table deals nothing and cannot break
the plain-cash rule, so the check now skips it. It is judged again the moment
it reopens.

## Proof

`scripts/ci/test-diamond-cluster-operator-close.py` (native PostgreSQL,
workflow `diamond-cluster-operator-close.yml`): 10 checks, including the
baseline refusal on the exact production text and the derived postimage md5.
