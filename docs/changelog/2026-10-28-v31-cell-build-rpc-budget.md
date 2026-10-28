# V31 cell building uses its intended RPC budget

R6 supplied all 382 independently verified source exports and passed the complete M1 input-support check. Compaction built 85 of its 107 cells, then PostgreSQL cancelled the next cell under the generic service-role eight-second timeout. The maintained gateway already grants both cell building and sealing 270 seconds; only sealing declared a matching database budget.

The forward migration pins the exact reviewed cell-build preimage and adds only function settings: statement_timeout 240 seconds and lock_timeout one second. PostgREST hoists this bounded RPC setting before execution. The source body, quality gates, verified-source checks, immutable contract, owner, ACL, SECURITY DEFINER and search path remain byte-identical. The generic role budget remains eight seconds. Sealing and promotion are unchanged.

The existing PostgreSQL 17 certification harness snapshots the function, role settings, seal and promotion definitions, applies the migration, and asserts the exact settings-only change. Its unchanged fixtures then exercise actual cell construction, sealing and malformed-source/heldout refusals. Installation and actual corpus qualification remain separate; this execution-budget correction does not certify or activate data.
