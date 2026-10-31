# V31 seals validate the same locked model set once

The original corrected R7 seal exceeded its 240-second database budget after all 107 builds and 856 independent audits completed. A bounded read measured one cell validation at 3.549098 seconds, including repeated serialization of an 889178-byte model.

The migration emits identical bytes for the closed model shape using nested scalar aggregates, retaining the original generic canonical fallback. It removes a duplicate canonical traversal and per-node key-count queries without changing the float decoder, tree graph rules or accepted model structure. The payload checksum receives the same 32 fields and contract in one builder.

The existing dataset row lock and validated foreign key prevent new cells during sealing. Explicit row share locks preserve existing cells while the unchanged complete first validator runs. The later seal check reuses that public-model validation and retains key, payload-checksum and source-count checks; legacy and NULL paths are unchanged. Quality thresholds, timeouts, numerical implementation digests and all other seal code remain unchanged.

The existing required native PostgreSQL harness executes differential serialization/model/checksum checks, catalog/ACL preservation and concurrent insert/update/delete refusal. Controlled unrelated fixture dependencies are not mathematical qualification. Private final verification compares the actual frozen 107-model index without printing or committing its data. Production sealing, certification, promotion and live use remain separate acceptance gates.
