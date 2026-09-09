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
else
  echo 'PostgreSQL 17 is required (set PG17_BIN to its bin directory).' >&2
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
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909070217_v31_input_identity_requires_json_strings.sql"
# Canonical-type hardening must also be replay-safe.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20260909070217_v31_input_identity_requires_json_strings.sql"
"${PSQL[@]}" -f "$HERE/input-bundle-bootstrap.sql"
"${PSQL[@]}" -f "$HERE/certified-v31.sql"
"${PSQL[@]}" -f "$HERE/solver-agreement.sql"
"${PSQL[@]}" -f "$HERE/pipeline-liveness.sql"
"${PSQL[@]}" -f "$HERE/operator-read-authorization.sql"
STATUS=$("${PSQL[@]}" -Atc "select ca_gto_v31_certification_status(null)->>'contract';")
[[ "$STATUS" == 'smarter-poker.gto-v31-certification-status.v1' ]]
INDEX_COUNT=$("${PSQL[@]}" -Atc "select count(*) from pg_indexes where schemaname='public' and indexname in ('gto_v31_datasets_input_bundle_id_idx','gto_v31_release_evaluations_source_result_id_idx');")
[[ "$INDEX_COUNT" == '2' ]]
echo PHASE4_STATUS_OK
