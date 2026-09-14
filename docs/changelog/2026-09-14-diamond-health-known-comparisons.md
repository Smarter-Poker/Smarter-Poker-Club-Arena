# Require known comparisons before reporting a clean trial balance

The health reader counted only nonzero, non-NULL differences. An empty result,
missing account or missing baseline could therefore report that every account
reconciled. Native PostgreSQL reproduction confirmed four false-clean cases.

The report now requires exactly one known comparison for each of its five
reconciling accounts. Incomplete results report unknown; any known discrepancy
still reports critical. Informational rows may retain their intentional NULL
comparison. The existing health watcher already reports unknown results.

The migration refuses changes to either the exact health reader or its source
trial-balance contract. Service-only execution remains enforced. Native tests
exercise the full health function against controlled trial-balance output,
including complete readings, missing baselines, duplicates, known discrepancies,
role permissions, replay and definition drift. Other health dependencies are
unavailable in that fixture and correctly remain unknown.

This changes the reporting verdict only. It does not qualify or modify balances,
journals, custody, snapshots, accounting policy or historical incidents.
