# Record installed retention successors without changing their SQL

Required Client Unit Tests shard1 job114939017088 failed the existing migration-liveness and configured-retention source contracts. The batching migration and cadence migration alter original owners without declaring new persistent objects. Their immutable installed bytes now have verified rows in the maintained recorded-migrations manifest, so the existing guards can distinguish a production recording from new SQL.

Actual batching version20261012174400 hashes to5c606478d8f3058d86f5f765e5e2ef4b. Actual cadence version20261012181304 hashes toeed8b99890d22ec62e5bb2ac50a95b38. Both hashes were independently read from schema_migrations and fn_ca_migration_text and matched against the actual source bytes. The earlier reserved cadence174649 did not install and is not recorded.

The existing three liveness/retention/verified-recording laws passed42/42 assertions on an owned source template carrying the actual81304 restamp. Tests, guards and installed SQL are unchanged. The parent delivery retains responsibility for the final candidate's exact restamp, required hosted checks, protected integration and live cleanup capacity proof.
