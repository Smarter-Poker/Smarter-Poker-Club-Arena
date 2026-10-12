# Native recovery export without Docker

Recovery preparation previously stopped when the authenticated CLI schema dump
required unavailable Docker. The maintained native driver now consumes the
configured CLI's ephemeral connection details only in memory, checks the exact
linked project, verifies the database certificate and hostname, and refuses
incomplete or competing artifacts. Its full archive mode retains every schema
and table. It makes no financial changes and never claims restore qualification.

A pinned PostgreSQL 17.11 client batches the existing slow catalogue reads while
preserving native archive selection and serialization. Both the stock driver
and built client are tested by an actual isolated archive and restore, including
permissions, RLS, functions, partitions and identity state. Those checks run in
the existing required accounting CI jobs. The build creates no publisher,
watcher or production installation.

The production schema export completed during launch-reset preparation. Full
production recovery, accounting cutoff, closing journal, reset/undo and live
cutover remain separate unqualified acceptance items. See the native export
runbook for the exact distinction; this change does not certify a launch reset.
