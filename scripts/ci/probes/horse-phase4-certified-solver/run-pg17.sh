#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$ROOT/scripts/ci/probes/horse-phase4-certified-solver"
if [[ -n "${PG17_BIN:-}" ]]; then
  PG_BIN=$PG17_BIN
elif [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
  PG_BIN=/opt/homebrew/opt/postgresql@17/bin
elif command -v postgres >/dev/null 2>&1 && postgres --version | grep -q ' 17\.'; then
  PG_BIN=$(dirname "$(command -v postgres)")
elif command -v docker >/dev/null 2>&1 && [[ "${PHASE4_PG17_IN_DOCKER:-0}" != "1" ]]; then
  exec docker run --rm --user postgres \
    -e USER=postgres \
    -e PG17_BIN=/usr/lib/postgresql/17/bin \
    -e PHASE4_PG17_IN_DOCKER=1 \
    -v "$ROOT:/workspace:ro" \
    -w /workspace \
    postgres:17 bash scripts/ci/probes/horse-phase4-certified-solver/run-pg17.sh
else
  echo 'PostgreSQL 17 or Docker is required (or set PG17_BIN to its bin directory).' >&2
  exit 1
fi
WORK=$(mktemp -d "${TMPDIR:-/tmp}/horse-phase4-pg.XXXXXX")
SOCKET="$WORK/socket"
DB=horse_phase4_probe
mkdir -p "$SOCKET"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$WORK/data" -A trust -U "$USER" >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $SOCKET -h '' -p 55439" -w start >/dev/null
export PGHOST="$SOCKET" PGPORT=55439 PGUSER="$USER"
"$PG_BIN/createdb" "$DB"
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -d "$DB")

"${PSQL[@]}" -f "$HERE/setup.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908181657_the_horse_reads_only_a_certified_solver_dataset.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908181714_the_solver_score_keeps_every_decision_receipt.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908181724_both_solver_hosts_and_the_compactor_leave_receipts.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908182030_the_certified_solver_foreign_keys_have_indexes.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908185700_certified_solver_receipts_match_pio_and_require_sizing_evidence.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908190825_gto_v31_holdout_boards_are_disjoint.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908193700_phase4_operator_reads_verify_the_direct_caller.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908201302_the_solver_raise_bucket_uses_the_raisers_call.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908201749_the_solver_holdout_must_change_board_ranks.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260908203000_certified_solver_identity_text_is_canonical.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909022146_certified_solver_evaluation_executes_sampled_action.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909024950_candidate_promotion_rechecks_execution_provenance.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909025949_solver_release_gate_is_serialized.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909063025_the_v31_input_bundle_can_bootstrap.sql"
# A deployment retry must preserve the same functions and validated constraint.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909063025_the_v31_input_bundle_can_bootstrap.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909071759_v31_input_identity_requires_json_strings.sql"
# Canonical-type hardening must also be replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909071759_v31_input_identity_requires_json_strings.sql"
"${PSQL[@]}" -f "$HERE/hand-key-migration-guard.sql"
GUARD_OUTPUT="$WORK/hand-key-migration-guard.out"
if "${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909165541_v31_hand_keys_bind_both_hole_card_suits.sql" \
    >"$GUARD_OUTPUT" 2>&1; then
  echo 'V31 hand-key migration accepted a pre-existing certified dataset.' >&2
  exit 1
