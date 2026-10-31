# V31 seals validate the same locked model set once

The original corrected R7 seal exceeded its 240-second database budget after all 107 builds and 856 independent audits completed. A bounded read measured one cell validation at 3.549098 seconds, including repeated serialization of an 889178-byte model.

The migration emits identical bytes for the closed model shape using nested scalar aggregates, retaining the original generic canonical fallback. It removes a duplicate canonical traversal and per-node key-count queries without changing the float decoder, tree graph rules or accepted model structure. The payload checksum receives the same 32 fields and contract in one builder.

The existing dataset row lock and validated foreign key prevent new cells during sealing. Explicit row share locks preserve existing cells while the unchanged complete first validator runs. The later seal check reuses that public-model validation and retains key, payload-checksum and source-count checks; legacy and NULL paths are unchanged. Quality thresholds, timeouts, numerical implementation digests and all other seal code remain unchanged.

The existing required native PostgreSQL harness executes differential serialization/model/checksum checks, catalog/ACL preservation and concurrent insert/update/delete refusal. Controlled unrelated fixture dependencies are not mathematical qualification. Private final verification compares the actual frozen 107-model index without printing or committing its data. Production sealing, certification, promotion and live use remain separate acceptance gates.

The complete source-node validators now decode each vector once, preserve exact NUMERIC arithmetic and all 1326 blocker mappings, and share a service-only pure field validator. Each external V3/V4 node still receives its original checksum check. V4 no longer computes and compares two checksums for the same projection constructed inside that function. Existing owners, invoker settings and access remain unchanged. Native differential coverage includes vector/type/null boundaries, checksum failures and service versus browser permissions.

CI exposed two candidate defects: the live-proof annotation must precede the final COMMIT, and the closed-model canonical fast path must be attempted only on model-shaped root objects. Both are corrected without extending test or production timeouts. The source optimization has not yet established a complete production seal budget.

The combined baseline fixture now includes the two source validators. The lock regression extracts only the baseline seal function, matching its existing extraction of the candidate seal; its exact two-anchor comparison and every concurrent-writer assertion remain intact. The hosted pure/vector fixtures passed before this integration error, and the corrected native lock fixture passed locally.
