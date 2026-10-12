# V31 Feature Contract Is Immutable End To End

## Scope And Cause

Legacy `fn_gto_v31_hand_key` grouped two-hole rank/suit counts without distinguishing board-relative made hands. Retained real-source diagnostics proved that the disconnected V2 prototype improves representation but does not yet satisfy the unchanged heldout gates. This migration enables an explicit immutable model version; it does not certify that dataset or activate it.

## Owning Source Change

`20261007030040_the_solver_binds_immutable_feature_contracts.sql` adds nullable `feature_contract_version` to approved input bundles, datasets and compact cells. Omission preserves the old key, input checksum, cell checksum and dataset digest exactly. Explicit `rank-suit-count-v1` and `holdem-board-relative-v2` are distinct checksum-bound identities. Explicit request null, unknown versions and version mismatches are rejected. Version bindings cannot be updated in place.

The maintained board-relative SQL mirror remains separate from the legacy function. Approval, registration, worker-contract readback, compact-key generation, payload admission, both runtime-cell constraints, heldout calculations, dataset sealing/promotion, evaluation configs, both cell RPCs and durable agreement receipts use the same declared version. Existing 13-field coverage contexts and every quality/provenance/holdout assertion remain unchanged. The nullable RPC metadata field is appended; it must be stripped at the transport boundary when null, not turned into an explicitly null source-seal field.

Agreement `state.hand` retains independently derived ordinary two-hole notation; only `state.hand_key` is the versioned feature key. Evaluation configuration explicitly binds the version, while omitted legacy configs remain eight fields. Dataset digest adds `version + ':'` after `input_bundle_checksum + ':'` only for explicit versions.

## Directly Connected Performance Repair

The inherited heldout materialized CTE carried complete 1326-combo nodes and matrices into every combo/action observation. The isolated integration test exhausted SSD spill space. It now projects only per-combo frequencies, EV scalars and the needed action specifications. Weighting, counts, null/missing behavior, formulas and thresholds are identical. No input source is omitted and no quality assertion is relaxed.

## Regression And Delivery Boundary

The rollback qualification extractor now preserves bare comment lines as SQL blank lines. A regression independently compares its restored function body with the immutable predecessor. Forward recovery reinstalls only the two versioned UUID-owning function definitions before their existing correction; it does not replay retained column DDL or loosen either preimage assertion. The exact isolated PG17 run passes feature rollback and UUID rollback/forward recovery.

The existing PG17 qualification runner loads the exact new migration and focused feature-contract probe before the existing certified-source, agreement, liveness and authorization probes. The independent probe covers legacy identity, explicit-version separation, unknown/null rejection, street dispatch, matrix admission, admin approval idempotence, dataset/worker bindings and immutable version mutation refusal. The SQL/TS parity runner additionally checks the actual consumer validator on 88 valid and 15 malformed keys plus seven invalid decks and all 24 suit permutations.

The migration is Tier 3 because its two service-only RPC return contracts append metadata. Its transaction has short lock/statement timeouts and a contextual-compaction preimage guard. Rollback prerequisites and immutable historical function sources are documented in its header; rollback must preserve all versioned artifacts and cannot relabel rows. Source qualification is not production installation, protected publication, genuine solver quality certification or live consumer adoption. Root retains those operations.