fi
grep -q 'cannot change the V31 hand-key contract while certified datasets exist' "$GUARD_OUTPUT"
"${PSQL[@]}" -c 'TRUNCATE public.gto_v31_input_bundles CASCADE' >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909165541_v31_hand_keys_bind_both_hole_card_suits.sql"
# The two-hole-suit transition must remain replay-safe before a corpus exists.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909165541_v31_hand_keys_bind_both_hole_card_suits.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909170039_v31_hand_keys_reject_impossible_decks.sql"
# Impossible-deck rejection is also an idempotent contract hardening.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909170039_v31_hand_keys_reject_impossible_decks.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909170749_v31_hand_key_counts_match_street.sql"
# Street-bound key validation and its table constraint must remain replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909170749_v31_hand_key_counts_match_street.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909171644_v31_policy_json_is_canonical.sql"
# Canonical source and compact-policy JSON enforcement must remain replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909171644_v31_policy_json_is_canonical.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909172537_v31_dataset_and_source_integers_are_canonical.sql"
# Dataset declarations and source integer semantics must remain replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909172537_v31_dataset_and_source_integers_are_canonical.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909175000_v31_control_receipts_use_exact_json_types.sql"
# Signed control-plane receipts and source envelopes must remain replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909175000_v31_control_receipts_use_exact_json_types.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909180000_v31_agreement_receipts_bind_the_runtime_cell.sql"
# V31 decision receipts, database binding, and reference-specific audit logic are replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909180000_v31_agreement_receipts_bind_the_runtime_cell.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007014629_the_solver_compacts_only_its_matching_verified_source_nodes.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007034442_the_solver_validators_have_one_versioned_door.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007040648_solver_platform_ids_validate_uuid_shape.sql"
"${PSQL[@]}" -f "$HERE/platform-uuid-shape.sql"
# Build the exact old wrong-role source/cached-cell state before the forward
# correction. Only physical labels are restored to the prior buggy fixture;
# actual node chronology, vectors, source admission and cell construction run.
awk '
 /hero_position.*CASE WHEN \(i=1\)/ { print "      '\''hero_position'\'','\''SB'\'','\''opponent_position'\'','\''BB'\'','\''depth_bucket'\'',80,"; next }
 /opponent_position.*CASE WHEN \(i=1\)/ { next }
 /V31_PHYSICAL_PRIOR_FIXTURE_END/ { print "END\n$probe$;\nCOMMIT;"; exit }
 { print }
' "$HERE/certified-v31.sql" > "$WORK/prior-physical-fixture.sql"
"${PSQL[@]}" -f "$WORK/prior-physical-fixture.sql"
"${PSQL[@]}" -c "DO \$proof\$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.gto_v31_source_artifacts a JOIN public.solved_spots_gold s ON s.id=a.source_row_id WHERE s.strategy_matrix_v2#>>'{nodes,0,node_context,table_size}'='2' AND public.fn_gto_v31_source_node_valid(s.strategy_matrix_v2#>'{nodes,0}')) THEN RAISE EXCEPTION 'prior reversed HU admission was not reproduced'; END IF; END \$proof\$;"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007042245_solver_nodes_prove_physical_postflop_order.sql"
# Capture the genuine legacy checksum function before conditional V4 identity
# changes, so the metadata probe compares actual PostgreSQL JSON bytes.
"${PSQL[@]}" -Atc "SELECT replace(pg_get_functiondef('public.fn_gto_v31_input_bundle_checksum(jsonb)'::regprocedure),'public.fn_gto_v31_input_bundle_checksum','public.v31_metadata_legacy_checksum')" > "$WORK/legacy-metadata-checksum.sql"
"${PSQL[@]}" -f "$WORK/legacy-metadata-checksum.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007043848_v4_policy_schema_is_immutable_input_metadata.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007043945_solver_v4_nodes_prove_complete_public_state.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007051641_v4_consumers_bind_the_immutable_policy_schema.sql"
"${PSQL[@]}" -f "$HERE/policy-export-schema.sql"
# Execute the documented function-only rollback in this disposable database,
# then require the exact immutable preimages on forward recovery.
awk '/^-- node <<.ROLLBACK_JS./ {copy=1;next} /^-- ROLLBACK_JS$/ {copy=0} copy {sub(/^-- ?/, "");print}' \
 "$ROOT/supabase/migrations/20261007051641_v4_consumers_bind_the_immutable_policy_schema.sql" | \
 (cd "$ROOT" && node) > "$WORK/v4-consumer-rollback.sql"
