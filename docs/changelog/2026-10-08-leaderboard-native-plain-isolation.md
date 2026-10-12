# Leaderboard Native Plain Isolation

The previous dedicated replica export ended with a recovery conflict. The available fatal query text was empty, so neither custom-archive dependency traversal nor another query is established as its cause.

Use native PG17 schema-only plain output, partitioned before creating an isolated destination. The partitioner lexes comments, strings, quoted identifiers and dollar bodies; consumes only the canonical postgres reconnects; refuses connection escapes and transaction/data statements; and validates each private SQL partition through the existing restore validator. Database properties precede a fresh postgres session. Source-owner extension bootstrap remains authoritative. Remaining SQL, exact definitions and extension triggers remain in one transaction with owner attributes restored. All source drift, replica recovery/feedback/WAL, full catalog equality and verified cleanup gates remain intact.

Retained tests include real native PG17 complete catalog equality, cross-schema foreign keys, trigger execution, database/role configuration, extension ownership and quoted keyword names. The mandatory existing accounting lane runs the native fixture. Source contracts preserve allowed/refused routing and failure propagation. Financial candidate SQL is unchanged; only its reviewed preflight identity is refreshed.

Local native qualification does not prove production-schema export, actual Auth authorization, payout qualification, migration installation, client publication or launch readiness. Those remain separately required.
