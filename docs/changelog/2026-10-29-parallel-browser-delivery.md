# Parallel browser qualification on paid runners

The real scoped stylesheet delivery took 12 minutes in its browser gate. Measuring/removing an unused 12 GiB Android SDK consumed 98 seconds despite 369 GiB free. The cleanup now remains on lower or unparseable capacity and is omitted only after verifying at least 100 GiB free. Failed capacity reads remain visible failures.

The existing CSS Beat browser cases run as three disjoint Playwright shards on separate paid VMs. The same Chromium/WebKit projects, specs, retries and case deadlines remain. The real Table Studio, financial-decision and push enrollment gates retain their exact commands once on mandatory shards 1, 2 and 3 respectively. Every shard and the independent Diamond playfield must pass the existing required aggregate; failures and unknowns are not accepted. Each runner retains one isolated preview build and its cleanup. Failure artifacts identify their shard.

Financial/native test programs, money authority, required check identities, publication serialization, secret isolation and rollback controls are unchanged. No SQL or engine operation is involved.