"${PSQL[@]}" -f "$WORK/v4-consumer-rollback.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007051641_v4_consumers_bind_the_immutable_policy_schema.sql"
echo V31_V4_CONSUMER_ROLLBACK_RECOVERY_OK
"${PSQL[@]}" -f "$HERE/v4-version-boundary.sql"
"${PSQL[@]}" -f "$HERE/physical-position-transition.sql"
"${PSQL[@]}" -f "$HERE/v4-complete-state.sql"
awk '
 /PERFORM public.fn_gto_v31_ingest_source_artifact\(dataset,.*train_art\);/ && !called {
   print "    PERFORM public.v31_v4_probe(node,train_art,dataset);";called=1
 }
 {print}
' "$HERE/certified-v31.sql" > "$WORK/v4-admission-fixture.sql"
"${PSQL[@]}" -f "$WORK/v4-admission-fixture.sql"
"${PSQL[@]}" -c 'DROP FUNCTION public.v31_v4_probe(jsonb,jsonb,uuid)'
"${PSQL[@]}" -f "$HERE/input-bundle-bootstrap.sql"
"${PSQL[@]}" -f "$HERE/feature-contract-v2.sql"
"${PSQL[@]}" -f "$HERE/validator-one-door.sql"
"${PSQL[@]}" -f "$HERE/v4-consumer-boundary.sql"
awk '/eval_id:=public.fn_gto_v31_record_evaluation\(dataset,kind,family,result_id\);/ {print "      PERFORM public.v31_v4_consumer_probe(dataset,kind,family,result_id);"} {print}' \
 "$HERE/certified-v31.sql" > "$WORK/v4-consumer-fixture.sql"
"${PSQL[@]}" -f "$WORK/v4-consumer-fixture.sql"
"${PSQL[@]}" -c 'DROP FUNCTION public.v31_v4_consumer_probe(uuid,text,text,bigint)'
"${PSQL[@]}" -f "$HERE/solver-agreement.sql"
"${PSQL[@]}" -f "$HERE/pipeline-liveness.sql"
"${PSQL[@]}" -f "$HERE/operator-read-authorization.sql"
STATUS=$("${PSQL[@]}" -Atc "select ca_gto_v31_certification_status(null)->>'contract';")
[[ "$STATUS" == 'smarter-poker.gto-v31-certification-status.v1' ]]
INDEX_COUNT=$("${PSQL[@]}" -Atc "select count(*) from pg_indexes where schemaname='public' and indexname in ('gto_v31_datasets_input_bundle_id_idx','gto_v31_release_evaluations_source_result_id_idx');")
[[ "$INDEX_COUNT" == '2' ]]
echo PHASE4_STATUS_OK
awk '/^-- EXECUTABLE VALIDATOR ROLLBACK:/{copy=1;next} /^-- END EXECUTABLE VALIDATOR ROLLBACK/{copy=0} copy {sub(/^-- ?/, "");print}' \
 "$ROOT/supabase/migrations/20261007034442_the_solver_validators_have_one_versioned_door.sql" > "$WORK/validator-rollback.sql"
"${PSQL[@]}" -f "$WORK/validator-rollback.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007034442_the_solver_validators_have_one_versioned_door.sql"
"${PSQL[@]}" -f "$HERE/validator-one-door.sql"
echo V31_VALIDATOR_ROLLBACK_RECOVERY_OK
# Restore the newer validator migration first before rolling back its prerequisite.
"${PSQL[@]}" -f "$WORK/validator-rollback.sql"
# Qualify the copy/paste Tier-3 function-only rollback in this disposable database.
awk '/^-- EXECUTABLE ROLLBACK:/{copy=1;next} /^-- END EXECUTABLE ROLLBACK/{copy=0} copy && /^-- BEGIN;/{sql=1} copy && sql {sub(/^-- ?/, "");print}' \
  "$ROOT/supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql" > "$WORK/feature-rollback.sql"
