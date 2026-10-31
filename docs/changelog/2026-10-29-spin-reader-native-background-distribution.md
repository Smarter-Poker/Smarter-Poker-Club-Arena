# Preserve selective native Spin reader qualification

CI40937402453 Accounting2 failed the unchanged strict successor indexed-history oracle in the held-fee Spin fixture. The original30,000 synthetic rows all copied one unrelated table identity. With only five table IDs, PostgreSQL estimated6,000 target-table rows and chose a hash join with a history sequential scan, although the retained target actually has one history row. The separate root Spin fixture selected its indexed bitmap path, showing the cost-boundary sensitivity.

Keep30,000 histories and both strict planner oracles. Distribute the background over64 real closed-cash table parents outside all five retained events; preserve actual constraints and nullable foreign-key edges, omit generated columns on insertion, and explicitly prove every original document unchanged while the population exists and after exact cleanup. No production SQL or planner setting changes.

Focused real PostgreSQL17 with the configured pg_cron completed the maintained `--held-fee-spin-retention-only` path: original unscoped plan rejected, successor indexed plan accepted, complete five-document equality and semantic controls pass, and all52 retained-fee assertions pass. The statistics migration55ac and its24-case qualification are unchanged. Full exact-head hosted checks remain required.