"${PSQL[@]}" -f "$WORK/feature-rollback.sql"
ROLLBACK_HASH=$("${PSQL[@]}" -Atc "select md5(pg_get_functiondef('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure));")
[[ "$ROLLBACK_HASH" == 'fc7eb5e3be9a52b6dc83db65900edc50' ]] || { echo "V31 feature rollback build postimage mismatch: $ROLLBACK_HASH" >&2; exit 1; }
LEGACY_VALID=$("${PSQL[@]}" -Atc "select public.fn_gto_v31_hand_matrix_valid('{\"AKo:21\":{\"check\":1}}'::jsonb,'flop');")
[[ "$LEGACY_VALID" == 't' ]] || { echo "V31 feature rollback legacy matrix rejected: $LEGACY_VALID" >&2; exit 1; }
# A compact policy requires at least two legal actions, even after legacy rollback.
LEGACY_COMPACT_VALID=$("${PSQL[@]}" -Atc "select public.fn_gto_v31_compact_matrices_valid('{\"AKo:21\":{\"c\":1,\"b50\":0}}'::jsonb,'{\"c\":{\"family\":\"check\",\"size_unit\":\"none\",\"size_value\":null,\"all_in\":false},\"b50\":{\"family\":\"bet\",\"size_unit\":\"pot_fraction\",\"size_value\":0.5,\"all_in\":false}}'::jsonb,'{\"AKo:21\":1}'::jsonb,'{\"AKo:21\":{\"c\":1,\"b50\":2}}'::jsonb,'flop');")
[[ "$LEGACY_COMPACT_VALID" == 't' ]] || { echo "V31 feature rollback legacy compact matrix rejected: $LEGACY_COMPACT_VALID" >&2; exit 1; }
LEGACY_SINGLE_ACTION_VALID=$("${PSQL[@]}" -Atc "select public.fn_gto_v31_compact_matrices_valid('{\"AKo:21\":{\"c\":1}}'::jsonb,'{\"c\":{\"family\":\"check\",\"size_unit\":\"none\",\"size_value\":null,\"all_in\":false}}'::jsonb,'{\"AKo:21\":1}'::jsonb,'{\"AKo:21\":{\"c\":1}}'::jsonb,'flop');")
[[ "$LEGACY_SINGLE_ACTION_VALID" == 'f' ]] || { echo "V31 feature rollback accepted single-action compact policy: $LEGACY_SINGLE_ACTION_VALID" >&2; exit 1; }
echo V31_FEATURE_ROLLBACK_OK
# The exact blank-line-preserving rollback restores canonical legacy bodies.
# Recover the two versioned UUID-owning functions before their correction: the immutable
# correction's legacy pins describe the earlier comment-preserving extraction,
# not these canonical rollback bytes. No preimage assertion is relaxed.
awk '
 /^CREATE OR REPLACE FUNCTION public.fn_gto_v31_register_dataset\(/ ||
 /^CREATE OR REPLACE FUNCTION public.fn_horse_solver_agreement_v31_decision\(/ {copy=1;count++}
 copy {print}
 copy && /^\$fn\$;$/ {copy=0}
 END {if(count!=2 || copy) exit 1}
' "$ROOT/supabase/migrations/20261007030040_the_solver_binds_immutable_feature_contracts.sql" > "$WORK/uuid-function-forward.sql"
"${PSQL[@]}" -f "$WORK/uuid-function-forward.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261007040648_solver_platform_ids_validate_uuid_shape.sql"
"${PSQL[@]}" -f "$HERE/platform-uuid-shape.sql"
"${PSQL[@]}" -f "$HERE/certified-v31.sql"
echo V31_UUID_ROLLBACK_FORWARD_RECOVERY_OK
