#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migration_dir="$repo_dir/supabase/migrations"
archive_dir="$repo_dir/supabase/retired-unapplied"
manifest="$archive_dir/MANIFEST.sha256"
resolver="$repo_dir/scripts/ops/lib/resolve-staged-or-promoted-migration.sh"
diamond_fixture="$repo_dir/scripts/dev/fixtures/stage-b-diamond-accepted-hand-current-schema.sql"
bounty_rebuy_fixture="$repo_dir/scripts/ci/probes/atomic-terminal-rehearsal-fixture.sql"
bounty_rebuy_probe="$repo_dir/scripts/ci/probes/bounty-rebuy-generation-atomicity.sql"
cancellation_probe="$repo_dir/scripts/ci/probes/tournament-cancellation-entrant-refunds.sql"
cash_unregistration_probe="$repo_dir/scripts/ci/probes/tournament-unregistration-cross-club.sql"
satellite_ticket_return_probe="$repo_dir/scripts/ci/probes/atomic-satellite-ticket-return.sql"
actual_start_unregistration_probe="$repo_dir/scripts/ci/probes/seat-first-unregistration-actual-start.sql"
elimination_seat_exit_probe="$repo_dir/scripts/ci/probes/tournament-elimination-seat-exit-authority.sql"
seat_move_hotfix_statement_sha256='b3f1bb62152627444b33c82b806c00ba3587aeebbe3d13800faf69fae7809ea2'
manager_request_authority_statement_sha256='2cbcab5f263e8ca02b16f6c47ebbd7f6d47eb783d81c5939133c1e39b5d306f4'
busy_manager_statement_sha256='2e95299dd7693a09ee310a4086b2dcdf16f0f942582007bdede0c4c81024e07d'
hand_heartbeat_statement_sha256='5816d16550ef470f9359cae427aec0c5346df92f5c6d35b07385def4ab9b4c04'
bounty_evidence_statement_sha256='2fdcbc3c1ccda299b53fea97a6fe9ace267919d3e3f1d9c60ae796726812c47b'
cash_entry_ladder_statement_sha256='826248f9d290154781197628d41dd9b3b09bdf0daa2f7f65c47d166c275c7ab0'
cron_control_sha256='19e650bc51d7534f5c9446e4f63ecaa99e43316fba202d21de9c7be6f37ca6b6'
money_control_sha256='32b913b609d9e73469b78bb457845b26785c6c33edcb69131791f83bf0ac0558'
maintenance_fault_catalog_sha256='085fe4bf17888519604ad3fea787339a9e178c3a1af9ea0aa4d5449512ba8d6d'
absent_functions_sha256='fd5d11d378f3e694d92926fa53deda82c719485be6f226f7ba2e2b036ead09de'
maintenance_proconfigs_sha256='3fb43fba91d2d923e68f0b08b0274320066048449657a3981b69baf270bb2025'
elimination_guard_sha256='f818fd0881db431fe5d1323fbf50efbb64c175ff10a7165b8cb5f6791310942e'
final_deal_v2_statement_sha256='b4af55173b825be5ecf48c6c3bbcca1e828493cdafc47becf00d73ad3186c871'
wheel_welcome_statement_sha256='4778ce9d373a98e8b10cb31e496bf18e4e527c0a158f37a4e4fcf500b3c9b995'
bounty_rebuy_statement_sha256='4f9616b84906a7479c60dd0a266c2c2d1bb056828aa53ef45095ea31d058c5e2'
welcome_spin_answer_statement_sha256='3d6efc9bc8f00e5e9840ed09d806ea9fa3d8513117a8acb8f7580d56443f4cc1'
cancellation_origin_statement_sha256='84f2d79130e27bd687c848a45bb65bf5b63ac2ebf0d4e9bf360dc1ec19cd284a'
operator_visibility_statement_sha256='3f01c9da1e26451d8d8a938e1b942f70f2bdcff4db7a96e452210c5632d07648'
player_day_exit_statement_sha256='9a5109e118fd3877b816126652b3e5ac0f8b54780d2dc6b37be33e61cd4b0bc6'
retired_mint_reporting_statement_sha256='a12119f40903928cf8febcca78f10b34a5b44cd8be6a996ccc68dd9c0dc69ecc'
legacy_rakeback_single_payer_statement_sha256='a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7'
legacy_round3_acl_statement_sha256='da06b3acca81a28a54e1354932aab87d515bc3202b4922e9cccc8e1971e867d5'
seat_exit_consumer_guard_statement_sha256='a1a762df5c6e9e62b63d1602a360a7349c087d652c00e22c63dac481a953a623'
late_entry_ledger_statement_sha256='a4e7bf3d2f352c8d12030ea83fd3697054ac3045e4276293362b6d72e2040ed4'
prize_reprice_statement_sha256='e528b35403f6e439287b14c54b0c7308b186d0455bf9a1198b661d26e97e2d8a'
bounty_rebuy_probe_sha256='ef8e7fe7c0705ad265dab8f416485302b379437ab94f055f08c98e5cff3a6a5e'
cancellation_probe_sha256='485d48aad7147ab9b54d8c0f3118a6d928948468aade3da2361452f9ccedfce5'
cash_unregistration_probe_sha256='a21100a43e73cbf0398e980475bd2a6d602d8245cad821204206de13576383c1'
satellite_ticket_return_probe_sha256='ed7f2d925a2971a89bb4e88efd5250ccfc2b3b813bd8adb6dca9c3f182e1b1ad'
actual_start_unregistration_probe_sha256='f9025d6c48ae00e88bca43a41f854b5766d25f596150379d445a532722ab4507'
elimination_seat_exit_probe_sha256='94ef8f10cdcb6ea084bcdfb4f8d5ff63db9c0271485e02f7a38ffc3d3ce5fd8f'

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/dev/probe-stage-b-forward-chain-pg17.sh [MODE]

MODE is one of:
  --resolve-only          resolve sources and verify their logical order
  --keyshare-replay       apply #1-#6, then prove #6 is an exact no-op replay
  --keyshare-mixed-state  apply #1-#5, inject one ownership key, and prove #6
                          refuses and rolls back the mixed preimage

Without MODE, this proves the terminal repair and late-failure rollback, applies
#1-#5 once with the Diamond/accepted-hand fixture, then clones that
postimage for #6 replay and authenticated unknown-preimage rollback. Database
modes clone but never mutate one local PostgreSQL 17 production-schema donor
containing no player, game, or financial rows. Set:
  STAGE_B_FORWARD_REHEARSAL_ACK=DISPOSABLE_LOCAL_PG17_CLONE
  STAGE_B_FORWARD_REHEARSAL_DATABASE=<exact current_database() name>
and connect with normal libpq variables or PGSERVICE. DATABASE_URL is rejected.
USAGE
  exit 64
}

probe_mode='apply'
case "${1:-}" in
  '') ;;
  --resolve-only) probe_mode='resolve' ;;
  --keyshare-replay) probe_mode='replay' ;;
  --keyshare-mixed-state) probe_mode='mixed' ;;
  *) usage ;;
esac
[[ "$#" -le 1 ]] || usage

[[ -r "$resolver" ]] || {
  echo 'The staged-or-promoted migration resolver is unreadable.' >&2
  exit 66
}
# shellcheck source=../ops/lib/resolve-staged-or-promoted-migration.sh
# shellcheck disable=SC1091
source "$resolver"

chain_names=(
  stage_b_forward_authority_expansion
  stage_b_exact_precondition_repairs
  stage_b_terminal_break_invariant
  stage_b_atomic_finish_precertification
  stage_b_current_postimage_contraction
  stage_b_lease_keyshare_once
)
chain_logical_ids=(
  20260910042007
  20260910042020
  20260910042033
  20260910042058
  20260910042112
  20260910042137
)
if [[ "${#chain_names[@]}" -ne "${#chain_logical_ids[@]}" ]]; then
  echo 'Stage-B semantic suffixes and logical identities are not one-to-one.' >&2
  exit 65
fi
chain_files=()
for ((index = 0; index < ${#chain_names[@]}; index += 1)); do
  migration_name="${chain_names[$index]}"
  migration_file="$(resolve_staged_or_promoted_migration "$migration_dir" "$migration_name")"
  migration_basename="$(basename "$migration_file")"
  logical_identity="${chain_logical_ids[$index]}_${migration_name}"

  if [[ ! "$migration_basename" =~ ^[0-9]{14}_${migration_name}\.sql(\.pending)?$ ]]; then
    echo "Stage-B source does not have the expected semantic suffix: ${migration_basename}." >&2
    exit 65
  fi
  if ! grep -Eq "^-- ${logical_identity}(\\.sql)?$" "$migration_file"; then
    echo "Stage-B source does not declare logical identity ${logical_identity}: ${migration_basename}." >&2
    exit 65
  fi
  if [[ "$index" -gt 0 \
     && ! "${chain_logical_ids[$((index - 1))]}" < "${chain_logical_ids[$index]}" ]]; then
    echo "Stage-B logical identities are not strictly ordered at ${logical_identity}." >&2
    exit 65
  fi
  chain_files+=("$migration_file")
done

# These four migrations already exist in production but were applied after the
# bounded donor snapshot. Compose them in their observed apply order on the one
# disposable normalized clone; they are not part of the six-file Stage-B chain.
current_live_tail_versions=(
  20260911062048
  20260911094503
  20260911110907
  20260911112409
)
current_live_tail_names=(
  a_bust_is_ranked_by_when_it_happened
  a_bust_belongs_to_the_phase_its_hand_was_played_in
  a_satellite_never_feeds_a_target_its_finish_refuses
  persist_eligible_free_buy_creation_options
)
current_live_tail_bytes=(150688 17270 7971 3281)
current_live_tail_sha256=(
  d2d0acba73031ed8617a243840eecea0e0e227a6dce5a78ce3ce2bfcfb79cf73
  0d620bf6061213e0ef0362126fde1e3e2feddc7b13720fa74727ad80da5fd570
  fcbbe600573494b1402cb2c10d8179534d1845ace630a921e25c5df68f589b33
  e16b3a057460833cd74c7a2da612df8b2c5269e156a7cc7b8116679d7fb6b24a
)
current_live_tail_files=()
if [[ "${#current_live_tail_versions[@]}" -ne 4 \
   || "${#current_live_tail_names[@]}" -ne 4 \
   || "${#current_live_tail_bytes[@]}" -ne 4 \
   || "${#current_live_tail_sha256[@]}" -ne 4 ]]; then
  echo 'Current live-tail rehearsal descriptors are not one-to-one.' >&2
  exit 65
fi
for ((index = 0; index < ${#current_live_tail_versions[@]}; index += 1)); do
  current_tail_file="$migration_dir/${current_live_tail_versions[$index]}_${current_live_tail_names[$index]}.sql"
  if [[ ! -f "$current_tail_file" || -L "$current_tail_file" \
     || "$(basename "$current_tail_file")" \
        != "${current_live_tail_versions[$index]}_${current_live_tail_names[$index]}.sql" ]]; then
    echo "Current live-tail source is missing, not regular, or symlinked: ${current_tail_file}." >&2
    exit 66
  fi
  if [[ "$(wc -c < "$current_tail_file" | tr -d '[:space:]')" \
        != "${current_live_tail_bytes[$index]}" \
     || "$(shasum -a 256 "$current_tail_file" | awk '{print $1}')" \
        != "${current_live_tail_sha256[$index]}" ]]; then
    echo "Current live-tail source bytes are not canonical: ${current_tail_file}." >&2
    exit 65
  fi
  current_live_tail_files+=("$current_tail_file")
done
[[ -r "$diamond_fixture" ]] || {
  echo "The current-schema Diamond accepted-hand fixture is unreadable: ${diamond_fixture}." >&2
  exit 66
}
[[ -r "$bounty_rebuy_fixture" && -r "$bounty_rebuy_probe" ]] || {
  echo 'The exact-generation bounty-rebuy fixture or probe is unreadable.' >&2
  exit 66
}
if [[ "$(wc -c < "$bounty_rebuy_probe" | tr -d '[:space:]')" != '42772' \
   || "$(shasum -a 256 "$bounty_rebuy_probe" | awk '{print $1}')" \
      != "$bounty_rebuy_probe_sha256" ]]; then
  echo 'The exact-generation bounty-rebuy probe bytes are not canonical.' >&2
  exit 65
fi
[[ -r "$cancellation_probe" ]] || {
  echo 'The exact-origin tournament cancellation probe is unreadable.' >&2
  exit 66
}
if [[ "$(wc -c < "$cancellation_probe" | tr -d '[:space:]')" != '29164' \
   || "$(shasum -a 256 "$cancellation_probe" | awk '{print $1}')" \
      != "$cancellation_probe_sha256" ]]; then
  echo 'The exact-origin tournament cancellation probe bytes are not canonical.' >&2
  exit 65
fi
for probe_spec in \
  "$cash_unregistration_probe|14986|$cash_unregistration_probe_sha256" \
  "$satellite_ticket_return_probe|35058|$satellite_ticket_return_probe_sha256" \
  "$actual_start_unregistration_probe|21504|$actual_start_unregistration_probe_sha256" \
  "$elimination_seat_exit_probe|28071|$elimination_seat_exit_probe_sha256"
do
  IFS='|' read -r probe_file probe_bytes probe_sha256 <<<"$probe_spec"
  [[ -r "$probe_file" ]] || {
    echo "The post-six unregistration probe is unreadable: ${probe_file}." >&2
    exit 66
  }
  if [[ "$(wc -c < "$probe_file" | tr -d '[:space:]')" != "$probe_bytes" \
     || "$(shasum -a 256 "$probe_file" | awk '{print $1}')" != "$probe_sha256" ]]; then
    echo "The post-six unregistration probe bytes are not canonical: ${probe_file}." >&2
    exit 65
  fi
done

[[ -r "$manifest" ]] || {
  echo 'The retired Stage-B SHA-256 manifest is unreadable.' >&2
  exit 66
}
(
  cd "$archive_dir"
  shasum -a 256 -c "$(basename "$manifest")" >/dev/null
)

retired_count=0
while IFS= read -r manifest_row; do
  [[ "$manifest_row" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]([^/]+\.sql)$ ]] || continue
  retired_file="${BASH_REMATCH[1]}"
  retired_count=$((retired_count + 1))
  if [[ -e "$migration_dir/$retired_file" ]]; then
    echo "Retired Stage-B migration is active again: ${retired_file}." >&2
    exit 65
  fi
done < "$manifest"
if [[ "$retired_count" -ne 13 ]]; then
  echo "Expected thirteen retired Stage-B migrations; found ${retired_count}." >&2
  exit 65
fi

for ((index = 0; index < ${#chain_files[@]}; index += 1)); do
  printf '%d %s\n' "$((index + 1))" "${chain_files[$index]}"
done
if [[ "$probe_mode" == 'resolve' ]]; then
  echo 'STAGE_B_FORWARD_CHAIN_RESOLVED'
  exit 0
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo 'DATABASE_URL is not accepted; use PGSERVICE or ordinary libpq variables.' >&2
  exit 64
fi
if [[ "${STAGE_B_FORWARD_REHEARSAL_ACK:-}" != 'DISPOSABLE_LOCAL_PG17_CLONE' ]]; then
  echo 'Refusing to mutate a database without the disposable-local-clone acknowledgement.' >&2
  exit 64
fi
expected_database="${STAGE_B_FORWARD_REHEARSAL_DATABASE:-}"
if [[ -z "$expected_database" ]]; then
  echo 'STAGE_B_FORWARD_REHEARSAL_DATABASE must name the exact disposable database.' >&2
  exit 64
fi

pg17_bin="${PG17_BINDIR:-}"
if [[ -z "$pg17_bin" ]] && command -v brew >/dev/null 2>&1; then
  pg17_bin="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
if [[ ! -x "${pg17_bin}/psql" ]] \
   || [[ ! -x "${pg17_bin}/createdb" ]] \
   || [[ ! -x "${pg17_bin}/dropdb" ]] \
   || ! "${pg17_bin}/psql" --version | grep -Eq ' 17\.'; then
  echo 'PostgreSQL 17 psql, createdb and dropdb are required. Set PG17_BINDIR to its bin directory.' >&2
  exit 2
fi
psql_cmd=(
  "${pg17_bin}/psql" -X -v ON_ERROR_STOP=1
  --dbname="$expected_database"
  -v "seat_move_hotfix_statement_sha256=$seat_move_hotfix_statement_sha256"
  -v "manager_request_authority_statement_sha256=$manager_request_authority_statement_sha256"
  -v "busy_manager_statement_sha256=$busy_manager_statement_sha256"
  -v "hand_heartbeat_statement_sha256=$hand_heartbeat_statement_sha256"
  -v "bounty_evidence_statement_sha256=$bounty_evidence_statement_sha256"
  -v "cash_entry_ladder_statement_sha256=$cash_entry_ladder_statement_sha256"
  -v "cron_control_sha256=$cron_control_sha256"
  -v "money_control_sha256=$money_control_sha256"
  -v "maintenance_fault_catalog_sha256=$maintenance_fault_catalog_sha256"
  -v "absent_functions_sha256=$absent_functions_sha256"
  -v "maintenance_proconfigs_sha256=$maintenance_proconfigs_sha256"
  -v "elimination_guard_sha256=$elimination_guard_sha256"
  -v "final_deal_v2_statement_sha256=$final_deal_v2_statement_sha256"
  -v "wheel_welcome_statement_sha256=$wheel_welcome_statement_sha256"
  -v "bounty_rebuy_statement_sha256=$bounty_rebuy_statement_sha256"
  -v "welcome_spin_answer_statement_sha256=$welcome_spin_answer_statement_sha256"
  -v "cancellation_origin_statement_sha256=$cancellation_origin_statement_sha256"
  -v "operator_visibility_statement_sha256=$operator_visibility_statement_sha256"
  -v "player_day_exit_statement_sha256=$player_day_exit_statement_sha256"
  -v "retired_mint_reporting_statement_sha256=$retired_mint_reporting_statement_sha256"
  -v "legacy_rakeback_single_payer_statement_sha256=$legacy_rakeback_single_payer_statement_sha256"
  -v "legacy_round3_acl_statement_sha256=$legacy_round3_acl_statement_sha256"
  -v "seat_exit_consumer_guard_statement_sha256=$seat_exit_consumer_guard_statement_sha256"
  -v "late_entry_ledger_statement_sha256=$late_entry_ledger_statement_sha256"
  -v "prize_reprice_statement_sha256=$prize_reprice_statement_sha256"
)

emit_zero_player_data_assertion_function() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.assert_zero_player_data_baseline()
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','pg_temp'
AS $assert_zero_player_data_baseline$
DECLARE
  v_relation_name text;
  v_relation regclass;
  v_rows bigint;
  v_total bigint:=0;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'auth.users','public.profiles','public.clubs','public.club_members',
    'public.tables','public.table_seats','public.tournaments',
    'public.tournament_players','public.tournament_tickets','public.club_wallets',
    'public.club_wallet_transactions','public.chip_ledger',
    'public.poker_diamond_custody',
    'public.poker_diamond_movements','public.poker_diamond_hand_receipts',
    'public.seat_cashout_receipts','public.tournament_deal_proposals',
    'public.tournament_deal_proposal_consents',
    'public.tournament_deal_proposal_executions',
    'public.tournament_deal_reviews'
  ]::text[] LOOP
    v_relation:=to_regclass(v_relation_name);
    IF v_relation IS NULL THEN
      RAISE EXCEPTION 'STAGE_B_REQUIRED_ZERO_DATA_RELATION_MISSING: %',
        v_relation_name USING ERRCODE='55000';
    END IF;
    EXECUTE format('SELECT count(*) FROM %s',v_relation) INTO STRICT v_rows;
    v_total:=v_total+v_rows;
  END LOOP;

  IF to_regclass('public.poker_diamond_obligations') IS NOT NULL THEN
    RAISE EXCEPTION
      'STAGE_B_RETIRED_RELATION_PRESENT: public.poker_diamond_obligations'
      USING ERRCODE='55000';
  END IF;
  RETURN v_total;
END;
$assert_zero_player_data_baseline$;
SQL
}

emit_break_fault_catalog_functions() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.stage_b_132747_break_fault_catalog_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $break_fault_catalog_fingerprint$
SELECT jsonb_build_object(
         'identity','public.engine_maintenance_break_faults',
         'present',c.oid IS NOT NULL,
         'owner',pg_get_userbyid(c.relowner),
         'kind',c.relkind,
         'persistence',c.relpersistence,
         'rls',c.relrowsecurity,
         'force_rls',c.relforcerowsecurity,
         'acl',c.relacl,
         'comment',obj_description(c.oid,'pg_class'),
         'columns',COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'attnum',a.attnum,'name',a.attname,
                    'type',format_type(a.atttypid,a.atttypmod),
                    'notnull',a.attnotnull,'identity',a.attidentity,
                    'generated',a.attgenerated,
                    'default',pg_get_expr(d.adbin,d.adrelid),
                    'collation',CASE WHEN a.attcollation=0 THEN NULL
                                     ELSE a.attcollation::regcollation::text END,
                    'comment',col_description(a.attrelid,a.attnum))
                  ORDER BY a.attnum)
             FROM pg_attribute a
             LEFT JOIN pg_attrdef d
               ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
         ),'[]'::jsonb),
         'constraints',COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'name',con.conname,'type',con.contype,
                    'deferrable',con.condeferrable,
                    'deferred',con.condeferred,
                    'validated',con.convalidated,
                    'definition',pg_get_constraintdef(con.oid,true),
                    'comment',obj_description(con.oid,'pg_constraint'))
                  ORDER BY con.conname COLLATE "C")
             FROM pg_constraint con WHERE con.conrelid=c.oid
         ),'[]'::jsonb),
         'indexes',COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'name',idx.relname,'owner',pg_get_userbyid(idx.relowner),
                    'acl',idx.relacl,'valid',ind.indisvalid,
                    'ready',ind.indisready,'live',ind.indislive,
                    'primary',ind.indisprimary,'unique',ind.indisunique,
                    'definition',pg_get_indexdef(idx.oid),
                    'comment',obj_description(idx.oid,'pg_class'))
                  ORDER BY idx.relname COLLATE "C")
             FROM pg_index ind
             JOIN pg_class idx ON idx.oid=ind.indexrelid
            WHERE ind.indrelid=c.oid
         ),'[]'::jsonb))::text
  FROM pg_class c
 WHERE c.oid=to_regclass('public.engine_maintenance_break_faults');
$break_fault_catalog_fingerprint$;

CREATE OR REPLACE FUNCTION pg_temp.assert_stage_b_132747_break_fault_catalog(
  p_expected_sha256 text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $assert_break_fault_catalog$
DECLARE
  v_fingerprint text:=pg_temp.stage_b_132747_break_fault_catalog_fingerprint();
BEGIN
  IF v_fingerprint IS NULL
     OR octet_length(v_fingerprint)<>3421
     OR encode(sha256(convert_to(v_fingerprint,'UTF8')),'hex')<>
          p_expected_sha256 THEN
    RAISE EXCEPTION 'STAGE_B_132747_BREAK_FAULT_CATALOG_CHANGED'
      USING ERRCODE='55000';
  END IF;
  RETURN 'STAGE_B_132747_BREAK_FAULT_CATALOG_OK';
END;
$assert_break_fault_catalog$;
SQL
}

preflight="$({
  {
    emit_zero_player_data_assertion_function
    emit_break_fault_catalog_functions
    cat <<'SQL'
WITH required_prerequisites(version,name) AS (
  VALUES
    ('20260910034411','seat_proof_lock_generic_plan_lobby_policy_hashed_and_tick_in'),
    ('20260910034412','spin_draw_gate_reads_zero_as_undrawn_and_stamps_the_row'),
    ('20260910035435','the_settlement_lane_is_per_tournament_not_platform_wide'),
    ('20260910051447','the_seat_move_door_the_engine_calls_exists'),
    ('20260910052523','hand_projection_outbox_notifies_its_listener'),
    ('20260910054638','tables_policy_hashed_auth_admin_trusted_and_unfilled_spins_e'),
    ('20260910054712','a_hand_settles_each_seat_once'),
    ('20260910055857','tournament_bounty_per_pot_evidence'),
    ('20260910060034','cash_entry_close_proves_the_reserved_unpaid_ladder'),
    ('20260910062308','server_financial_alerts_accept_an_entity_id'),
    ('20260910063559','a_busy_manager_keeps_its_lease'),
    ('20260910064305','a_union_ticket_is_issued_at_the_club_the_winner_plays_from'),
    ('20260910064701','a_hand_commit_does_not_hold_the_lease_against_its_own_heartb'),
    ('20260910070417','a_ticket_entry_is_an_entry'),
    ('20260910071131','cash_entry_reprice_service_only_access'),
    ('20260910072322','the_knockout_door_owns_every_bust_a_hand_took'),
    ('20260910072351','an_elimination_without_a_place_cannot_be_written'),
    ('20260910073355','the_retired_sweeps_keep_their_disabled_schedule_rows'),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes'),
    ('20260910074504','a_manager_sweeps_itself_once_when_it_adopts_the_event'),
    ('20260910075958','a_deferred_check_reads_the_row_at_commit_not_the_statement'),
    ('20260910080137','the_outbox_leaves_the_realtime_publication'),
    ('20260910080242','the_guard_that_stopped_five_satellites_is_answered_for'),
    ('20260910080728','three_money_doors_are_audited_and_registered'),
    ('20260910124023','a_player_id_is_a_uuid_not_a_uuid_version'),
    ('20260910124524','a_bust_the_player_came_back_from_is_a_rebought_bust'),
    ('20260910130319','restore_rake_attribution_retries'),
    ('20260910130421','a_revealed_mystery_bounty_may_name_its_own_obligation'),
    ('20260910132341','two_nets_that_are_reporting_history_are_answered'),
    ('20260910132644','the_supply_meter_swing_did_not_repeat_and_the_ledger_balances'),
    ('20260910132747','the_break_scorecard_names_why_a_break_never_started'),
    ('20260910132833','a_maintenance_kind_registered_as_info_is_recorded_not_raised'),
    ('20260910134429','every_seat_means_every_seat'),
    ('20260910140538','a_detector_does_not_report_what_it_already_answered_for'),
    ('20260910141101','booked_spin_continuation_preserves_floating_point_rounding'),
    ('20260910143032','a_declared_guard_change_is_recorded_not_raised'),
    ('20260910143719','the_guard_declaration_is_not_reachable_from_a_browser'),
    ('20260910145833','a_place_is_not_a_bounty'),
    ('20260910151228','the_door_was_fixed_after_the_manager_stopped_asking'),
    ('20260910154446','the_database_refuses_migrations_inside_the_break_window'),
    ('20260910154537','the_busts_the_door_can_now_accept_are_recorded'),
    ('20260910154858','every_player_who_busted_has_a_place'),
    ('20260910160413','a_finished_event_holds_no_pending_bust'),
    ('20260910160841','the_break_window_refusal_names_its_rule_and_explains_list_migrations'),
    ('20260910164655','stage_b_break_window_bootstrap_compatibility'),
    ('20260910170356','a_handoff_that_names_its_successor_is_not_an_incident'),
    ('20260910171843','started_tournaments_resume_or_settle_instead_of_cancelling'),
    ('20260910171857','a_refused_finishing_place_creates_no_debt'),
    ('20260910171911','a_tournament_elimination_requires_a_finishing_rank'),
    ('20260910171924','satellite_seats_count_once_and_keep_the_funded_prize'),
    ('20260910173147','the_settlement_lane_is_per_tournament_for_rolling_authorities'),
    ('20260910174349','the_bounty_sweep_takes_one_tournament_lane_per_call'),
    ('20260910181549','active_means_who_is_on_the_floor_cash_and_events_counted_apa'),
    ('20260910190537','late_entry_uses_canonical_capacity_and_charged_wallet_receip'),
    ('20260911050554','final_deal_receipts_survive_real_terminal_settlement'),
    ('20260911052216','the_daily_free_spin_leaves_the_building'),
    ('20260911052648','bounty_rebuy_settles_its_exact_prior_entry_generation'),
    ('20260911061449','the_welcome_spin_answers_the_same_everywhere'),
    ('20260911061723','cancel_unstarted_entries_to_their_exact_funded_origin_wallet'),
    ('20260911062053','the_operator_sees_the_money_and_the_room'),
    ('20260911064427','the_player_can_see_the_day_and_the_way_out'),
    ('20260911072424','the_mint_that_is_gone_stops_being_reported'),
    ('20260911072837','legacy_rakeback_closed_period_single_payer'),
    ('20260911081721','legacy_round3_preserve_server_only_acl'),
    ('20260911081910','a_seat_exit_guard_without_its_consumer_refuses_nothing'),
    ('20260911090347','the_prize_reprice_door_the_engine_calls_exists')
), exact_body_rows(version,name,statement_sha256) AS (
  VALUES
    ('20260910051447','the_seat_move_door_the_engine_calls_exists',
     :'seat_move_hotfix_statement_sha256'),
    ('20260910063559','a_busy_manager_keeps_its_lease',
     :'busy_manager_statement_sha256'),
    ('20260910064701','a_hand_commit_does_not_hold_the_lease_against_its_own_heartb',
     :'hand_heartbeat_statement_sha256')
), descriptor_rows(version,name,statement_bytes,statement_sha256) AS (
  VALUES
    ('20260910055857','tournament_bounty_per_pot_evidence',7533,
     :'bounty_evidence_statement_sha256'),
    ('20260910060034','cash_entry_close_proves_the_reserved_unpaid_ladder',7344,
     :'cash_entry_ladder_statement_sha256'),
    ('20260910190537','late_entry_uses_canonical_capacity_and_charged_wallet_receip',9097,
     :'late_entry_ledger_statement_sha256'),
    ('20260911050554','final_deal_receipts_survive_real_terminal_settlement',82770,
     :'final_deal_v2_statement_sha256'),
    ('20260911052216','the_daily_free_spin_leaves_the_building',49343,
     :'wheel_welcome_statement_sha256'),
    ('20260911052648','bounty_rebuy_settles_its_exact_prior_entry_generation',22463,
     :'bounty_rebuy_statement_sha256'),
    ('20260911061449','the_welcome_spin_answers_the_same_everywhere',45362,
     :'welcome_spin_answer_statement_sha256'),
    ('20260911061723','cancel_unstarted_entries_to_their_exact_funded_origin_wallet',16739,
     :'cancellation_origin_statement_sha256'),
    ('20260911062053','the_operator_sees_the_money_and_the_room',22888,
     :'operator_visibility_statement_sha256'),
    ('20260911064427','the_player_can_see_the_day_and_the_way_out',20833,
     :'player_day_exit_statement_sha256'),
    ('20260911072424','the_mint_that_is_gone_stops_being_reported',22537,
     :'retired_mint_reporting_statement_sha256'),
    ('20260911072837','legacy_rakeback_closed_period_single_payer',36786,
     :'legacy_rakeback_single_payer_statement_sha256'),
    ('20260911081721','legacy_round3_preserve_server_only_acl',3849,
     :'legacy_round3_acl_statement_sha256'),
    ('20260911081910','a_seat_exit_guard_without_its_consumer_refuses_nothing',7525,
     :'seat_exit_consumer_guard_statement_sha256'),
    ('20260911090347','the_prize_reprice_door_the_engine_calls_exists',9372,
     :'prize_reprice_statement_sha256')
), audited_tail_rows(version,name,statement_count) AS (
  VALUES
    ('20260910072322','the_knockout_door_owns_every_bust_a_hand_took',1),
    ('20260910072351','an_elimination_without_a_place_cannot_be_written',1),
    ('20260910073355','the_retired_sweeps_keep_their_disabled_schedule_rows',1),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes',4),
    ('20260910074504','a_manager_sweeps_itself_once_when_it_adopts_the_event',1),
    ('20260910075958','a_deferred_check_reads_the_row_at_commit_not_the_statement',1),
    ('20260910080137','the_outbox_leaves_the_realtime_publication',1),
    ('20260910080242','the_guard_that_stopped_five_satellites_is_answered_for',1),
    ('20260910080728','three_money_doors_are_audited_and_registered',1),
    ('20260910124023','a_player_id_is_a_uuid_not_a_uuid_version',1),
    ('20260910124524','a_bust_the_player_came_back_from_is_a_rebought_bust',1),
    ('20260910130319','restore_rake_attribution_retries',1),
    ('20260910130421','a_revealed_mystery_bounty_may_name_its_own_obligation',1),
    ('20260910132341','two_nets_that_are_reporting_history_are_answered',1),
    ('20260910132644','the_supply_meter_swing_did_not_repeat_and_the_ledger_balances',1),
    ('20260910132747','the_break_scorecard_names_why_a_break_never_started',1),
    ('20260910132833','a_maintenance_kind_registered_as_info_is_recorded_not_raised',1),
    ('20260910134429','every_seat_means_every_seat',1),
    ('20260910140538','a_detector_does_not_report_what_it_already_answered_for',1),
    ('20260910141101','booked_spin_continuation_preserves_floating_point_rounding',1),
    ('20260910143032','a_declared_guard_change_is_recorded_not_raised',1),
    ('20260910143719','the_guard_declaration_is_not_reachable_from_a_browser',1),
    ('20260910145833','a_place_is_not_a_bounty',1),
    ('20260910151228','the_door_was_fixed_after_the_manager_stopped_asking',1),
    ('20260910154446','the_database_refuses_migrations_inside_the_break_window',1),
    ('20260910154537','the_busts_the_door_can_now_accept_are_recorded',1),
    ('20260910154858','every_player_who_busted_has_a_place',1),
    ('20260910160413','a_finished_event_holds_no_pending_bust',1),
    ('20260910160841','the_break_window_refusal_names_its_rule_and_explains_list_migrations',1),
    ('20260910164655','stage_b_break_window_bootstrap_compatibility',1),
    ('20260910170356','a_handoff_that_names_its_successor_is_not_an_incident',1),
    ('20260910171843','started_tournaments_resume_or_settle_instead_of_cancelling',1),
    ('20260910171857','a_refused_finishing_place_creates_no_debt',1),
    ('20260910171911','a_tournament_elimination_requires_a_finishing_rank',1),
    ('20260910171924','satellite_seats_count_once_and_keep_the_funded_prize',1),
    ('20260910173147','the_settlement_lane_is_per_tournament_for_rolling_authorities',1),
    ('20260910174349','the_bounty_sweep_takes_one_tournament_lane_per_call',1),
    ('20260910181549','active_means_who_is_on_the_floor_cash_and_events_counted_apa',1)
), audited_tail_statements(version,name,ordinal,statement_bytes,statement_sha256) AS (
  VALUES
    ('20260910072322','the_knockout_door_owns_every_bust_a_hand_took',1,13334,
     '917370d3ab53a24b3783fb19aaaedbcc92f3e21b191c2b8f0f75c7037da560a7'),
    ('20260910072351','an_elimination_without_a_place_cannot_be_written',1,3176,
     '47df9d8bda8062c869e03bc80b16f6d3b596b5bdcdfd8c8d5afcac4d9836f774'),
    ('20260910073355','the_retired_sweeps_keep_their_disabled_schedule_rows',1,3726,
     '31dc07904307df179c912fa8b7512e55be179b2ca4aab957cd1543ce7ef154bd'),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes',1,92,
     'e35a015b273990e6dd2b91dd7a6f010789783786bdcee2ec957e6649020b54c3'),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes',2,93,
     '5fe9e6c9bac1d7346a8a4bef33c765565c026cd2acf0732007b1112a247d4498'),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes',3,93,
     '602fbb76b3337805e972d34ac8815791aa3358f51dd0e1cd17f323747f335f31'),
    ('20260910073818','the_break_writer_outwaits_the_doors_it_serializes',4,83,
     '6004ff5b7b75a276a91a78154ff5db40e6350ddacb9eb84baaddf6e02fefb44a'),
    ('20260910074504','a_manager_sweeps_itself_once_when_it_adopts_the_event',1,4267,
     '269551d6bcbe53a5d326e2b4825a203ec744287f7f2b9c126bfe27c9d1a5a29f'),
    ('20260910075958','a_deferred_check_reads_the_row_at_commit_not_the_statement',1,4759,
     '80966d34bda469c36e2b9afad5d594e5b334c2bbc7d3cc80fe930f1c6d295ec4'),
    ('20260910080137','the_outbox_leaves_the_realtime_publication',1,76,
     '44403761d38baa2ebd4d609f03263f654a3f4c8c9ae49b810ef89dc7ed20d50b'),
    ('20260910080242','the_guard_that_stopped_five_satellites_is_answered_for',1,5499,
     '41f2ae92fb733af7017025fb602464a2dd9c3be747f12f8c5cfbf58e0a449019'),
    ('20260910080728','three_money_doors_are_audited_and_registered',1,6234,
     '105085e76fb17e082d9073b6e3abcfb91db7317541458f160f20cc295783d76a'),
    ('20260910124023','a_player_id_is_a_uuid_not_a_uuid_version',1,5844,
     '5bcb5cc3fd39234b329cba490b8516821296e18c1db08233399f2d450209e024'),
    ('20260910124524','a_bust_the_player_came_back_from_is_a_rebought_bust',1,5108,
     '6940a301d46f205e89fd3e2197513983afd28170a81ebd49d8984e14110e601a'),
    ('20260910130319','restore_rake_attribution_retries',1,8151,
     'f912f858c7f35004bfc2447fdf70329afc8a52029970e052c85c8e106fc83f2c'),
    ('20260910130421','a_revealed_mystery_bounty_may_name_its_own_obligation',1,6558,
     '2236fdbd5ce9f765dba5e9e5dc2cdb5ae5590f6e3b1f5e5180145b9918b9d400'),
    ('20260910132341','two_nets_that_are_reporting_history_are_answered',1,6738,
     '94b9bb3b748e6fe65308a4d8e69418e6afc1b3cd4461684ec655e1595bbf45b7'),
    ('20260910132644','the_supply_meter_swing_did_not_repeat_and_the_ledger_balances',1,5495,
     '4824de6d021b3e3e692aa2c061b9e3cd92bd0fd4909bb443f229d6867ecae680'),
    ('20260910132747','the_break_scorecard_names_why_a_break_never_started',1,30503,
     '6e21f8eaa025be6a16c13c55e1c691fcd00e0235ec5e6c19fb3f55114d54b413'),
    ('20260910132833','a_maintenance_kind_registered_as_info_is_recorded_not_raised',1,5510,
     '93b2edc2cc08effd21f00e66d960046c11077fe0c65278f9ec86526fa502a961'),
    ('20260910134429','every_seat_means_every_seat',1,6589,
     '0a460a25ee1948abf643d3067866f5173cb495b80bd395d9c234422cd140ddea'),
    ('20260910140538','a_detector_does_not_report_what_it_already_answered_for',1,7356,
     '0fd60dfb93f570c2eb9a718a675fcbc3afdd03d6302688cc99c17eb495074204'),
    ('20260910141101','booked_spin_continuation_preserves_floating_point_rounding',1,12053,
     '5965e38e5bafa0568b263332ad448d84340ebc4d50317983474f684ef1529e6f'),
    ('20260910143032','a_declared_guard_change_is_recorded_not_raised',1,10216,
     'b8dcbf1388dda22db434f144da18ef3fcbb5a4842850172704fecd20a86db19f'),
    ('20260910143719','the_guard_declaration_is_not_reachable_from_a_browser',1,2650,
     '07a00604216e201f811309ab3a07dac65a3f732ef1694e7beeaee40bfd219617'),
    ('20260910145833','a_place_is_not_a_bounty',1,14907,
     '6a52ae50c80423153705406a0bf855fd8a04baacba0ef155273455c20078c9a4'),
    ('20260910151228','the_door_was_fixed_after_the_manager_stopped_asking',1,4857,
     '5246718dd1252f257a1fb88c3c8d06ce3812391bc4acb3b47be8db6e4217c1ee'),
    ('20260910154446','the_database_refuses_migrations_inside_the_break_window',1,20519,
     '772758b80f3a5f44296b84aabdb1def68278f541a1d49b8b58c49f33c5d9f082'),
    ('20260910154537','the_busts_the_door_can_now_accept_are_recorded',1,7080,
     '2cf00803afc5bc6dc14cf7aa1c3a0b3284e1c34d1dd008a6945e4bacb4978f55'),
    ('20260910154858','every_player_who_busted_has_a_place',1,4795,
     'c6c6bf4bbad5212af762d5f5f3312e09688915ae4d1191199ac779ab967dd373'),
    ('20260910160413','a_finished_event_holds_no_pending_bust',1,6134,
     'cf7b45f9ef4f960a25ba03c9f0903366e1f5641adeb54ba55c3b162a03e218f3'),
    ('20260910160841','the_break_window_refusal_names_its_rule_and_explains_list_migrations',1,9261,
     '7e018da306ab9d56e82fa603f84535174a2975793aa7a74c4a4e931fc83ef34d'),
    ('20260910164655','stage_b_break_window_bootstrap_compatibility',1,27550,
     '4d613b7193b1d1d42950040a336f985c7843db6b095cd02c4d751d27d30c5ec6'),
    ('20260910170356','a_handoff_that_names_its_successor_is_not_an_incident',1,7686,
     'bb1c283dc7951c74496e55121d3042d3282a885f96b0e16cbe980a3fc40217f0'),
    ('20260910171843','started_tournaments_resume_or_settle_instead_of_cancelling',1,4722,
     '85e02d3f2350b4c1c7229ab2b58e789b3b8651869c0c3834a3318d7547b10bf6'),
    ('20260910171857','a_refused_finishing_place_creates_no_debt',1,24703,
     '69d77f9968d49008f7069fe63b618b802937338e439f631806f02dba0da1220d'),
    ('20260910171911','a_tournament_elimination_requires_a_finishing_rank',1,10914,
     'cba4981055d5dd9278d7a882e3b8f0d954cd8ffccb37b6426cf4964c32504b68'),
    ('20260910171924','satellite_seats_count_once_and_keep_the_funded_prize',1,31628,
     '9a00bc662f729d5a6db25c4f10a5ceeb45509b230e35f48252620fe9dcef3fc3'),
    ('20260910173147','the_settlement_lane_is_per_tournament_for_rolling_authorities',1,50176,
     'bc620a6b093ab9769615427168763bc35aaed44e60ee190202470dfcef0f744b'),
    ('20260910174349','the_bounty_sweep_takes_one_tournament_lane_per_call',1,14494,
     '0e209beadad2f8b52e8c72c0bd3559b6fe64fab9917bfb8ac6516a6297f66a17'),
    ('20260910181549','active_means_who_is_on_the_floor_cash_and_events_counted_apa',1,6683,
     '1af938d32302276d1165e74942e0f2a8588329d9e18774d7280f7bb98298cfad')
), bounty_trigger_binding(table_name,trigger_name,trigger_type,triggerdef_md5) AS (
  VALUES
    ('tournament_bounties','trg_attach_bounty_ledger_obligation',7,
     'ff3e9305edae93d151545b1e39f519c3')
), cancellation_forward_input_functions(identity,body_md5) AS (
  VALUES
    ('public.atomic_cancel_tournament(uuid,uuid)',
     '623100aa87ed6d0ef1a3598fb9ccb8b3'),
    ('public.fn_ca_tournament_cancellation_receipt(uuid,uuid)',
     '0b6abcc8e4bb561856699e5d24a86fc9')
), final_deal_v2_functions(
  identity,body_md5,definition_md5,config,service_execute,return_type,defaults
) AS (
  VALUES
    ('public.fn_complete_tournament_terminal(uuid,uuid,text)',
     '96a61ea5e16560735bcb70b355aa79ab','480be3139fe0878e637ce54f533a2170',
     ARRAY['search_path=public, pg_temp','statement_timeout=45s']::text[],true,'jsonb',0),
    ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
     '90f7506df2f1a94fe22952714fcd9f85','8397b4f24c6d1a072d7b2d946f45e3d6',
     ARRAY['search_path=public','statement_timeout=45s']::text[],false,'jsonb',0),
    ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
     'bb4b0e1d1c758943fca29f9a83d064e4','185dcb02134aa1f1fd2d87cdddbcfd26',
     ARRAY['search_path=public','statement_timeout=30s']::text[],false,'jsonb',1),
    ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)',
     '260c94b41d7f2bb021a88a546a1714ac','cb81d2c33985e46bd56dc3c4f1320e67',
     ARRAY['search_path=public, pg_temp']::text[],false,'jsonb',1),
    ('public.fn_guard_tournament_completing_claim()',
     '82078938fd926c94a0ab778acd77dd61','311ed77e7726f0c7515859a9140d526c',
     ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
    ('public.trg_tournament_atomic_place_completion_guard()',
     '3e43d26ddd36a55e736a9a304a89ba9a','18cf8159e315f322ac7cc09e1f913671',
     ARRAY['search_path=public']::text[],true,'trigger',0),
    ('public.trg_lock_atomic_final_table_deal_status()',
     'ddc5e3121ed9cc73d41525e6c1ba6c34','b16256830158e669defcff8751cb5be7',
     ARRAY['search_path=public']::text[],true,'trigger',0),
    ('public.fn_guard_tournament_completed_certificate()',
     'd994347e1b76c936ce13361d73f94fd2','8a05956d1fd25d649f1f80b133ed3ed0',
     ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
    ('public.trg_freeze_canonical_final_deal_batch()',
     '80362aed787137219432f6039bf03158','c5bbfca7dcc4aedc286c4004f5f5d2c1',
     ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
    ('public.fn_settle_tournament_final_table_deal(uuid)',
     'b1941b2e55dade307ecd74068ab3e500','c7bee6802ab30d625c32503a4d6609e1',
     ARRAY['search_path=public','statement_timeout=30s']::text[],true,'jsonb',0),
    ('public.trg_atomic_final_table_deal_completion_guard()',
     '9f5f5fefa77ae93bfeffc9f414a63a0d','38bf96ba348994fd40264584c26107d8',
     ARRAY['search_path=public']::text[],true,'trigger',0),
    ('public.trg_freeze_atomic_final_table_deal_obligation()',
     'd338c5278ef1247ff0f4a7c4ba774cc5','237168031dfb0fb80bdaa8ff15f25172',
     ARRAY['search_path=public']::text[],true,'trigger',0),
    ('public.fn_tournament_finish_readiness(uuid,uuid)',
     '993e6e1de9edba2fe235d86ff6c243c9','6361f556eac2ff2940e3f49f485176d0',
     ARRAY['search_path=public, pg_temp']::text[],false,'jsonb',0),
    ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
     '3585ddbfdb0a197243d5e6eefb6b670f','f676b2cbb361896dfa61f7e5f9413f46',
     ARRAY['search_path=public']::text[],false,'jsonb',0),
    ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
     'f1fc7a0bf480b1034f0f1d9cba3b4d0b','6bbb0ff983fc61c9f8c18cc2201e0f93',
     ARRAY['search_path=public']::text[],false,'jsonb',0),
    ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
     '852e35483b67c1fc59b6347b51c79cb8','3437a8e83051385947c6b48e7c399a90',
     ARRAY['search_path=public']::text[],false,'jsonb',0)
), cron_control_objects AS (
  SELECT jsonb_build_object(
           'jobid',jobid,'jobname',jobname,'schedule',schedule,
           'command',command,'database',database,'username',username,
           'nodename',nodename,'nodeport',nodeport,'active',active) AS value
    FROM cron.job
   WHERE jobname IN ('ca-eliminate-absent-players','ca-release-broke-seats')
      OR command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
      OR command ILIKE '%fn_ca_release_broke_seats%'
   ORDER BY jobid
), cron_control_canon AS (
  SELECT count(*) AS row_count,
         COALESCE(jsonb_agg(value),'[]'::jsonb)::text AS value
    FROM cron_control_objects
), money_control_objects AS (
  SELECT jsonb_build_object(
           'proname',proname,'status',status,'notes',notes,
           'added_at_utc',to_char(added_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS value
    FROM public.ca_money_rpc_registry
   WHERE proname IN (
     'fn_move_tournament_player',
     'fn_poker_diamond_settle_cash_hand',
     'fn_poker_diamond_cashout')
   ORDER BY proname
), money_control_canon AS (
  SELECT count(*) AS row_count,
         COALESCE(jsonb_agg(value),'[]'::jsonb)::text AS value
    FROM money_control_objects
), absent_function_objects AS (
  SELECT jsonb_build_object(
           'signature',format('%I.%I(%s)',n.nspname,p.proname,
                              pg_get_function_identity_arguments(p.oid)),
           'owner',pg_get_userbyid(p.proowner),
           'security_definer',p.prosecdef,
           'volatility',p.provolatile,'parallel',p.proparallel,
           'proconfig',COALESCE((SELECT jsonb_agg(x ORDER BY x)
                                   FROM unnest(p.proconfig) x),'[]'::jsonb),
           'prosrc_md5',md5(p.prosrc),
           'functiondef_bytes',octet_length(pg_get_functiondef(p.oid)),
           'functiondef_sha256',encode(
             sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) AS value
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.oid IN (
       'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'::regprocedure,
       'public.fn_ca_release_broke_seats(integer,integer,boolean)'::regprocedure)
   ORDER BY p.proname
), absent_function_canon AS (
  SELECT count(*) AS row_count,jsonb_agg(value)::text AS value
    FROM absent_function_objects
), maintenance_objects AS (
  SELECT jsonb_build_object(
           'signature',format('%I.%I(%s)',n.nspname,p.proname,
                              pg_get_function_identity_arguments(p.oid)),
           'proconfig',COALESCE((SELECT jsonb_agg(x ORDER BY x)
                                   FROM unnest(p.proconfig) x),'[]'::jsonb)) AS value
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.oid IN (
     'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure,
     'public.fn_clear_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,uuid)'::regprocedure,
     'public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure,
     'public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure)
   ORDER BY p.proname
), maintenance_canon AS (
  SELECT count(*) AS row_count,jsonb_agg(value)::text AS value
    FROM maintenance_objects
), elimination_function AS (
  SELECT jsonb_build_object(
           'kind','function',
           'signature','public.fn_tournament_elimination_has_a_place()',
           'owner',pg_get_userbyid(p.proowner),
           'security_definer',p.prosecdef,
           'proconfig',COALESCE((SELECT jsonb_agg(x ORDER BY x)
                                   FROM unnest(p.proconfig) x),'[]'::jsonb),
           'prosrc_md5',md5(p.prosrc),
           'functiondef_bytes',octet_length(pg_get_functiondef(p.oid)),
           'functiondef_sha256',encode(
             sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) AS value
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_tournament_elimination_has_a_place()'::regprocedure
), elimination_trigger AS (
  SELECT jsonb_build_object(
           'kind','trigger','name',tgname,'table',tgrelid::regclass::text,
           'function',tgfoid::regprocedure::text,'enabled',tgenabled,
           'internal',tgisinternal,'deferrable',tgdeferrable,
           'initially_deferred',tginitdeferred,
           'triggerdef',pg_get_triggerdef(oid,true)) AS value
    FROM pg_trigger
   WHERE tgrelid='public.tournament_players'::regclass
     AND tgname='tournament_elimination_has_a_place'
), elimination_constraint AS (
  SELECT jsonb_build_object(
           'kind','constraint','name',conname,'type',contype,
           'table',conrelid::regclass::text,'deferrable',condeferrable,
           'initially_deferred',condeferred,'validated',convalidated,
           'constraintdef',pg_get_constraintdef(oid,true)) AS value
    FROM pg_constraint
   WHERE conrelid='public.tournament_players'::regclass
     AND conname='tournament_elimination_has_a_place'
), elimination_objects AS (
  SELECT value FROM elimination_function
  UNION ALL SELECT value FROM elimination_trigger
  UNION ALL SELECT value FROM elimination_constraint
), elimination_canon AS (
  SELECT count(*) AS row_count,
         jsonb_agg(value ORDER BY value->>'kind')::text AS value
    FROM elimination_objects
)
SELECT current_database(),
       current_setting('server_version_num')::integer / 10000,
       COALESCE(inet_server_addr()::text, 'local-socket'),
       CASE
         WHEN inet_server_addr() IS NULL
           OR inet_server_addr() <<= inet '127.0.0.0/8'
           OR inet_server_addr() = inet '::1'
         THEN 'local'
         ELSE 'remote'
       END,
       (SELECT count(*)
          FROM required_prerequisites expected
         WHERE (SELECT count(*)
                  FROM supabase_migrations.schema_migrations actual
                 WHERE actual.version=expected.version
                   AND actual.name=expected.name)=1),
       (SELECT count(*)
          FROM exact_body_rows expected
          JOIN supabase_migrations.schema_migrations actual
            ON actual.version=expected.version AND actual.name=expected.name
         WHERE cardinality(actual.statements)=1
           AND encode(extensions.digest(actual.statements[1],'sha256'),'hex')=
                 expected.statement_sha256),
       (SELECT count(*)
          FROM descriptor_rows expected
          JOIN supabase_migrations.schema_migrations actual
            ON actual.version=expected.version AND actual.name=expected.name
         WHERE cardinality(actual.statements)=1
           AND octet_length(actual.statements[1])=expected.statement_bytes
           AND encode(extensions.digest(actual.statements[1],'sha256'),'hex')=
                 expected.statement_sha256),
       (SELECT count(*)
          FROM audited_tail_rows expected
          JOIN supabase_migrations.schema_migrations actual
            ON actual.version=expected.version AND actual.name=expected.name
         WHERE cardinality(actual.statements)=expected.statement_count),
       (SELECT count(*)
          FROM audited_tail_statements expected
          JOIN supabase_migrations.schema_migrations actual
            ON actual.version=expected.version AND actual.name=expected.name
         WHERE octet_length(actual.statements[expected.ordinal])=
                 expected.statement_bytes
           AND encode(extensions.digest(
                 actual.statements[expected.ordinal],'sha256'),'hex')=
                 expected.statement_sha256),
       CASE
         WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN -1
         ELSE (
           SELECT count(*)
             FROM supabase_migrations.schema_migrations
            WHERE name IN (
              'stage_b_forward_authority_expansion',
              'stage_b_exact_precondition_repairs',
              'stage_b_terminal_break_invariant',
              'stage_b_atomic_finish_precertification',
              'stage_b_current_postimage_contraction',
              'stage_b_lease_keyshare_once'
            )
         )
       END,
       (SELECT count(*) FROM public.engine_maintenance_break),
       CASE
         WHEN to_regclass('public.engine_leader') IS NULL
           OR to_regclass('public.engine_table_leases') IS NULL
           OR to_regclass('public.engine_tournament_leases') IS NULL THEN -1
         ELSE
           (SELECT count(*) FROM public.engine_leader
             WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
           + (SELECT count(*) FROM public.engine_table_leases
               WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
           + (SELECT count(*) FROM public.engine_tournament_leases
               WHERE heartbeat_at >= clock_timestamp() - interval '30 seconds')
       END,
       (SELECT count(*)
          FROM pg_proc p
         WHERE p.oid=to_regprocedure(
                 'public.fn_receipted_tournament_is_immutable()'
               )
           AND p.proacl::text='{postgres=X/postgres}'),
       (SELECT count(*)
          FROM pg_proc p
          JOIN pg_language l ON l.oid=p.prolang
         WHERE p.oid=to_regprocedure(
                 'public.fn_managed_game_contract_document(text,jsonb)'
               )
           AND md5(pg_get_functiondef(p.oid))=
                 '6a8019cb24b5a8a42645b9de3aaf48ef'
           AND p.proowner='postgres'::regrole
           AND NOT p.prosecdef
           AND p.provolatile='i'
           AND p.proparallel='u'
           AND NOT p.proleakproof
           AND p.prokind='f'
           AND NOT p.proisstrict
           AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2
           AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
                 '{postgres=X/postgres,service_role=X/postgres}'
           AND l.lanname='sql'),
       pg_temp.assert_zero_player_data_baseline(),
       CASE WHEN (SELECT row_count FROM cron_control_canon)=2
                  AND (SELECT octet_length(value) FROM cron_control_canon)=539
                  AND (SELECT encode(sha256(convert_to(value,'UTF8')),'hex')
                         FROM cron_control_canon)=:'cron_control_sha256'
            THEN 1 ELSE 0 END,
       CASE WHEN (SELECT row_count FROM money_control_canon)=3
                  AND (SELECT octet_length(value) FROM money_control_canon)=1348
                  AND (SELECT encode(sha256(convert_to(value,'UTF8')),'hex')
                         FROM money_control_canon)=:'money_control_sha256'
            THEN 1 ELSE 0 END,
       CASE WHEN (SELECT row_count FROM absent_function_canon)=2
                  AND (SELECT octet_length(value) FROM absent_function_canon)=841
                  AND (SELECT encode(sha256(convert_to(value,'UTF8')),'hex')
                         FROM absent_function_canon)=:'absent_functions_sha256'
            THEN 1 ELSE 0 END,
       (SELECT count(*)
          FROM pg_proc p
         WHERE p.oid IN (
           'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'::regprocedure,
           'public.fn_ca_release_broke_seats(integer,integer,boolean)'::regprocedure)
           AND (SELECT count(*) FROM aclexplode(
                  COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.privilege_type='EXECUTE')=2
           AND (SELECT count(*) FROM aclexplode(
                  COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantor=p.proowner AND a.grantee=p.proowner
                   AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)=1
           AND (SELECT count(*) FROM aclexplode(
                  COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantor=p.proowner
                   AND a.grantee='service_role'::regrole
                   AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)=1),
       (SELECT count(*)
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public'
           AND (p.proname='fn_claim_bounty_legacy_candidate_20260907'
                AND md5(pg_get_functiondef(p.oid))=
                    '5437a59dbe68a08e9df13baa422a903c'
             OR p.proname='fn_exact_tournament_knockout_claimants'
                AND md5(pg_get_functiondef(p.oid))=
                    '693e6c0b561a6861e41c57659411dd56')),
       (SELECT count(*)
          FROM pg_proc p
          JOIN pg_language l ON l.oid=p.prolang
         WHERE (
           p.oid=to_regprocedure(
             'public.fn_settle_tournament_rake(uuid,text)')
           AND md5(pg_get_functiondef(p.oid))=
               '657781a399203068a1a4888354757878'
           AND md5(p.prosrc)='be08a61e1a867519048c4692b41ab1fd'
           AND octet_length(pg_get_functiondef(p.oid))=7685
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY[
             'search_path=public, pg_temp','statement_timeout=30s']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_attach_bounty_ledger_obligation()')
           AND md5(pg_get_functiondef(p.oid))=
               '324f9f652d501cc93daacec52e1b3246'
           AND md5(p.prosrc)='e2028269240a041e38fdc1cb0853e64f'
           AND octet_length(pg_get_functiondef(p.oid))=2154
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='trigger'::regtype
           AND p.pronargs=0 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text='{postgres=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_record_break_scorecard(timestamptz)')
           AND md5(pg_get_functiondef(p.oid))=
               '0d9eb4d63244cfc69879f87596439c99'
           AND md5(p.prosrc)='00c4e6cb5cba2a4550e332c1f7d33746'
           AND octet_length(pg_get_functiondef(p.oid))=10536
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='public.ca_break_scorecards'::regtype
           AND p.pronargs=1 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)')
           AND md5(pg_get_functiondef(p.oid))=
               '0de54de4eee0f2cfee9a5fd9e1e368ff'
           AND md5(p.prosrc)='b76e912f943f096c2fd8ab2ab04e25e1'
           AND octet_length(pg_get_functiondef(p.oid))=4479
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='void'::regtype
           AND p.pronargs=1 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure('public.ca_index_every_seat(integer)')
           AND md5(pg_get_functiondef(p.oid))=
               '0cb93b8670db03efd2b582269fcd9e54'
           AND md5(p.prosrc)='9cf7d1857d41e1c95a8ed1151dff3c0a'
           AND octet_length(pg_get_functiondef(p.oid))=3022
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=1 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_hand_commit_refusals(integer)')
           AND md5(pg_get_functiondef(p.oid))=
               '9ba446c4741c6a7d6cd18d717f4418bb'
           AND md5(p.prosrc)='39f7a321222bef7f0e26e2d224a59f46'
           AND octet_length(pg_get_functiondef(p.oid))=2562
           AND p.proowner='postgres'::regrole AND l.lanname='sql'
           AND p.prosecdef AND p.provolatile='s' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND p.proretset
           AND p.prorettype='record'::regtype
           AND p.pronargs=1 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)')
           AND md5(pg_get_functiondef(p.oid))=
               '8545c67dc20be918ada9027d88f46312'
           AND md5(p.prosrc)='4f83c09a69eecc766a1f3984feeb9823'
           AND octet_length(pg_get_functiondef(p.oid))=10360
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=5 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text='{postgres=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_declare_guard_redefinition(text,text)')
           AND md5(pg_get_functiondef(p.oid))=
               '3a3746dc6e0a5b7a1db97805588c0eb8'
           AND md5(p.prosrc)='9d10bbc7e34373e82ce9e92e563297bc'
           AND octet_length(pg_get_functiondef(p.oid))=2019
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='text'::regtype
           AND p.pronargs=2 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_financial_alert_to_incident()')
           AND md5(pg_get_functiondef(p.oid))=
               '5f01207b21a3e2353f6c47291162f22a'
           AND md5(p.prosrc)='2479f66166ce003c48896d1aab55487b'
           AND octet_length(pg_get_functiondef(p.oid))=5978
           AND encode(sha256(convert_to(
                 pg_get_functiondef(p.oid),'UTF8')),'hex')=
               'b21508438cf6698498847195161112e8cab7169d69fcf0b793c53bba4c0f53e3'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='trigger'::regtype
           AND p.pronargs=0 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure('public.fn_ca_escrow_on_rake_record()')
           AND md5(pg_get_functiondef(p.oid))=
               '0dc096bb5615758ed945365a45997c8c'
           AND md5(p.prosrc)='3e628d6a57a93eeb61d494ee33f989a3'
           AND octet_length(pg_get_functiondef(p.oid))=1008
           AND encode(sha256(convert_to(
                 pg_get_functiondef(p.oid),'UTF8')),'hex')=
               'c4fb06976d4a4853b9a02c2c90a450dd5e3e90750f8d40e0375403d17176a044'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='trigger'::regtype
           AND p.pronargs=0 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure('public.fn_ca_tournament_escrow(uuid)')
           AND md5(pg_get_functiondef(p.oid))=
               '68d99bdb6dc9a46906336b9ed6987e97'
           AND md5(p.prosrc)='56663389f8348d2ab35a54460c0b7632'
           AND octet_length(pg_get_functiondef(p.oid))=7688
           AND encode(sha256(convert_to(
                 pg_get_functiondef(p.oid),'UTF8')),'hex')=
               '42ae2e8560d4b640c73c44c6b1e680e9844f6899c4b8250994e22dcfd0f1bde3'
           AND p.proowner='postgres'::regrole AND l.lanname='sql'
           AND p.prosecdef AND p.provolatile='s' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND p.proretset
           AND p.prorettype='record'::regtype
           AND p.pronargs=1 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_sweep_pending_tournament_bounties(uuid,integer)')
           AND md5(pg_get_functiondef(p.oid))=
               '30ca1181317d0f76d7a549ceab37b493'
           AND md5(p.prosrc)='9a16c59eb58695facd75a2d7406b7c28'
           AND octet_length(pg_get_functiondef(p.oid))=10343
           AND octet_length(p.prosrc)=10088
           AND encode(sha256(convert_to(
                 pg_get_functiondef(p.oid),'UTF8')),'hex')=
               '873a79f230a1f6a73ad2ab9c24368cba36ba8b9ad8c127c6fe3a898ac9307b54'
           AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=
               '6fce349c2fe8d7b4f9788de23fe8b860ae36c5e44067c801d519821999b4e9bb'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2 AND p.pronargdefaults=2
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ensure_late_registration_capacity(uuid,integer)')
           AND md5(pg_get_functiondef(p.oid))=
               '231f56742d40351b5121622ef068d02c'
           AND md5(p.prosrc)='b36dd36a9348d29be1092c7d42954c03'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2 AND p.pronargdefaults=1
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
           AND position('public.fn_tournament_current_blinds(p_tournament_id)'
                        IN p.prosrc)>0
           AND position('tournament_capacity_table_receipts' IN p.prosrc)>0
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)')
           AND md5(pg_get_functiondef(p.oid))=
               '4f1800b2cd9bbf61cf926130eb8f03db'
           AND md5(p.prosrc)='9311ef4ed0c2fa6fbb0f1d8fa169137f'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=2 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public']::text[]
           AND p.proacl::text='{postgres=X/postgres}'
           AND position(
                 'public.fn_ensure_late_registration_capacity(p_tournament_id,0)'
                 IN p.prosrc)>0
         ) OR (
           p.oid=to_regprocedure(
             'public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)')
           AND md5(pg_get_functiondef(p.oid))=
               '53e97347076b0a6de0a5f7f4abaf359d'
           AND md5(p.prosrc)='d1dd7af2ba51d15355f05d10057ec04a'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND NOT p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='void'::regtype
           AND p.pronargs=9 AND p.pronargdefaults=3
           AND p.proconfig=ARRAY['search_path=public, extensions']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         ) OR (
           p.oid=to_regprocedure(
             'public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)')
           AND md5(pg_get_functiondef(p.oid))=
               'b9df97fa4e796726443bffd8d51da248'
           AND octet_length(pg_get_functiondef(p.oid))=4297
           AND encode(sha256(convert_to(
                 pg_get_functiondef(p.oid),'UTF8')),'hex')=
               '3273dca6e3606a7ec94533255e7e090492a6d282d31939b947ee33ec2c5593c2'
           AND md5(p.prosrc)='691a3f79a0a36e48f822832d98e12052'
           AND octet_length(p.prosrc)=4025
           AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=
               '7248ae3fe0700331c9ef45ea028acb7d320662617736ed83c714f684c3416830'
           AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
           AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
           AND NOT p.proleakproof AND p.prokind='f'
           AND NOT p.proisstrict AND NOT p.proretset
           AND p.prorettype='jsonb'::regtype
           AND p.pronargs=4 AND p.pronargdefaults=0
           AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
           AND p.proacl::text=
             '{postgres=X/postgres,service_role=X/postgres}'
         )),
       CASE
         WHEN (SELECT count(*)
                 FROM bounty_trigger_binding expected
                 JOIN pg_class c ON c.relname=expected.table_name
                 JOIN pg_namespace n ON n.oid=c.relnamespace
                 JOIN pg_trigger trg
                   ON trg.tgrelid=c.oid AND trg.tgname=expected.trigger_name
                WHERE n.nspname='public'
                  AND trg.tgfoid=to_regprocedure(
                    'public.fn_attach_bounty_ledger_obligation()')
                  AND trg.tgenabled='O' AND NOT trg.tgisinternal
                  AND NOT trg.tgdeferrable AND NOT trg.tginitdeferred
                  AND trg.tgtype=expected.trigger_type
                  AND md5(pg_get_triggerdef(trg.oid,true))=
                      expected.triggerdef_md5)=1
          AND (SELECT count(*) FROM pg_trigger trg
                WHERE trg.tgfoid=to_regprocedure(
                        'public.fn_attach_bounty_ledger_obligation()')
                  AND NOT trg.tgisinternal)=1
         THEN 1 ELSE -1
       END,
       CASE WHEN (
         SELECT count(*)
           FROM cancellation_forward_input_functions expected
           JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
          WHERE md5(p.prosrc)=expected.body_md5
       )=2 THEN 1 ELSE 0 END,
       CASE WHEN (
         SELECT count(*)
           FROM final_deal_v2_functions expected
           JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
           JOIN pg_language l ON l.oid=p.prolang
          WHERE md5(p.prosrc)=expected.body_md5
            AND md5(pg_get_functiondef(p.oid))=expected.definition_md5
            AND p.proowner='postgres'::regrole
            AND p.prosecdef
            AND l.lanname='plpgsql'
            AND p.prokind='f'
            AND NOT p.proisstrict
            AND p.provolatile=CASE WHEN expected.identity=
                  'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'
                  THEN 's'::"char" ELSE 'v'::"char" END
            AND p.proparallel='u'
            AND NOT p.proleakproof
            AND NOT p.proretset
            AND p.prorettype=expected.return_type::regtype
            AND p.pronargdefaults=expected.defaults
            AND p.proconfig=expected.config
            AND p.proacl::text=CASE WHEN expected.service_execute
                  THEN '{postgres=X/postgres,service_role=X/postgres}'
                  ELSE '{postgres=X/postgres}' END)=16
         THEN 1 ELSE 0 END,
       CASE WHEN EXISTS (
         SELECT 1
           FROM pg_class c
          WHERE c.oid='public.tournament_final_table_deal_batches'::regclass
            AND c.relowner='postgres'::regrole
            AND c.relrowsecurity
            AND NOT c.relforcerowsecurity
            AND c.relacl::text=
                '{postgres=arwdDxtm/postgres,service_role=r/postgres}')
         AND NOT has_table_privilege(
           'anon','public.tournament_final_table_deal_batches',
           'SELECT,INSERT,UPDATE,DELETE')
         AND NOT has_table_privilege(
           'authenticated','public.tournament_final_table_deal_batches',
           'SELECT,INSERT,UPDATE,DELETE')
         AND has_table_privilege(
           'service_role','public.tournament_final_table_deal_batches','SELECT')
         AND NOT has_table_privilege(
           'service_role','public.tournament_final_table_deal_batches',
           'INSERT,UPDATE,DELETE')
         AND EXISTS (
           SELECT 1
             FROM pg_attribute a
             JOIN pg_attrdef d
               ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid=
                  'public.tournament_final_table_deal_batches'::regclass
              AND a.attname='contract_version'
              AND a.atttypid='integer'::regtype
              AND a.attnotnull
              AND NOT a.attisdropped
              AND pg_get_expr(d.adbin,d.adrelid)='1')
         AND EXISTS (
           SELECT 1
             FROM pg_constraint con
            WHERE con.conrelid=
                  'public.tournament_final_table_deal_batches'::regclass
              AND con.conname='tournament_final_deal_contract_version'
              AND con.convalidated
              AND pg_get_constraintdef(con.oid)=
                  'CHECK ((contract_version = ANY (ARRAY[1, 2])))')
         AND EXISTS (
           SELECT 1
             FROM pg_constraint con
            WHERE con.conrelid=
                  'public.tournament_final_table_deal_batches'::regclass
              AND con.conname='tournament_final_table_deal_bubble_shape'
              AND con.convalidated
              AND md5(pg_get_constraintdef(con.oid))=
                  'e685ad4c6440decb7f57310d455c5bd0')
         AND EXISTS (
           SELECT 1
             FROM pg_trigger trg
            WHERE trg.tgrelid=
                  'public.tournament_final_table_deal_batches'::regclass
              AND trg.tgname='zzzz_freeze_canonical_final_deal_batch'
              AND trg.tgfoid=
                  'public.trg_freeze_canonical_final_deal_batch()'::regprocedure
              AND trg.tgtype=27
              AND trg.tgenabled='O'
              AND NOT trg.tgisinternal
              AND trg.tgnargs=0
              AND trg.tgqual IS NULL)
         THEN 1 ELSE 0 END,
       pg_temp.assert_stage_b_132747_break_fault_catalog(
         :'maintenance_fault_catalog_sha256'),
       CASE WHEN (SELECT row_count FROM maintenance_canon)=4
                  AND (SELECT octet_length(value) FROM maintenance_canon)=1197
                  AND (SELECT encode(sha256(convert_to(value,'UTF8')),'hex')
                         FROM maintenance_canon)=:'maintenance_proconfigs_sha256'
            THEN 1 ELSE 0 END,
       CASE WHEN (SELECT row_count FROM elimination_canon)=3
                  AND (SELECT octet_length(value) FROM elimination_canon)=1067
                  AND (SELECT encode(sha256(convert_to(value,'UTF8')),'hex')
                         FROM elimination_canon)=:'elimination_guard_sha256'
            THEN 1 ELSE 0 END,
       CASE WHEN to_regclass('public.hand_projection_outbox') IS NOT NULL
                  AND EXISTS (SELECT 1 FROM pg_publication
                               WHERE pubname='supabase_realtime')
                  AND NOT EXISTS (
                    SELECT 1 FROM pg_publication_tables
                     WHERE pubname='supabase_realtime'
                       AND schemaname='public'
                       AND tablename='hand_projection_outbox')
            THEN 1 ELSE 0 END;
SQL
  } | "${psql_cmd[@]}" -Atq -F '|'
})"
IFS='|' read -r actual_database major_version server_address locality \
  anchor_receipts exact_body_receipts descriptor_receipts \
  audited_tail_receipts audited_tail_statements staged_receipts maintenance_rows \
  fresh_authorities immutable_guard_acl contract_document_shape donor_data_rows \
  cron_control_exact money_control_exact absent_functions_exact \
  absent_function_acls player_id_functions_exact tail_functions_exact \
  bounty_trigger_binding_exact cancellation_forward_input_exact \
  final_deal_v2_functions_exact \
  final_deal_v2_schema_exact \
  break_fault_catalog_exact \
  maintenance_proconfigs elimination_guard \
  outbox_publication_absent \
  <<<"$preflight"

if [[ "$actual_database" != "$expected_database" ]]; then
  echo "Connected database ${actual_database:-<unknown>} does not match the acknowledged disposable database." >&2
  exit 65
fi
if [[ "$major_version" != '17' || "$locality" != 'local' ]]; then
  echo "Rehearsal requires local PostgreSQL 17; observed ${server_address:-unknown}." >&2
  exit 65
fi
if [[ "$anchor_receipts" != '66' ]]; then
  echo "The donor does not contain all 66 bounded Stage-B prerequisite receipts: ${anchor_receipts:-0}/66 present." >&2
  exit 65
fi
if [[ "$exact_body_receipts" != '3' ]]; then
  echo 'The donor does not contain all three byte-exact live body ledger rows (051447, 063559, 064701).' >&2
  exit 65
fi
if [[ "$descriptor_receipts" != '15' ]]; then
  echo 'The donor does not contain the byte-exact 055857, 060034, 10190537, and 11050554..11090347 ledger metadata.' >&2
  exit 65
fi
if [[ "$audited_tail_receipts" != '38' || "$audited_tail_statements" != '41' ]]; then
  echo 'The donor does not contain the byte-authenticated bounded Stage-B prerequisite tail.' >&2
  exit 65
fi
echo 'STAGE_B_BOUNDED_PREREQUISITE_MANIFEST_OK'
if [[ "$staged_receipts" != '0' ]]; then
  echo 'At least one Stage-B boundary is already ledgered; use a fresh disposable clone.' >&2
  exit 65
fi
if [[ "$maintenance_rows" != '0' || "$fresh_authorities" != '0' ]]; then
  echo 'The donor must have no maintenance row and every engine authority must be stale.' >&2
  exit 65
fi
if [[ "$immutable_guard_acl" != '1' ]]; then
  echo 'The disposable clone does not preserve the explicit production ACL on the receipted tournament immutability guard.' >&2
  exit 65
fi
if [[ "$contract_document_shape" != '1' ]]; then
  echo 'The disposable clone is missing the exact production managed-game contract document helper and ACL.' >&2
  exit 65
fi
if [[ "$donor_data_rows" != '0' ]]; then
  echo "The donor contains ${donor_data_rows} player, game, or financial rows; use a production-schema zero-data clone." >&2
  exit 65
fi
echo 'STAGE_B_ZERO_PLAYER_DATA_BASELINE_OK'
if [[ "$cron_control_exact" != '1' || "$money_control_exact" != '1' ]]; then
  echo 'The donor is missing the exact immutable 080728 inactive-sweep or money-registry control rows.' >&2
  exit 65
fi
if [[ "$absent_functions_exact" != '1' || "$absent_function_acls" != '2' ]]; then
  echo 'The donor does not preserve the exact 072322 absent-player function definitions, catalog, and ACLs.' >&2
  exit 65
fi
if [[ "$player_id_functions_exact" != '2' ]]; then
  echo 'The donor does not preserve the exact 124023 player-id function postimage.' >&2
  exit 65
fi
if [[ "$tail_functions_exact" != '16' ]]; then
  echo 'The donor does not preserve the exact bounded Stage-B prerequisite function postimage.' >&2
  exit 65
fi
if [[ "$bounty_trigger_binding_exact" != '1' ]]; then
  echo 'The donor does not preserve the exact bounty-ledger binding required by Stage-B.' >&2
  exit 65
fi
if [[ "$cancellation_forward_input_exact" != '1' ]]; then
  echo 'The donor does not preserve the exact 11061723 cancellation input bodies for the M1 forward correction.' >&2
  exit 65
fi
if [[ "$final_deal_v2_functions_exact" != '1' \
   || "$final_deal_v2_schema_exact" != '1' ]]; then
  echo 'The donor does not preserve the exact 11050554 final-deal-v2 object, ACL, configuration, and return contract.' >&2
  exit 65
fi
if [[ "$break_fault_catalog_exact" != 'STAGE_B_132747_BREAK_FAULT_CATALOG_OK' ]]; then
  echo 'The donor does not preserve the exact 132747 maintenance-break fault catalog.' >&2
  exit 65
fi
if [[ "$maintenance_proconfigs" != '1' || "$elimination_guard" != '1' \
   || "$outbox_publication_absent" != '1' ]]; then
  echo 'The donor does not preserve the audited 073818 maintenance budgets, 075958 deferred elimination guard, or 080137 publication absence.' >&2
  exit 65
fi

donor_state_fingerprint() {
  {
    emit_zero_player_data_assertion_function
    emit_break_fault_catalog_functions
    cat <<'SQL'
WITH target_functions(identity) AS (
  VALUES
    ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
    ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'),
    ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)'),
    ('smarter_private.fn_smarter_data_api_pre_request()'),
    ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'),
    ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)'),
    ('public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)'),
    ('public.fn_ca_release_broke_seats(integer,integer,boolean)'),
    ('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamptz,uuid,jsonb,numeric,boolean)'),
    ('public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)'),
    ('public.fn_settle_tournament_rake(uuid,text)'),
    ('public.fn_attach_bounty_ledger_obligation()'),
    ('public.fn_ca_record_break_scorecard(timestamptz)'),
    ('public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'),
    ('public.ca_index_every_seat(integer)'),
    ('public.fn_ca_hand_commit_refusals(integer)'),
    ('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'),
    ('public.fn_ca_declare_guard_redefinition(text,text)'),
    ('public.fn_ca_financial_alert_to_incident()'),
    ('public.atomic_cancel_tournament(uuid,uuid)'),
    ('public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'),
    ('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'),
    ('public.fn_award_satellite_seat(uuid,uuid,uuid,text,integer)'),
    ('public.fn_ca_escrow_on_rake_record()'),
    ('public.fn_ca_tournament_escrow(uuid)'),
    ('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'),
    ('public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)'),
    ('public.fn_ca_release_unseatable_registrant_at_launch(uuid,uuid,uuid,text)'),
    ('public.fn_mystery_bounty_pay(uuid)'),
    ('public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'),
    ('public.fn_satellite_target_player_provenance_is_immutable()'),
    ('public.fn_tournament_live_seat_acquisition_requires_authority()'),
    ('public.fn_tournament_payouts_are_append_only()'),
    ('public.fn_sweep_pending_tournament_bounties(uuid,integer)'),
    ('public.fn_ensure_late_registration_capacity(uuid,integer)'),
    ('public.fn_seat_late_registrant_before_maintenance_gate(uuid,uuid)'),
    ('public.log_wallet_transaction(uuid,text,numeric,text,text,text,uuid,uuid,uuid)'),
    ('public.fn_ca_reprice_unpaid_tournament_place(uuid,uuid,numeric,numeric)'),
    ('public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'),
    ('public.fn_clear_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,uuid)'),
    ('public.fn_claim_engine_maintenance_break(uuid,uuid,text)'),
    ('public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'),
    ('public.fn_tournament_elimination_has_a_place()'),
    ('public.fn_tournament_deal_proposal_is_immutable()'),
    ('public.fn_ca_tournament_deal_snapshot(uuid)'),
    ('public.fn_ca_tournament_deal_proposals_active()'),
    ('public.fn_get_tournament_deal_proposal(uuid)'),
    ('public.fn_cast_tournament_deal_vote(uuid,uuid,uuid)'),
    ('public.fn_get_tournament_deal_consensus(uuid)'),
    ('public.fn_require_exact_final_deal_proposal()'),
    ('public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)'),
    ('public.fn_resolve_tournament_terminal_proposal_outcome(uuid,uuid,text,uuid,text)'),
    ('public.fn_ca_tournament_deal_hand_revision(uuid)'),
    ('public.fn_ca_tournament_deal_review_result(uuid,uuid,uuid)'),
    ('public.fn_get_tournament_deal_review(uuid)'),
    ('public.fn_request_tournament_deal_review(uuid,uuid)'),
    ('public.fn_cancel_tournament_deal_review(uuid,uuid,uuid)'),
    ('public.fn_begin_tournament_deal_review(uuid,uuid)'),
    ('public.fn_close_tournament_deal_review(uuid,uuid,text)')
), ledger AS (
  SELECT encode(extensions.digest(COALESCE(string_agg(
           version||E'\x1f'||name||E'\x1f'||cardinality(statements)::text||E'\x1f'||
           encode(extensions.digest(array_to_string(statements,E'\x1e'),'sha256'),'hex'),
           E'\n' ORDER BY version,name),''),'sha256'),'hex') AS fingerprint
    FROM supabase_migrations.schema_migrations
), functions AS (
  SELECT jsonb_object_agg(
           target.identity,
           CASE WHEN p.oid IS NULL THEN jsonb_build_object('present',false)
                ELSE jsonb_build_object(
                  'present',true,
                  'definition',pg_get_functiondef(p.oid),
                  'owner',pg_get_userbyid(p.proowner),
                  'language',(SELECT l.lanname FROM pg_language l
                               WHERE l.oid=p.prolang),
                  'security_definer',p.prosecdef,
                  'volatility',p.provolatile,
                  'parallel',p.proparallel,
                  'leakproof',p.proleakproof,
                  'kind',p.prokind,
                  'strict',p.proisstrict,
                  'returns_set',p.proretset,
                  'return_type',p.prorettype::regtype::text,
                  'nargs',p.pronargs,
                  'defaults',p.pronargdefaults,
                  'configuration',p.proconfig,
                  'acl',p.proacl)
           END
           ORDER BY target.identity) AS fingerprint
    FROM target_functions target
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(target.identity)
), tail_trigger_bindings AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'table',format('%I.%I',n.nspname,c.relname),
           'name',trg.tgname,
           'enabled',trg.tgenabled,
           'internal',trg.tgisinternal,
           'deferrable',trg.tgdeferrable,
           'initially_deferred',trg.tginitdeferred,
           'type',trg.tgtype,
           'function',trg.tgfoid::regprocedure::text,
           'definition',pg_get_triggerdef(trg.oid,true))
         ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",
                  trg.tgname COLLATE "C"),'[]'::jsonb) AS fingerprint
    FROM pg_trigger trg
    JOIN pg_class c ON c.oid=trg.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE trg.tgfoid IN (
     to_regprocedure('public.fn_attach_bounty_ledger_obligation()'),
     to_regprocedure('public.fn_ca_financial_alert_to_incident()'),
     to_regprocedure('public.fn_ca_escrow_on_rake_record()'),
     to_regprocedure('public.fn_tournament_live_seat_acquisition_requires_authority()'),
     to_regprocedure('public.fn_satellite_target_player_provenance_is_immutable()'),
     to_regprocedure('public.fn_tournament_payouts_are_append_only()'))
     AND NOT trg.tgisinternal
), cron_controls AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'jobid',jobid,'jobname',jobname,'schedule',schedule,
           'command',command,'database',database,'username',username,
           'nodename',nodename,'nodeport',nodeport,'active',active)
           ORDER BY jobid),'[]'::jsonb) AS fingerprint
    FROM cron.job
   WHERE jobname IN ('ca-eliminate-absent-players','ca-release-broke-seats')
      OR command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
      OR command ILIKE '%fn_ca_release_broke_seats%'
), money_controls AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'proname',proname,'status',status,'notes',notes,
           'added_at_utc',to_char(added_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
           ORDER BY proname),'[]'::jsonb) AS fingerprint
    FROM public.ca_money_rpc_registry
   WHERE proname IN (
     'fn_move_tournament_player',
     'fn_poker_diamond_settle_cash_hand',
     'fn_poker_diamond_cashout')
), elimination_catalog AS (
  SELECT jsonb_build_object(
           'trigger',COALESCE((SELECT to_jsonb(t) FROM (
             SELECT tgname,tgenabled,tgisinternal,tgdeferrable,tginitdeferred,
                    pg_get_triggerdef(oid,true) AS definition
               FROM pg_trigger
              WHERE tgrelid='public.tournament_players'::regclass
                AND tgname='tournament_elimination_has_a_place') t),'null'::jsonb),
           'constraint',COALESCE((SELECT to_jsonb(c) FROM (
             SELECT conname,contype,condeferrable,condeferred,convalidated,
                    pg_get_constraintdef(oid,true) AS definition
               FROM pg_constraint
              WHERE conrelid='public.tournament_players'::regclass
                AND conname='tournament_elimination_has_a_place') c),'null'::jsonb)
         ) AS fingerprint
), donor_data AS (
  SELECT pg_temp.assert_zero_player_data_baseline() AS rows
)
SELECT md5(jsonb_build_object(
         'ledger',(SELECT fingerprint FROM ledger),
         'functions',(SELECT fingerprint FROM functions),
         'tail_trigger_bindings',(SELECT fingerprint FROM tail_trigger_bindings),
         'break_fault_catalog',
           pg_temp.stage_b_132747_break_fault_catalog_fingerprint(),
         'cron_controls',(SELECT fingerprint FROM cron_controls),
         'money_controls',(SELECT fingerprint FROM money_controls),
         'elimination_catalog',(SELECT fingerprint FROM elimination_catalog),
         'outbox_in_realtime',EXISTS (
           SELECT 1 FROM pg_publication_tables
            WHERE pubname='supabase_realtime'
              AND schemaname='public'
              AND tablename='hand_projection_outbox'),
         'stage_b_relations',jsonb_build_array(
           to_regclass('public.tournament_seat_exit_authority_cutover')::text,
           to_regclass('public.tournament_pending_zero_seat_cutover_receipts')::text,
           to_regclass('public.tournament_paid_candidate_cutover_receipts')::text,
           to_regclass('public.tournament_positive_orphan_cutover_receipts')::text,
           to_regclass('public.tournament_mutator_scheduler_retirement_receipts')::text,
           to_regclass('public.tournament_terminal_break_normalization_receipts')::text),
         'ownership_keys',(SELECT count(*) FROM pg_constraint
           WHERE (conrelid=to_regclass('public.engine_table_leases')
                  AND conname='engine_table_leases_owner_generation_key')
              OR (conrelid=to_regclass('public.engine_tournament_leases')
                  AND conname='engine_tournament_leases_owner_generation_key')),
         'maintenance_rows',(SELECT count(*) FROM public.engine_maintenance_break),
         'leader_rows',(SELECT count(*) FROM public.engine_leader),
         'table_lease_rows',(SELECT count(*) FROM public.engine_table_leases),
         'tournament_lease_rows',(SELECT count(*) FROM public.engine_tournament_leases),
         'donor_data_rows',(SELECT rows FROM donor_data)
       )::text);
SQL
  } | "${psql_cmd[@]}" --dbname="$expected_database" -Atq
}

wheel_welcome_catalog_fingerprint() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -Atq <<'SQL'
WITH target_functions(identity) AS (
  VALUES
    ('public.fn_diamond_games_entry(uuid)'),
    ('public.fn_wheel_set_welcome_spin(uuid,jsonb)'),
    ('public.fn_wheel_spin_core(uuid,uuid,text,boolean)'),
    ('public.fn_wheel_spin_result(public.wheel_spins)'),
    ('public.fn_wheel_welcome_spent(uuid,integer)'),
    ('public.fn_wheel_welcome_spin(uuid,uuid,text)'),
    ('public.fn_wheel_welcome_state(uuid)')
), function_catalog AS (
  SELECT target.identity,jsonb_build_object(
           'definition',pg_get_functiondef(p.oid),
           'owner',pg_get_userbyid(p.proowner),'language',l.lanname,
           'definer',p.prosecdef,'volatility',p.provolatile,
           'parallel',p.proparallel,'strict',p.proisstrict,
           'leakproof',p.proleakproof,'kind',p.prokind,
           'returns_set',p.proretset,'return',p.prorettype::regtype::text,
           'args',p.proargtypes::text,'defaults',p.pronargdefaults,
           'config',p.proconfig,'acl',p.proacl) AS value
    FROM target_functions target
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(target.identity)
    LEFT JOIN pg_language l ON l.oid=p.prolang
), config_columns AS (
  SELECT jsonb_build_object(
           'number',a.attnum,'name',a.attname,
           'type',format_type(a.atttypid,a.atttypmod),
           'notnull',a.attnotnull,'identity',a.attidentity,
           'generated',a.attgenerated,
           'default',pg_get_expr(d.adbin,d.adrelid)) AS value
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.wheel_configs'::regclass
     AND a.attnum>0 AND NOT a.attisdropped
), config_constraints AS (
  SELECT jsonb_build_object(
           'name',con.conname,'type',con.contype,
           'deferrable',con.condeferrable,'deferred',con.condeferred,
           'validated',con.convalidated,
           'definition',pg_get_constraintdef(con.oid,true)) AS value
    FROM pg_constraint con
   WHERE con.conrelid='public.wheel_configs'::regclass
), welcome_index AS (
  SELECT jsonb_build_object(
           'name',c.relname,'owner',pg_get_userbyid(c.relowner),
           'acl',c.relacl,'definition',pg_get_indexdef(c.oid),
           'unique',i.indisunique,'valid',i.indisvalid,
           'ready',i.indisready,'live',i.indislive,
           'predicate',pg_get_expr(i.indpred,i.indrelid)) AS value
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_index i ON i.indexrelid=c.oid
   WHERE n.nspname='public' AND c.relname='wheel_spins_welcome_window'
), retired_functions AS (
  SELECT identity,to_regprocedure(identity) IS NOT NULL AS present
    FROM (VALUES
      ('public.fn_wheel_free_history(uuid,integer)'),
      ('public.fn_wheel_free_spin_result(public.wheel_free_spins)'),
      ('public.fn_wheel_free_state(uuid)'),
      ('public.fn_wheel_free_spin(uuid,uuid,text)'),
      ('public.fn_wheel_set_free_spin(uuid,jsonb)')
    ) target(identity)
), deprecations AS (
  SELECT table_name,reason,replacement,deprecated_at
    FROM public.deprecated_tables
   WHERE table_name IN ('wheel_free_segments','wheel_free_spins')
)
SELECT encode(extensions.digest(convert_to(jsonb_build_object(
         'functions',(SELECT jsonb_object_agg(identity,value ORDER BY identity)
                        FROM function_catalog),
         'config_columns',(SELECT jsonb_agg(value ORDER BY value->>'number')
                             FROM config_columns),
         'config_constraints',(SELECT jsonb_agg(value ORDER BY value->>'name')
                                 FROM config_constraints),
         'welcome_index',(SELECT value FROM welcome_index),
         'retired_functions',(SELECT jsonb_object_agg(identity,present ORDER BY identity)
                                FROM retired_functions),
         'deprecations',(SELECT jsonb_agg(to_jsonb(d) ORDER BY table_name)
                           FROM deprecations d)
       )::text,'UTF8'),'sha256'),'hex');
SQL
}

donor_fingerprint_before="$(donor_state_fingerprint)"
if [[ -z "$donor_fingerprint_before" ]]; then
  echo 'Could not fingerprint the zero-data donor before rehearsal.' >&2
  exit 65
fi
wheel_welcome_catalog_before="$(wheel_welcome_catalog_fingerprint "$expected_database")"
if [[ ! "$wheel_welcome_catalog_before" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Could not fingerprint the exact 11052216 wheel catalog before rehearsal.' >&2
  exit 65
fi

emit_keyshare_fingerprint_function() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.stage_b_keyshare_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fingerprint$
WITH target_functions(identity) AS (
  VALUES
    ('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'),
    ('public.fn_ca_resolve_unbound_pending_addons(uuid,numeric,text,uuid)'),
    ('public.fn_close_empty_tournament_table(uuid,uuid,uuid)'),
    ('smarter_private.fn_smarter_data_api_pre_request()'),
    ('public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'),
    ('public.heartbeat_tournament_leases_v4(text,jsonb,integer)')
), function_rows AS (
  SELECT target.identity,
         p.oid,
         CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_functiondef(p.oid) END
           AS definition,
         CASE WHEN p.oid IS NULL THEN NULL ELSE pg_get_userbyid(p.proowner) END
           AS owner_name,
         p.prosecdef,
         p.proconfig,
         p.proacl,
         p.provolatile,
         p.proparallel,
         p.proisstrict,
         p.proleakproof,
         p.prokind,
         CASE WHEN p.oid IS NULL THEN NULL ELSE p.prorettype::regtype::text END
           AS return_type
    FROM target_functions target
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(target.identity)
), target_constraints(relation_name,constraint_name) AS (
  VALUES
    ('public.engine_table_leases',
     'engine_table_leases_owner_generation_key'),
    ('public.engine_tournament_leases',
     'engine_tournament_leases_owner_generation_key')
), constraint_rows AS (
  SELECT target.relation_name,
         target.constraint_name,
         con.oid,
         CASE WHEN con.oid IS NULL THEN NULL
              ELSE pg_get_constraintdef(con.oid,true) END AS definition,
         CASE WHEN con.oid IS NULL THEN NULL
              ELSE obj_description(con.oid,'pg_constraint') END AS comment,
         con.contype,
         con.convalidated,
         con.condeferrable,
         con.condeferred,
         con.connoinherit,
         con.conkey,
         NULLIF(con.conindid,0) AS index_oid,
         CASE WHEN con.conindid=0 THEN NULL
              ELSE pg_get_indexdef(con.conindid) END AS index_definition,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_userbyid(idx.relowner) END AS index_owner,
         ind.indisunique,
         ind.indisprimary,
         ind.indisvalid,
         ind.indisready,
         ind.indisclustered,
         ind.indisreplident,
         ind.indimmediate,
         ind.indcheckxmin,
         ind.indislive,
         ind.indnullsnotdistinct,
         ind.indnkeyatts,
         ind.indnatts,
         ind.indkey,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_expr(ind.indpred,ind.indrelid) END AS predicate,
         CASE WHEN idx.oid IS NULL THEN NULL
              ELSE pg_get_expr(ind.indexprs,ind.indrelid) END AS expressions
    FROM target_constraints target
    LEFT JOIN pg_constraint con
      ON con.conrelid=to_regclass(target.relation_name)
     AND con.conname=target.constraint_name
    LEFT JOIN pg_index ind ON ind.indexrelid=con.conindid
    LEFT JOIN pg_class idx ON idx.oid=con.conindid
)
SELECT CASE
         WHEN (SELECT count(*) FROM function_rows WHERE oid IS NOT NULL)<>6
           THEN 'missing'
         ELSE md5(jsonb_build_object(
           'functions',(
             SELECT jsonb_agg(
               jsonb_build_object(
                 'identity',identity,
                 'present',oid IS NOT NULL,
                 'function_oid',oid,
                 'definition',definition,
                 'owner',owner_name,
                 'security_definer',prosecdef,
                 'configuration',proconfig,
                 'acl',proacl,
                 'volatility',provolatile,
                 'parallel',proparallel,
                 'strict',proisstrict,
                 'leakproof',proleakproof,
                 'kind',prokind,
                 'return_type',return_type)
               ORDER BY identity)
               FROM function_rows),
           'constraints',(
             SELECT jsonb_agg(
               jsonb_build_object(
                 'relation',relation_name,
                 'name',constraint_name,
                 'present',oid IS NOT NULL,
                 'constraint_oid',oid,
                 'definition',definition,
                 'comment',comment,
                 'type',contype,
                 'validated',convalidated,
                 'deferrable',condeferrable,
                 'deferred',condeferred,
                 'no_inherit',connoinherit,
                 'keys',conkey,
                 'index_oid',index_oid,
                 'index_definition',index_definition,
                 'index_owner',index_owner,
                 'index_unique',indisunique,
                 'index_primary',indisprimary,
                 'index_valid',indisvalid,
                 'index_ready',indisready,
                 'index_clustered',indisclustered,
                 'index_replica_identity',indisreplident,
                 'index_immediate',indimmediate,
                 'index_check_xmin',indcheckxmin,
                 'index_live',indislive,
                 'index_nulls_not_distinct',indnullsnotdistinct,
                 'index_key_attributes',indnkeyatts,
                 'index_attributes',indnatts,
                 'index_keys',indkey,
                 'index_predicate',predicate,
                 'index_expressions',expressions)
               ORDER BY relation_name,constraint_name)
               FROM constraint_rows)
         )::text)
       END
  FROM (SELECT 1) singleton;
$fingerprint$;
SQL
}

emit_terminal_guard_fingerprint_function() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.stage_b_terminal_guard_fingerprint()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $fingerprint$
SELECT COALESCE((
  SELECT md5(to_jsonb(guard_row)::text)
    FROM (
      SELECT p.oid AS function_oid,
             pg_get_functiondef(p.oid) AS definition,
             pg_get_userbyid(p.proowner) AS owner_name,
             l.lanname AS language_name,
             p.prosecdef,
             p.provolatile,
             p.proparallel,
             p.proleakproof,
             p.prokind,
             p.proisstrict,
             p.proretset,
             p.prorettype::regtype::text AS return_type,
             p.pronargs,
             p.pronargdefaults,
             p.proconfig,
             p.proacl,
             obj_description(p.oid,'pg_proc') AS function_comment,
             tg.oid AS trigger_oid,
             pg_get_triggerdef(tg.oid,true) AS trigger_definition,
             tg.tgenabled,
             tg.tgtype,
             tg.tgattr,
             tg.tgqual::text AS trigger_when,
             tg.tgnargs,
             encode(tg.tgargs,'hex') AS trigger_arguments,
             tg.tgisinternal,
             obj_description(tg.oid,'pg_trigger') AS trigger_comment
        FROM pg_proc p
        JOIN pg_language l ON l.oid=p.prolang
        JOIN pg_trigger tg ON tg.tgfoid=p.oid
       WHERE p.oid=
             'public.fn_receipted_tournament_is_immutable()'::regprocedure
         AND tg.tgrelid='public.tournaments'::regclass
         AND tg.tgname='receipted_tournament_is_immutable'
         AND NOT tg.tgisinternal
    ) guard_row
), 'missing');
$fingerprint$;
SQL
}

emit_stage_b_cancellation_forward_correction_assertion() {
  cat <<'SQL'
DO $verify_stage_b_cancellation_forward_correction$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid=
              'public.atomic_cancel_tournament(uuid,uuid)'::regprocedure
          AND md5(p.prosrc)='16ea7acbbf76613a0a1193dff18f1330')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid=
              'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)'::regprocedure
          AND md5(p.prosrc)='1e4c6d2f87ac2068455dbff2ace3fb2e') THEN
    RAISE EXCEPTION 'STAGE_B_M1_CANCELLATION_FORWARD_CORRECTION_MISSING'
      USING ERRCODE='55000';
  END IF;
END;
$verify_stage_b_cancellation_forward_correction$;
SELECT 'STAGE_B_M1_CANCELLATION_FORWARD_CORRECTION_OK';
SQL
}

run_chain_prefix() {
  local migration_count="$1"
  local replay_keyshare="$2"
  local target_database="${3:-$expected_database}"
  local first_migration_index="${4:-0}"
  {
    printf '%s\n' '\set ON_ERROR_STOP on'
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'SELECT pg_advisory_lock_shared(530090, 1);'
    for ((index = first_migration_index; index < migration_count; index += 1)); do
      migration_file="${chain_files[$index]}"
      printf '%s\n' "\\echo APPLYING $(basename "$migration_file")"
      printf '%s\n' "\\ir '$migration_file'"
      if [[ "$index" -eq 0 ]]; then
        emit_stage_b_cancellation_forward_correction_assertion
      fi
    done
    if [[ "$replay_keyshare" == true ]]; then
      emit_keyshare_fingerprint_function
      cat <<'SQL'
CREATE TEMP TABLE stage_b_keyshare_replay_snapshot
ON COMMIT PRESERVE ROWS
AS SELECT pg_temp.stage_b_keyshare_fingerprint() AS fingerprint;
DO $verify_stage_b_keyshare_initial_postimage$
BEGIN
  IF (SELECT fingerprint
        FROM pg_temp.stage_b_keyshare_replay_snapshot)='missing' THEN
    RAISE EXCEPTION 'STAGE_B_LEASE_KEYSHARE_INITIAL_POSTIMAGE_MISSING';
  END IF;
END;
$verify_stage_b_keyshare_initial_postimage$;
SQL
      printf '%s\n' "\\echo REPLAYING $(basename "${chain_files[5]}")"
      printf '%s\n' "\\ir '${chain_files[5]}'"
      cat <<'SQL'
DO $verify_stage_b_keyshare_replay$
DECLARE
  v_before text;
  v_after text:=pg_temp.stage_b_keyshare_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_before
    FROM pg_temp.stage_b_keyshare_replay_snapshot;
  IF v_after='missing' OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'STAGE_B_LEASE_KEYSHARE_REPLAY_CHANGED_POSTIMAGE';
  END IF;
END;
$verify_stage_b_keyshare_replay$;
SELECT 'STAGE_B_LEASE_KEYSHARE_REPLAY_POSTIMAGE_EXACT';
SQL
    fi
    if [[ "$migration_count" -eq 6 ]]; then
      printf '%s\n' "DO \$verify_stage_b_forward_chain\$ BEGIN IF (SELECT count(*) FROM pg_constraint WHERE (conrelid='public.engine_table_leases'::regclass AND conname='engine_table_leases_owner_generation_key') OR (conrelid='public.engine_tournament_leases'::regclass AND conname='engine_tournament_leases_owner_generation_key')) <> 2 THEN RAISE EXCEPTION 'STAGE_B_FORWARD_CHAIN_POSTCONDITIONS_FAILED'; END IF; END \$verify_stage_b_forward_chain\$;"
      printf '%s\n' "SELECT 'STAGE_B_FORWARD_CHAIN_POSTCONDITIONS_OK';"
    fi
    printf '%s\n' 'SELECT pg_advisory_unlock_shared(530090, 1);'
  } | "${psql_cmd[@]}" --dbname="$target_database"
}

emit_stage_b_bounded_postimage_assertion() {
  cat <<'SQL'
CREATE OR REPLACE FUNCTION pg_temp.assert_stage_b_080728_control_postimage(
  p_cron_sha256 text,
  p_money_sha256 text,
  p_maintenance_sha256 text,
  p_elimination_sha256 text
)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','public','pg_temp'
AS $assert_stage_b_080728_control_postimage$
DECLARE
  v_cron_rows integer;
  v_retirement_receipts integer;
  v_retirement_exact boolean;
  v_money_rows integer;
  v_money_value text;
  v_maintenance_rows integer;
  v_maintenance_value text;
  v_elimination_rows integer;
  v_elimination_value text;
  v_eliminator_exact integer;
BEGIN
  SELECT count(*) INTO v_cron_rows
    FROM cron.job
   WHERE jobname IN ('ca-eliminate-absent-players','ca-release-broke-seats')
      OR command ILIKE '%fn_ca_eliminate_absent_tournament_players%'
      OR command ILIKE '%fn_ca_release_broke_seats%';

  SELECT count(*),COALESCE(bool_and(
           job_ids=ARRAY[364,365]::bigint[]
           AND octet_length(jobs::text)=539
           AND encode(sha256(convert_to(jobs::text,'UTF8')),'hex')=
                 p_cron_sha256),false)
    INTO v_retirement_receipts,v_retirement_exact
    FROM public.tournament_mutator_scheduler_retirement_receipts
   WHERE migration_version=
     '20260910042112_stage_b_current_postimage_contraction';
  IF v_cron_rows<>0 OR v_retirement_receipts<>1
     OR NOT v_retirement_exact THEN
    RAISE EXCEPTION
      'STAGE_B_080728_CRON_CONTROL_POSTIMAGE_INEXACT: % live rows / % exact receipts',
      v_cron_rows,v_retirement_receipts USING ERRCODE='55000';
  END IF;

  WITH objects AS (
    SELECT jsonb_build_object(
             'proname',proname,'status',status,'notes',notes,
             'added_at_utc',to_char(added_at AT TIME ZONE 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS value
      FROM public.ca_money_rpc_registry
     WHERE proname IN (
       'fn_move_tournament_player',
       'fn_poker_diamond_settle_cash_hand',
       'fn_poker_diamond_cashout')
     ORDER BY proname
  )
  SELECT count(*),COALESCE(jsonb_agg(value),'[]'::jsonb)::text
    INTO v_money_rows,v_money_value
    FROM objects;
  IF v_money_rows<>3 OR octet_length(v_money_value)<>1348
     OR encode(sha256(convert_to(v_money_value,'UTF8')),'hex')<>
          p_money_sha256 THEN
    RAISE EXCEPTION 'STAGE_B_080728_MONEY_REGISTRY_CHANGED'
      USING ERRCODE='55000';
  END IF;

  WITH objects AS (
    SELECT jsonb_build_object(
             'signature',format('%I.%I(%s)',n.nspname,p.proname,
                                pg_get_function_identity_arguments(p.oid)),
             'proconfig',COALESCE((SELECT jsonb_agg(x ORDER BY x)
                                     FROM unnest(p.proconfig) x),'[]'::jsonb))
             AS value
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE p.oid IN (
       'public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid)'::regprocedure,
       'public.fn_clear_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,uuid)'::regprocedure,
       'public.fn_claim_engine_maintenance_break(uuid,uuid,text)'::regprocedure,
       'public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text)'::regprocedure)
     ORDER BY p.proname
  )
  SELECT count(*),jsonb_agg(value)::text
    INTO v_maintenance_rows,v_maintenance_value
    FROM objects;
  IF v_maintenance_rows<>4 OR octet_length(v_maintenance_value)<>1197
     OR encode(sha256(convert_to(v_maintenance_value,'UTF8')),'hex')<>
          p_maintenance_sha256 THEN
    RAISE EXCEPTION 'STAGE_B_073818_MAINTENANCE_CONFIG_CHANGED'
      USING ERRCODE='55000';
  END IF;

  WITH f AS (
    SELECT jsonb_build_object(
             'kind','function',
             'signature','public.fn_tournament_elimination_has_a_place()',
             'owner',pg_get_userbyid(p.proowner),
             'security_definer',p.prosecdef,
             'proconfig',COALESCE((SELECT jsonb_agg(x ORDER BY x)
                                     FROM unnest(p.proconfig) x),'[]'::jsonb),
             'prosrc_md5',md5(p.prosrc),
             'functiondef_bytes',octet_length(pg_get_functiondef(p.oid)),
             'functiondef_sha256',encode(
               sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) value
      FROM pg_proc p
     WHERE p.oid=
       'public.fn_tournament_elimination_has_a_place()'::regprocedure
  ), t AS (
    SELECT jsonb_build_object(
             'kind','trigger','name',tgname,'table',tgrelid::regclass::text,
             'function',tgfoid::regprocedure::text,'enabled',tgenabled,
             'internal',tgisinternal,'deferrable',tgdeferrable,
             'initially_deferred',tginitdeferred,
             'triggerdef',pg_get_triggerdef(oid,true)) value
      FROM pg_trigger
     WHERE tgrelid='public.tournament_players'::regclass
       AND tgname='tournament_elimination_has_a_place'
  ), c AS (
    SELECT jsonb_build_object(
             'kind','constraint','name',conname,'type',contype,
             'table',conrelid::regclass::text,'deferrable',condeferrable,
             'initially_deferred',condeferred,'validated',convalidated,
             'constraintdef',pg_get_constraintdef(oid,true)) value
      FROM pg_constraint
     WHERE conrelid='public.tournament_players'::regclass
       AND conname='tournament_elimination_has_a_place'
  ), objects AS (
    SELECT value FROM f UNION ALL SELECT value FROM t UNION ALL SELECT value FROM c
  )
  SELECT count(*),jsonb_agg(value ORDER BY value->>'kind')::text
    INTO v_elimination_rows,v_elimination_value
    FROM objects;
  IF v_elimination_rows<>3 OR octet_length(v_elimination_value)<>1067
     OR encode(sha256(convert_to(v_elimination_value,'UTF8')),'hex')<>
          p_elimination_sha256 THEN
    RAISE EXCEPTION 'STAGE_B_075958_ELIMINATION_GUARD_CHANGED'
      USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_eliminator_exact
    FROM pg_proc p
   WHERE p.oid=to_regprocedure(
           'public.fn_ca_eliminate_absent_tournament_players(integer,integer,boolean)')
     AND md5(p.prosrc)='05855868cb0cbb1199049b5e0e97aa56'
     AND octet_length(pg_get_functiondef(p.oid))=7734
     AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')=
           '7cdb2c9ffc7e260c84ca02fccc66f6e6a0d3764e2f824e7617f51c7f7d6e1d59'
     AND p.proowner='postgres'::regrole AND p.prosecdef
     AND p.provolatile='v' AND p.proparallel='u'
     AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
     AND (SELECT count(*) FROM aclexplode(
            COALESCE(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.privilege_type='EXECUTE')=1
     AND (SELECT count(*) FROM aclexplode(
            COALESCE(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.grantor=p.proowner AND a.grantee=p.proowner
             AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)=1;
  IF v_eliminator_exact<>1
     OR to_regprocedure(
          'public.fn_ca_release_broke_seats(integer,integer,boolean)')
          IS NOT NULL THEN
    RAISE EXCEPTION 'STAGE_B_072322_ABSENT_MUTATOR_POSTIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF to_regclass('public.hand_projection_outbox') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_publication
                     WHERE pubname='supabase_realtime')
     OR EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname='supabase_realtime'
                   AND schemaname='public'
                   AND tablename='hand_projection_outbox') THEN
    RAISE EXCEPTION 'STAGE_B_080137_OUTBOX_PUBLICATION_MEMBERSHIP_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_class c
        WHERE c.oid='public.tournament_final_table_deal_batches'::regclass
          AND c.relowner='postgres'::regrole
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity
          AND c.relacl::text=
              '{postgres=arwdDxtm/postgres,service_role=r/postgres}'
     ) THEN
    RAISE EXCEPTION 'STAGE_B_11050554_TABLE_CATALOG_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF (
    SELECT count(*)
      FROM (VALUES
        ('public.fn_complete_tournament_terminal(uuid,uuid,text)',
         '96a61ea5e16560735bcb70b355aa79ab','480be3139fe0878e637ce54f533a2170',
         ARRAY['search_path=public, pg_temp','statement_timeout=45s']::text[],true,'jsonb',0),
        ('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)',
         '90f7506df2f1a94fe22952714fcd9f85','8397b4f24c6d1a072d7b2d946f45e3d6',
         ARRAY['search_path=public','statement_timeout=45s']::text[],false,'jsonb',0),
        ('public.fn_ca_tournament_terminal_receipt(uuid,uuid)',
         'bb4b0e1d1c758943fca29f9a83d064e4','185dcb02134aa1f1fd2d87cdddbcfd26',
         ARRAY['search_path=public','statement_timeout=30s']::text[],false,'jsonb',1),
        ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)',
         '260c94b41d7f2bb021a88a546a1714ac','cb81d2c33985e46bd56dc3c4f1320e67',
         ARRAY['search_path=public, pg_temp']::text[],false,'jsonb',1),
        ('public.fn_guard_tournament_completing_claim()',
         '82078938fd926c94a0ab778acd77dd61','311ed77e7726f0c7515859a9140d526c',
         ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
        ('public.trg_tournament_atomic_place_completion_guard()',
         '3e43d26ddd36a55e736a9a304a89ba9a','18cf8159e315f322ac7cc09e1f913671',
         ARRAY['search_path=public']::text[],true,'trigger',0),
        ('public.trg_lock_atomic_final_table_deal_status()',
         'ddc5e3121ed9cc73d41525e6c1ba6c34','b16256830158e669defcff8751cb5be7',
         ARRAY['search_path=public']::text[],true,'trigger',0),
        ('public.fn_guard_tournament_completed_certificate()',
         '8e0d121a711f6b7afade68125d032f8d','0a3e3ba2dc6c6e09ddef561e93e67b7d',
         ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
        ('public.trg_freeze_canonical_final_deal_batch()',
         '80362aed787137219432f6039bf03158','c5bbfca7dcc4aedc286c4004f5f5d2c1',
         ARRAY['search_path=public, pg_temp']::text[],false,'trigger',0),
        ('public.fn_settle_tournament_final_table_deal(uuid)',
         'b1941b2e55dade307ecd74068ab3e500','c7bee6802ab30d625c32503a4d6609e1',
         ARRAY['search_path=public','statement_timeout=30s']::text[],false,'jsonb',0),
        ('public.trg_atomic_final_table_deal_completion_guard()',
         '9f5f5fefa77ae93bfeffc9f414a63a0d','38bf96ba348994fd40264584c26107d8',
         ARRAY['search_path=public']::text[],true,'trigger',0),
        ('public.trg_freeze_atomic_final_table_deal_obligation()',
         'd338c5278ef1247ff0f4a7c4ba774cc5','237168031dfb0fb80bdaa8ff15f25172',
         ARRAY['search_path=public']::text[],true,'trigger',0),
        ('public.fn_tournament_finish_readiness(uuid,uuid)',
         '993e6e1de9edba2fe235d86ff6c243c9','6361f556eac2ff2940e3f49f485176d0',
         ARRAY['search_path=public, pg_temp']::text[],false,'jsonb',0),
        ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
         '3585ddbfdb0a197243d5e6eefb6b670f','f676b2cbb361896dfa61f7e5f9413f46',
         ARRAY['search_path=public']::text[],false,'jsonb',0),
        ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
         'f1fc7a0bf480b1034f0f1d9cba3b4d0b','6bbb0ff983fc61c9f8c18cc2201e0f93',
         ARRAY['search_path=public']::text[],false,'jsonb',0),
        ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
         '852e35483b67c1fc59b6347b51c79cb8','3437a8e83051385947c6b48e7c399a90',
         ARRAY['search_path=public']::text[],false,'jsonb',0)
      ) expected(
        identity,source_md5,definition_md5,configuration,service_execute,
        return_type,argdefaults
      )
      JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
      JOIN pg_language l ON l.oid=p.prolang
     WHERE md5(p.prosrc)=expected.source_md5
       AND md5(pg_get_functiondef(p.oid))=expected.definition_md5
       AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
       AND p.prosecdef AND p.prokind='f'
       AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset
       AND p.provolatile=CASE WHEN expected.identity=
             'public.fn_ca_tournament_terminal_receipt(uuid,uuid)'
             THEN 's'::"char" ELSE 'v'::"char" END
       AND p.proparallel='u'
       AND p.prorettype=to_regtype(expected.return_type)
       AND p.pronargdefaults=expected.argdefaults
       AND p.proconfig=expected.configuration
       AND p.proacl::text=CASE WHEN expected.service_execute
             THEN '{postgres=X/postgres,service_role=X/postgres}'
             ELSE '{postgres=X/postgres}' END
  )<>16 THEN
    RAISE EXCEPTION 'STAGE_B_11050554_FUNCTION_DEFINITIONS_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=
              'public.fn_guard_tournament_completed_certificate()'::regprocedure
          AND md5(p.prosrc)='8e0d121a711f6b7afade68125d032f8d'
          AND md5(pg_get_functiondef(p.oid))=
              '0a3e3ba2dc6c6e09ddef561e93e67b7d'
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='trigger'::regtype
          AND p.pronargs=0 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
          AND p.proacl::text='{postgres=X/postgres}')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=
              'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure
          AND md5(p.prosrc)='96a61ea5e16560735bcb70b355aa79ab'
          AND md5(pg_get_functiondef(p.oid))=
              '480be3139fe0878e637ce54f533a2170'
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=3 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY[
                'search_path=public, pg_temp','statement_timeout=45s']::text[]
          AND p.proacl::text=
                '{postgres=X/postgres,service_role=X/postgres}')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=
              'public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure
          AND md5(p.prosrc)='b1941b2e55dade307ecd74068ab3e500'
          AND md5(pg_get_functiondef(p.oid))=
              'c7bee6802ab30d625c32503a4d6609e1'
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=1 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY[
                'search_path=public','statement_timeout=30s']::text[]
          AND p.proacl::text='{postgres=X/postgres}')
     OR (
       SELECT count(*)
         FROM (VALUES
           ('public.trg_freeze_canonical_final_deal_batch()',
            '80362aed787137219432f6039bf03158',
            'c5bbfca7dcc4aedc286c4004f5f5d2c1',
            ARRAY['search_path=public, pg_temp']::text[],
            '{postgres=X/postgres}'),
           ('public.trg_freeze_atomic_final_table_deal_obligation()',
            'd338c5278ef1247ff0f4a7c4ba774cc5',
            '237168031dfb0fb80bdaa8ff15f25172',
            ARRAY['search_path=public']::text[],
            '{postgres=X/postgres,service_role=X/postgres}'),
           ('public.trg_lock_atomic_final_table_deal_status()',
            'ddc5e3121ed9cc73d41525e6c1ba6c34',
            'b16256830158e669defcff8751cb5be7',
            ARRAY['search_path=public']::text[],
            '{postgres=X/postgres,service_role=X/postgres}')
         ) expected(identity,source_md5,definition_md5,configuration,acl_text)
         JOIN pg_proc p ON p.oid=to_regprocedure(expected.identity)
         JOIN pg_language l ON l.oid=p.prolang
        WHERE md5(p.prosrc)=expected.source_md5
          AND md5(pg_get_functiondef(p.oid))=expected.definition_md5
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='trigger'::regtype
          AND p.pronargs=0 AND p.pronargdefaults=0
          AND p.proconfig=expected.configuration
          AND p.proacl::text=expected.acl_text
     )<>3
     OR (
       SELECT count(*)
         FROM (VALUES
           ('public.tournament_final_table_deal_batches',
            'zzzz_freeze_canonical_final_deal_batch',
            'public.trg_freeze_canonical_final_deal_batch()',27,'',
            '2d79c256ecf4e44b0bb51686b824807e',NULL::text),
           ('public.tournament_obligations',
            'zzzzz_freeze_atomic_final_table_deal_obligation',
            'public.trg_freeze_atomic_final_table_deal_obligation()',31,'',
            'c9aebd8de7e6e5fef9b0c9fd3da7dc81',NULL::text),
           ('public.tournaments','zzzzy_lock_atomic_final_table_deal_status',
            'public.trg_lock_atomic_final_table_deal_status()',19,'10',
            '5781f6fe63ae275fa12c4dcda74ffc6b',
            '50d33071dd4fa3af7b6afd7b598949a6')
         ) expected(
           relation_name,trigger_name,function_identity,trigger_type,
           trigger_attribute,definition_md5,when_md5
         )
         JOIN pg_trigger tg
           ON tg.tgrelid=to_regclass(expected.relation_name)
          AND tg.tgname=expected.trigger_name
        WHERE tg.tgfoid=to_regprocedure(expected.function_identity)
          AND md5(pg_get_triggerdef(tg.oid,true))=expected.definition_md5
          AND tg.tgenabled='O' AND tg.tgtype=expected.trigger_type
          AND tg.tgattr::text=expected.trigger_attribute
          AND md5(tg.tgqual::text) IS NOT DISTINCT FROM expected.when_md5
          AND tg.tgnargs=0 AND octet_length(tg.tgargs)=0
          AND NOT tg.tgisinternal AND NOT tg.tgdeferrable
          AND NOT tg.tginitdeferred
     )<>3 THEN
    RAISE EXCEPTION 'STAGE_B_11050554_COMPOSED_POSTIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=
              'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure
          AND md5(p.prosrc)='607e4daf9060a1176e032016b8879808'
          AND md5(pg_get_functiondef(p.oid))=
              'a6adf208eae8476128f197c16f83d6c5'
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=7 AND p.pronargdefaults=2
          AND p.proconfig=ARRAY[
                'search_path=public, pg_temp','statement_timeout=30s']::text[]
          AND p.proacl::text=
                '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
        WHERE p.oid=to_regprocedure(
              'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)')
          AND md5(p.prosrc)='f793ed628fe609fe9fe2aa30a76bc4c7'
          AND md5(pg_get_functiondef(p.oid))=
              '0286145366f00c7cad0a996f05630851'
          AND p.proowner='postgres'::regrole AND l.lanname='plpgsql'
          AND p.prosecdef AND p.provolatile='v' AND p.proparallel='u'
          AND NOT p.proisstrict AND NOT p.proleakproof
          AND p.prokind='f' AND NOT p.proretset
          AND p.prorettype='jsonb'::regtype
          AND p.pronargs=3 AND p.pronargdefaults=0
          AND p.proconfig=ARRAY[
                'search_path=public, pg_temp','statement_timeout=30s']::text[]
          AND p.proacl::text='{postgres=X/postgres}')
     OR (SELECT count(*) FROM public.ca_settle_sources
          WHERE source='fn_collect_bounty'
            AND note='Exact-generation fixed and PKO bounty payer used by the atomic live authority.')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_11052648_BOUNTY_REBUY_POSTIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF (
    SELECT count(*)
      FROM (VALUES
        ('aaa_guard_atomic_satellite_completion',
         'public.trg_guard_atomic_satellite_completion()',
         'e7bdddc429922d39b1db20916a442351','10',NULL::text),
        ('zzzz_tournaments_atomic_place_completion_guard',
         'public.trg_tournament_atomic_place_completion_guard()',
         '481ecc9520193a0ba670e1a7f2eddb41','',
         'cc90af9b34abd78a5892ac074e6d1057'),
        ('zzzzz_tournaments_atomic_final_table_deal_completion_guard',
         'public.trg_atomic_final_table_deal_completion_guard()',
         '79b2ecea0a7e0f1b4946436eb1404623','10',
         'cc90af9b34abd78a5892ac074e6d1057'),
        ('aa_guard_tournament_completing_claim',
         'public.fn_guard_tournament_completing_claim()',
         'd068b2ee511bad5e75dae19a424dde87','10',NULL::text),
        ('zzzzzz_tournaments_financial_certificate',
         'public.fn_guard_tournament_completed_certificate()',
         'cd94d89d898acd094eeb1dccc1a0a296','10',
         'cc90af9b34abd78a5892ac074e6d1057'),
        ('zzzz_tournament_pool_finalization_window_guard',
         'public.trg_tournament_pool_finalization_window_guard()',
         'd79234029c6246e6431c8f6907ac935c','51',NULL::text),
        ('zzzz_freeze_finalized_tournament_prize_pool',
         'public.trg_freeze_finalized_tournament_prize_pool()',
         'f75ff7a6ad7952e4ca090cde1516615c','23 8 51 16 49',NULL::text)
      ) expected(
        trigger_name,function_identity,definition_md5,trigger_attribute,when_md5
      )
      JOIN pg_trigger tg
        ON tg.tgrelid='public.tournaments'::regclass
       AND tg.tgname=expected.trigger_name
     WHERE tg.tgfoid=to_regprocedure(expected.function_identity)
       AND md5(pg_get_triggerdef(tg.oid,true))=expected.definition_md5
       AND tg.tgenabled='O' AND tg.tgtype=19
       AND tg.tgattr::text=expected.trigger_attribute
       AND md5(tg.tgqual::text) IS NOT DISTINCT FROM expected.when_md5
       AND tg.tgnargs=0
       AND octet_length(tg.tgargs)=0
       AND NOT tg.tgisinternal AND NOT tg.tgdeferrable
       AND NOT tg.tginitdeferred
  )<>7 THEN
    RAISE EXCEPTION 'STAGE_B_SEVEN_SETTLEMENT_TRIGGER_POSTIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid=to_regprocedure(
              'public.atomic_cancel_tournament_pre_seat_guard(uuid,uuid)')
          AND md5(p.prosrc)='16ea7acbbf76613a0a1193dff18f1330')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_proc p
        WHERE p.oid=to_regprocedure(
              'public.fn_ca_tournament_cancellation_receipt(uuid,uuid)')
          AND md5(p.prosrc)='1e4c6d2f87ac2068455dbff2ace3fb2e') THEN
    RAISE EXCEPTION
      'STAGE_B_CANCELLATION_FORWARD_CORRECTION_POSTIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;

  RETURN 'STAGE_B_080728_CONTROL_POSTIMAGE_OK';
END;
$assert_stage_b_080728_control_postimage$;
SQL
}

assert_stage_b_bounded_postimage() {
  local database="$1"
  local wheel_welcome_catalog_after
  wheel_welcome_catalog_after="$(wheel_welcome_catalog_fingerprint "$database")"
  if [[ "$wheel_welcome_catalog_after" != "$wheel_welcome_catalog_before" ]]; then
    echo 'Stage B changed the full 11052216 wheel welcome-spin catalog.' >&2
    return 1
  fi
  echo 'STAGE_B_11052216_WHEEL_CATALOG_PRESERVED'
  {
    emit_stage_b_bounded_postimage_assertion
    printf '%s\n' \
      "SELECT pg_temp.assert_stage_b_080728_control_postimage(:'cron_control_sha256',:'money_control_sha256',:'maintenance_proconfigs_sha256',:'elimination_guard_sha256');"
  } | "${psql_cmd[@]}" --dbname="$database" -Atq
}

prepare_current_postimage_template() {
  local database="$1"
  local fixture_log=''
  local required_marker

  if ! fixture_log="$({
    printf '%s\n' '\set ON_ERROR_STOP on'
    printf '%s\n' '\set VERBOSITY verbose'
    printf '%s\n' 'SELECT pg_advisory_lock_shared(530090, 1);'
    for ((index = 0; index < 5; index += 1)); do
      migration_file="${chain_files[$index]}"
      printf '%s\n' "\\echo APPLYING $(basename "$migration_file")"
      printf '%s\n' "\\ir '$migration_file'"
      if [[ "$index" -eq 0 ]]; then
        emit_stage_b_cancellation_forward_correction_assertion
      fi
    done
    emit_stage_b_bounded_postimage_assertion
    printf '%s\n' \
      "SELECT pg_temp.assert_stage_b_080728_control_postimage(:'cron_control_sha256',:'money_control_sha256',:'maintenance_proconfigs_sha256',:'elimination_guard_sha256');"
    printf '%s\n' "\\echo RUNNING $(basename "$diamond_fixture")"
    printf '%s\n' "\\ir '$diamond_fixture'"
    cat <<'SQL'
DO $require_diamond_fixture_fingerprint$
BEGIN
  IF to_regprocedure('pg_temp.stage_b_diamond_current_schema_fingerprint()') IS NULL
     OR pg_temp.stage_b_diamond_current_schema_fingerprint() IS NULL THEN
    RAISE EXCEPTION 'STAGE_B_DIAMOND_FIXTURE_FINGERPRINT_INTERFACE_MISSING';
  END IF;
END;
$require_diamond_fixture_fingerprint$;
SELECT pg_temp.assert_stage_b_080728_control_postimage(
  :'cron_control_sha256',:'money_control_sha256',
  :'maintenance_proconfigs_sha256',:'elimination_guard_sha256');
SELECT pg_advisory_unlock_shared(530090, 1);
SQL
  } | "${psql_cmd[@]}" --dbname="$database" 2>&1)"; then
    printf '%s\n' "$fixture_log" >&2
    echo 'The current-schema Diamond accepted-hand rehearsal failed.' >&2
    return 1
  fi
  printf '%s\n' "$fixture_log"
  for required_marker in \
    STAGE_B_DIAMOND_ACCEPTED_HAND_SUCCESS_REPLAY_ROLLBACK_OK \
    STAGE_B_DIAMOND_ACCEPTED_HAND_CURRENT_SCHEMA_OK \
    STAGE_B_080728_CONTROL_POSTIMAGE_OK; do
    if ! grep -Fq "$required_marker" <<<"$fixture_log"; then
      echo "The current-schema fixture did not emit required marker ${required_marker}." >&2
      return 1
    fi
  done
}

keyshare_postimage_fingerprint() {
  local database="${1:-$expected_database}"
  {
    emit_keyshare_fingerprint_function
    printf '%s\n' 'SELECT pg_temp.stage_b_keyshare_fingerprint();'
  } | "${psql_cmd[@]}" --dbname="$database" -Atq
}

terminal_guard_fingerprint() {
  local database="$1"
  {
    emit_terminal_guard_fingerprint_function
    printf '%s\n' 'SELECT pg_temp.stage_b_terminal_guard_fingerprint();'
  } | "${psql_cmd[@]}" --dbname="$database" -Atq
}

scenario_databases=()
created_scenario_database=''
scenario_template_database=''
postgrest_role_setting_normalized=false

restore_dump_lost_postgrest_role_setting() {
  if [[ "$postgrest_role_setting_normalized" != true ]]; then
    return 0
  fi

  if ! "${psql_cmd[@]}" --dbname="$expected_database" -q <<'SQL'
BEGIN;
ALTER ROLE authenticator RESET pgrst.db_pre_request;
DO $verify_dump_lost_postgrest_role_setting_restored$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid=s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig,'{}'::text[])) setting(value)
     WHERE r.rolname='authenticator'
       AND setting.value LIKE 'pgrst.db_pre_request=%'
  ) THEN
    RAISE EXCEPTION 'STAGE_B_DUMP_ROLE_SETTING_RESTORE_FAILED'
      USING ERRCODE='55000';
  END IF;
END;
$verify_dump_lost_postgrest_role_setting_restored$;
COMMIT;
SQL
  then
    echo 'Could not restore the disposable cluster authenticator role setting.' >&2
    return 1
  fi
  postgrest_role_setting_normalized=false
  echo 'STAGE_B_DUMP_ROLE_SETTING_RESTORED'
}

cleanup_scenario_databases() {
  local original_status=$?
  local cleanup_database
  local cleanup_failed=false
  if ! restore_dump_lost_postgrest_role_setting; then
    cleanup_failed=true
  fi
  for cleanup_database in "${scenario_databases[@]}"; do
    if ! "${pg17_bin}/dropdb" \
      --maintenance-db="$expected_database" \
      --if-exists "$cleanup_database" >/dev/null; then
      printf 'Could not remove disposable scenario database %s.\n' \
        "$cleanup_database" >&2
      cleanup_failed=true
    fi
  done
  if [[ "$cleanup_failed" == true ]]; then
    trap - EXIT
    if [[ "$original_status" -ne 0 ]]; then
      exit "$original_status"
    fi
    exit 1
  fi
  return "$original_status"
}

create_scenario_database() {
  local scenario_kind="$1"
  local template_database="${2:-${scenario_template_database:-$expected_database}}"
  created_scenario_database="stageb_${scenario_kind}_$$_${RANDOM}"
  if [[ ! "$created_scenario_database" =~ ^[a-z0-9_]+$ ]] \
     || [[ "${#created_scenario_database}" -gt 63 ]]; then
    echo 'Generated an unsafe PostgreSQL scenario database name.' >&2
    exit 65
  fi
  "${pg17_bin}/createdb" \
    --maintenance-db="$expected_database" \
    --template="$template_database" \
    "$created_scenario_database"
  scenario_databases+=("$created_scenario_database")
  printf 'STAGE_B_SCENARIO_DATABASE_CREATED %s\n' "$created_scenario_database"
}

assert_current_live_tail() {
  local database="$1"
  local receipt_count
  receipt_count="$("${psql_cmd[@]}" --dbname="$database" -Atq <<'SQL'
WITH expected(version,name,statement_bytes,statement_sha256) AS (
  VALUES
    ('20260911062048','a_bust_is_ranked_by_when_it_happened',150688,
     'd2d0acba73031ed8617a243840eecea0e0e227a6dce5a78ce3ce2bfcfb79cf73'),
    ('20260911094503','a_bust_belongs_to_the_phase_its_hand_was_played_in',17270,
     '0d620bf6061213e0ef0362126fde1e3e2feddc7b13720fa74727ad80da5fd570'),
    ('20260911110907','a_satellite_never_feeds_a_target_its_finish_refuses',7971,
     'fcbbe600573494b1402cb2c10d8179534d1845ace630a921e25c5df68f589b33'),
    ('20260911112409','persist_eligible_free_buy_creation_options',3281,
     'e16b3a057460833cd74c7a2da612df8b2c5269e156a7cc7b8116679d7fb6b24a')
), matched AS (
  SELECT expected.version,
         count(m.*) AS matching_rows,
         count(m.*) FILTER (
           WHERE cardinality(m.statements)=1
             AND octet_length(m.statements[1])=expected.statement_bytes
             AND encode(extensions.digest(
                   convert_to(m.statements[1],'UTF8'),'sha256'),'hex')=
                 expected.statement_sha256
         ) AS exact_rows
    FROM expected
    LEFT JOIN supabase_migrations.schema_migrations m
      ON m.version=expected.version AND m.name=expected.name
   GROUP BY expected.version
)
SELECT count(*) FROM matched WHERE matching_rows=1 AND exact_rows=1;
SQL
)"
  if [[ "$receipt_count" != '4' ]]; then
    echo "The disposable clone does not hold all four exact current live-tail receipts: ${receipt_count:-0}/4." >&2
    return 1
  fi
  echo 'STAGE_B_CURRENT_PRODUCTION_PREIMAGE_COMPOSED'
}

compose_current_live_tail() {
  local database="$1"
  local existing index statement_hex
  existing="$("${psql_cmd[@]}" --dbname="$database" -Atq <<'SQL'
SELECT count(*)
  FROM supabase_migrations.schema_migrations m
 WHERE m.version IN (
         '20260911062048','20260911094503','20260911110907','20260911112409')
    OR m.name IN (
         'a_bust_is_ranked_by_when_it_happened',
         'a_bust_belongs_to_the_phase_its_hand_was_played_in',
         'a_satellite_never_feeds_a_target_its_finish_refuses',
         'persist_eligible_free_buy_creation_options');
SQL
)"
  if [[ "$existing" != '0' ]]; then
    echo "The normalized donor clone already contains ${existing:-unknown} current live-tail receipt(s)." >&2
    return 1
  fi

  for ((index = 0; index < ${#current_live_tail_files[@]}; index += 1)); do
    statement_hex="$(od -An -v -tx1 "${current_live_tail_files[$index]}" | tr -d '[:space:]')"
    if [[ "${#statement_hex}" -ne $((current_live_tail_bytes[index] * 2)) ]]; then
      echo "Could not encode exact current live-tail source: ${current_live_tail_files[$index]}." >&2
      return 1
    fi
    {
      printf '%s\n' '\set ON_ERROR_STOP on'
      printf '%s\n' "\\echo COMPOSING $(basename "${current_live_tail_files[$index]}")"
      printf '%s\n' "\\ir '${current_live_tail_files[$index]}'"
      cat <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES (
  :'current_tail_version',
  :'current_tail_name',
  ARRAY[convert_from(decode(:'current_tail_statement_hex','hex'),'UTF8')]
);
SQL
    } | "${psql_cmd[@]}" --dbname="$database" \
          -v "current_tail_version=${current_live_tail_versions[$index]}" \
          -v "current_tail_name=${current_live_tail_names[$index]}" \
          -v "current_tail_statement_hex=${statement_hex}"
  done
  assert_current_live_tail "$database"
}

normalize_dump_lost_postgrest_role_setting() {
  local setting_state
  setting_state="$("${psql_cmd[@]}" --dbname="$expected_database" -Atq -F '|' <<'SQL'
WITH settings AS (
  SELECT s.setdatabase,setting.value
    FROM pg_db_role_setting s
    JOIN pg_roles r ON r.oid=s.setrole
    CROSS JOIN LATERAL unnest(COALESCE(s.setconfig,'{}'::text[])) setting(value)
   WHERE r.rolname='authenticator'
     AND setting.value LIKE 'pgrst.db_pre_request=%'
), ledger AS (
  SELECT count(*) AS exact_rows
    FROM supabase_migrations.schema_migrations m
   WHERE m.version='20260908125958'
     AND m.name='tournament_manager_requests_carry_lease_authority'
     AND cardinality(m.statements)=1
     AND encode(
           extensions.digest(array_to_string(m.statements,E'\x1e'),'sha256'),
           'hex'
         )=:'manager_request_authority_statement_sha256'
)
SELECT (SELECT count(*) FROM settings),
       (SELECT count(*) FROM settings
         WHERE setdatabase=0
           AND value=
             'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request'),
       (SELECT exact_rows FROM ledger);
SQL
)"

  case "$setting_state" in
    '1|1|1')
      echo 'STAGE_B_POSTGREST_ROLE_SETTING_ALREADY_EXACT'
      return 0
      ;;
    '0|0|1') ;;
    *)
      echo "The disposable cluster has an unauthenticated PostgREST role-setting preimage: ${setting_state:-<missing>}." >&2
      return 1
      ;;
  esac

  "${psql_cmd[@]}" --dbname="$expected_database" -q <<'SQL'
BEGIN;
DO $authenticate_dump_lost_postgrest_role_setting$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_db_role_setting s
      JOIN pg_roles r ON r.oid=s.setrole
      CROSS JOIN LATERAL unnest(COALESCE(s.setconfig,'{}'::text[])) setting(value)
     WHERE r.rolname='authenticator'
       AND setting.value LIKE 'pgrst.db_pre_request=%'
  ) THEN
    RAISE EXCEPTION 'STAGE_B_DUMP_ROLE_SETTING_PREIMAGE_CHANGED'
      USING ERRCODE='55000';
  END IF;
END;
$authenticate_dump_lost_postgrest_role_setting$;

ALTER ROLE authenticator
  SET pgrst.db_pre_request =
    'smarter_private.fn_smarter_data_api_pre_request';

DO $verify_dump_lost_postgrest_role_setting$
BEGIN
  IF (SELECT count(*)
        FROM pg_db_role_setting s
        JOIN pg_roles r ON r.oid=s.setrole
        CROSS JOIN LATERAL unnest(COALESCE(s.setconfig,'{}'::text[])) setting(value)
       WHERE r.rolname='authenticator'
         AND s.setdatabase=0
         AND setting.value=
           'pgrst.db_pre_request=smarter_private.fn_smarter_data_api_pre_request')<>1
     OR (SELECT count(*)
           FROM pg_db_role_setting s
           JOIN pg_roles r ON r.oid=s.setrole
           CROSS JOIN LATERAL unnest(COALESCE(s.setconfig,'{}'::text[])) setting(value)
          WHERE r.rolname='authenticator'
            AND setting.value LIKE 'pgrst.db_pre_request=%')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_DUMP_ROLE_SETTING_NORMALIZATION_FAILED'
      USING ERRCODE='55000';
  END IF;
END;
$verify_dump_lost_postgrest_role_setting$;
COMMIT;
SQL
  postgrest_role_setting_normalized=true
  echo 'STAGE_B_DUMP_ROLE_SETTING_NORMALIZED'
}

normalize_dump_lost_hotfix_owner_acl() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.stage_b_hotfix_table_catalog_fingerprint(
  p_relation regclass,
  p_normalize_owner_acl boolean
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog','public','pg_temp'
AS $stage_b_hotfix_table_catalog_fingerprint$
  SELECT md5(jsonb_build_object(
           'shape',(
             SELECT jsonb_agg(
                      a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
                      CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END
                      ORDER BY a.attnum)
               FROM pg_attribute a
              WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
           'constraints',(
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'type',k.contype::text,
                        'def',pg_get_constraintdef(k.oid,true),
                        'validated',k.convalidated,
                        'deferrable',k.condeferrable,
                        'deferred',k.condeferred,
                        'no_inherit',k.connoinherit,
                        'index_valid',i.indisvalid,
                        'index_ready',i.indisready)
                      ORDER BY k.contype::text||':'||
                               pg_get_constraintdef(k.oid,true))
               FROM pg_constraint k
               LEFT JOIN pg_index i ON i.indexrelid=NULLIF(k.conindid,0)
              WHERE k.conrelid=c.oid),
           'rls',c.relrowsecurity,
           'force_rls',c.relforcerowsecurity,
           'owner',c.relowner::regrole::text,
           'acl',CASE WHEN p_normalize_owner_acl
                      THEN '{postgres=arwdDxtm/postgres}'::text
                      ELSE c.relacl::text END,
           'policy_count',(
             SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)
         )::text)
    FROM pg_class c
   WHERE c.oid=p_relation;
$stage_b_hotfix_table_catalog_fingerprint$;

DO $authenticate_dump_lost_hotfix_owner_acl$
DECLARE
  v_relation text;
  v_expected text;
  v_acl text;
BEGIN
  IF (SELECT count(*)
        FROM supabase_migrations.schema_migrations m
       WHERE m.version='20260910051447'
         AND m.name='the_seat_move_door_the_engine_calls_exists'
         AND cardinality(m.statements)=1
         AND encode(extensions.digest(m.statements[1],'sha256'),'hex')=
               'b3f1bb62152627444b33c82b806c00ba3587aeebbe3d13800faf69fae7809ea2')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_ACL_NORMALIZATION_LEDGER_PREIMAGE_DRIFTED'
      USING ERRCODE='55000';
  END IF;

  FOR v_relation,v_expected IN
    SELECT * FROM (VALUES
      ('public.tournament_seat_exit_authorizations',
       '556029bd3b99e8bb0ef36db2a28ed862'),
      ('public.tournament_seat_move_receipts',
       'd13f29c5d5a781fe2a7f834673ecc820')
    ) expected(relation_name,fingerprint)
  LOOP
    IF to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'STAGE_B_ACL_NORMALIZATION_RELATION_MISSING: %',v_relation
        USING ERRCODE='55000';
    END IF;
    SELECT c.relacl::text INTO v_acl
      FROM pg_class c WHERE c.oid=to_regclass(v_relation);
    IF v_acl IS NOT NULL
       AND v_acl<>'{postgres=arwdDxtm/postgres}' THEN
      RAISE EXCEPTION 'STAGE_B_ACL_NORMALIZATION_UNKNOWN_PREIMAGE: %=%',
        v_relation,v_acl USING ERRCODE='55000';
    END IF;
    IF pg_temp.stage_b_hotfix_table_catalog_fingerprint(
         to_regclass(v_relation),true)<>v_expected THEN
      RAISE EXCEPTION 'STAGE_B_ACL_NORMALIZATION_NON_ACL_CATALOG_DRIFTED: %',
        v_relation USING ERRCODE='55000';
    END IF;
  END LOOP;

END;
$authenticate_dump_lost_hotfix_owner_acl$;

GRANT ALL PRIVILEGES ON TABLE
  public.tournament_seat_exit_authorizations,
  public.tournament_seat_move_receipts
TO postgres;

DO $verify_normalized_hotfix_owner_acl$
DECLARE
  v_relation text;
  v_expected text;
BEGIN
  FOR v_relation,v_expected IN
    SELECT * FROM (VALUES
      ('public.tournament_seat_exit_authorizations',
       '556029bd3b99e8bb0ef36db2a28ed862'),
      ('public.tournament_seat_move_receipts',
       'd13f29c5d5a781fe2a7f834673ecc820')
    ) expected(relation_name,fingerprint)
  LOOP
    IF (SELECT c.relacl::text FROM pg_class c
         WHERE c.oid=to_regclass(v_relation))<>
           '{postgres=arwdDxtm/postgres}'
       OR pg_temp.stage_b_hotfix_table_catalog_fingerprint(
            to_regclass(v_relation),false)<>v_expected THEN
      RAISE EXCEPTION 'STAGE_B_ACL_NORMALIZATION_FAILED: %',v_relation
        USING ERRCODE='55000';
    END IF;
  END LOOP;
END;
$verify_normalized_hotfix_owner_acl$;
COMMIT;
SQL
  echo "STAGE_B_DUMP_OWNER_ACL_NORMALIZED ${database}"
}

seed_synthetic_freeze() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
BEGIN;
DELETE FROM public.engine_maintenance_break;
INSERT INTO public.engine_maintenance_break(
  id,phase,announced_at,break_started_at,enforce_freeze,break_ends_at,
  reason,declared_by,ownership_token,updated_at
)
SELECT true,'counting_down',seeded.at,seeded.at,true,
       seeded.at+interval '10 minutes','Stage B PG17 Rehearsal',
       'stage-b-forward-chain-pg17',
       '72000000-0000-4000-8000-000000000001',seeded.at
  FROM (SELECT statement_timestamp() AS at) seeded;
DO $verify_synthetic_freeze$
BEGIN
  IF (SELECT count(*) FROM public.engine_maintenance_break
       WHERE id AND enforce_freeze AND phase='counting_down')<>1
     OR NOT public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'STAGE_B_SYNTHETIC_FREEZE_NOT_AUTHORITATIVE';
  END IF;
  IF (SELECT count(*) FROM public.engine_leader
       WHERE heartbeat_at>=clock_timestamp()-interval '30 seconds')
     + (SELECT count(*) FROM public.engine_table_leases
         WHERE heartbeat_at>=clock_timestamp()-interval '30 seconds')
     + (SELECT count(*) FROM public.engine_tournament_leases
         WHERE heartbeat_at>=clock_timestamp()-interval '30 seconds')<>0 THEN
    RAISE EXCEPTION 'STAGE_B_SYNTHETIC_FREEZE_HAS_FRESH_ENGINE_AUTHORITY';
  END IF;
END;
$verify_synthetic_freeze$;
COMMIT;
SQL
  echo "STAGE_B_SYNTHETIC_FREEZE_READY ${database}"
}

seed_unrelated_later_receipt() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,statements,name)
VALUES (
  '29991231235959',
  ARRAY['-- disposable Stage-B rehearsal receipt; no schema effect'],
  'stage_b_rehearsal_unrelated_later_receipt'
);
DO $verify_unrelated_later_receipt$
BEGIN
  IF (SELECT count(*)
        FROM supabase_migrations.schema_migrations
       WHERE version='29991231235959'
         AND name='stage_b_rehearsal_unrelated_later_receipt'
         AND statements=ARRAY[
           '-- disposable Stage-B rehearsal receipt; no schema effect'
         ]::text[])<>1 THEN
    RAISE EXCEPTION 'STAGE_B_UNRELATED_LATER_RECEIPT_NOT_EXACT';
  END IF;
END;
$verify_unrelated_later_receipt$;
SQL
  echo "STAGE_B_UNRELATED_LATER_RECEIPT_READY ${database}"
}

assert_unrelated_later_receipt_survived() {
  local database="$1"
  local exact_receipts
  exact_receipts="$({
    "${psql_cmd[@]}" --dbname="$database" -Atq <<'SQL'
SELECT count(*)
  FROM supabase_migrations.schema_migrations
 WHERE version='29991231235959'
   AND name='stage_b_rehearsal_unrelated_later_receipt'
   AND statements=ARRAY[
     '-- disposable Stage-B rehearsal receipt; no schema effect'
   ]::text[];
SQL
  })"
  if [[ "$exact_receipts" != '1' ]]; then
    echo 'Stage-B changed or removed the unrelated later ledger receipt.' >&2
    return 1
  fi
  echo 'STAGE_B_UNRELATED_LATER_RECEIPT_ACCEPTED'
}

seed_hotfix_move_receipt() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
SET session_replication_role=replica;
INSERT INTO auth.users(id)
VALUES ('71000000-0000-0000-0000-000000000001');
INSERT INTO public.profiles(id)
VALUES ('71000000-0000-0000-0000-000000000001');
INSERT INTO public.clubs(id,name,owner_id,slug,code)
VALUES (
  '71000000-0000-0000-0000-000000000002',
  'Stage-B PG17 fixture club',
  '71000000-0000-0000-0000-000000000001',
  'stage-b-pg17-fixture-club','SBP17'
);
INSERT INTO public.tournaments(
  id,name,description,game_type,buy_in_amount,buy_in_fee,start_time,status,
  max_players,created_at,updated_at,on_break,club_id
) VALUES (
  '71000000-0000-0000-0000-000000000011',
  'Stage-B hotfix receipt preservation',
  'Disposable PG17 immutable move-receipt fixture',
  'NLH',0,0,'2026-09-10 00:00:00-05','RUNNING',9,
  '2026-09-09 23:00:00-05','2026-09-10 00:00:00-05',false,
  '71000000-0000-0000-0000-000000000002'
);
INSERT INTO public.tables(
  id,name,club_id,tournament_id,game_type,status,lifecycle,current_players,
  seat_game_scope,seat_admission_key
) VALUES
  ('71000000-0000-0000-0000-000000000021','Receipt source',
   '71000000-0000-0000-0000-000000000002',
   '71000000-0000-0000-0000-000000000011','tournament','active','live',0,
   'table:71000000-0000-0000-0000-000000000021',
   'tournament:71000000-0000-0000-0000-000000000011'),
  ('71000000-0000-0000-0000-000000000022','Receipt destination',
   '71000000-0000-0000-0000-000000000002',
   '71000000-0000-0000-0000-000000000011','tournament','active','live',1,
   'table:71000000-0000-0000-0000-000000000022',
   'tournament:71000000-0000-0000-0000-000000000011');
INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,joined_at,left_at,status,
  active_game_scope,active_parent_key
) VALUES
  ('71000000-0000-0000-0000-000000000031',
   '71000000-0000-0000-0000-000000000021',1,
   '71000000-0000-0000-0000-000000000001',0,
   '2026-09-09 23:55:00-05','2026-09-10 00:00:00-05','left',NULL,NULL),
  ('71000000-0000-0000-0000-000000000032',
   '71000000-0000-0000-0000-000000000022',2,
   '71000000-0000-0000-0000-000000000001',100,
   '2026-09-10 00:00:00-05',NULL,'active',
   'table:71000000-0000-0000-0000-000000000022',
   'tournament:71000000-0000-0000-0000-000000000011');
INSERT INTO public.tournament_players(
  id,tournament_id,user_id,chips,chip_count,status,table_id,seat_number
) VALUES (
  '71000000-0000-0000-0000-000000000041',
  '71000000-0000-0000-0000-000000000011',
  '71000000-0000-0000-0000-000000000001',100,100,'playing',
  '71000000-0000-0000-0000-000000000022',2
);
INSERT INTO public.tournament_seat_move_receipts(
  request_id,tournament_id,user_id,source_table_id,destination_table_id,
  source_seat_id,destination_seat_id,source_seat_number,
  destination_seat_number,source_mode,stack,moved_at
) VALUES (
  '71000000-0000-0000-0000-000000000051',
  '71000000-0000-0000-0000-000000000011',
  '71000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000021',
  '71000000-0000-0000-0000-000000000022',
  '71000000-0000-0000-0000-000000000031',
  '71000000-0000-0000-0000-000000000032',1,2,'live_source',100,
  '2026-09-10 00:00:00-05'
);
SET session_replication_role=origin;
SQL
}

move_receipt_fingerprint() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -Atq -F '|' <<'SQL'
SELECT count(*)::bigint,
       encode(extensions.digest(COALESCE(
         string_agg(
           encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex'),''
           ORDER BY r.request_id),''
       ),'sha256'),'hex')
  FROM public.tournament_seat_move_receipts r;
SQL
}

seed_terminal_tournament() {
  local database="$1"
  local tournament_id="$2"
  local fixture_name="$3"
  local fixture_description="$4"
  "${psql_cmd[@]}" --dbname="$database" -q \
    -v "fixture_tournament_id=$tournament_id" \
    -v "fixture_name=$fixture_name" \
    -v "fixture_description=$fixture_description" <<'SQL'
SET session_replication_role=replica;
INSERT INTO public.clubs(id,name,slug,code)
VALUES (
  '70000000-0000-0000-0000-000000000002',
  'Stage-B terminal fixture club',
  'stage-b-terminal-fixture-club','SBT17'
);
INSERT INTO public.tournaments(
  id,name,description,game_type,buy_in_amount,buy_in_fee,start_time,status,
  max_players,created_at,updated_at,ended_at,on_break,
  break_started_at,break_ends_at,club_id
) VALUES (
  :'fixture_tournament_id'::uuid,
  :'fixture_name',
  :'fixture_description',
  'NLH',0,0,'2026-09-09 13:00:00-05','COMPLETED',9,
  '2026-09-09 12:00:00-05','2026-09-09 15:00:00-05',
  '2026-09-09 15:00:00-05',true,
  '2026-09-09 14:50:00-05','2026-09-09 15:05:00-05',
  '70000000-0000-0000-0000-000000000002'
);
SET session_replication_role=origin;
SQL
}

run_terminal_residue_success() {
  local database="$1"
  local tournament_id='70000000-0000-0000-0000-000000000011'
  local guard_before

  seed_terminal_tournament \
    "$database" \
    "$tournament_id" \
    'Stage-B terminal normalization success' \
    'Disposable PG17 nonempty terminal residue fixture'
  guard_before="$(terminal_guard_fingerprint "$database")"
  if [[ "$guard_before" == 'missing' || -z "$guard_before" ]]; then
    echo 'The terminal-residue fixture is missing its original guard or trigger.' >&2
    exit 65
  fi

  run_chain_prefix 3 false "$database"

  {
    emit_terminal_guard_fingerprint_function
    cat <<'SQL'
CREATE TEMP TABLE stage_b_expected_terminal_guard(fingerprint text PRIMARY KEY);
INSERT INTO stage_b_expected_terminal_guard VALUES (:'expected_guard');
DO $verify_terminal_residue_success$
DECLARE
  v_expected_guard text;
  v_current_guard text:=pg_temp.stage_b_terminal_guard_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_expected_guard
    FROM pg_temp.stage_b_expected_terminal_guard;
  IF v_current_guard='missing'
     OR v_current_guard IS DISTINCT FROM v_expected_guard THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_GUARD_NOT_RESTORED_EXACTLY';
  END IF;

  IF (SELECT count(*) FROM public.tournaments
       WHERE id='70000000-0000-0000-0000-000000000011'
         AND upper(status::text)='COMPLETED'
         AND on_break=false
         AND break_started_at IS NULL
         AND break_ends_at IS NULL)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_RESIDUE_NOT_NORMALIZED';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_terminal_break_normalization_receipts
       WHERE tournament_id='70000000-0000-0000-0000-000000000011'
         AND terminal_status='COMPLETED'
         AND on_break_before
         AND break_started_at_before=
               '2026-09-09 14:50:00-05'::timestamptz
         AND break_ends_at_before=
               '2026-09-09 15:05:00-05'::timestamptz
         AND normalization_version=
               '20260910042020_stage_b_exact_precondition_repairs')<>1
     OR (SELECT count(*)
           FROM public.tournament_terminal_break_normalization_receipts)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_RESIDUE_RECEIPT_INEXACT';
  END IF;

  IF (SELECT count(*)
        FROM pg_proc p
       WHERE p.oid=
             'public.fn_guard_terminal_tournament_break_state()'::regprocedure
         AND md5(p.prosrc)='0b9721aee2fc723fed88a78761c34132'
         AND p.proowner='postgres'::regrole
         AND p.prosecdef
         AND p.provolatile='v'
         AND p.proparallel='u'
         AND NOT p.proisstrict
         AND NOT p.proleakproof
         AND p.proacl::text='{postgres=X/postgres}')<>1
     OR (SELECT count(*)
           FROM pg_trigger tg
          WHERE tg.tgrelid='public.tournaments'::regclass
            AND tg.tgname='aaa_guard_terminal_tournament_break_state'
            AND tg.tgfoid=
                  'public.fn_guard_terminal_tournament_break_state()'::regprocedure
            AND tg.tgenabled='O'
            AND tg.tgtype=23
            AND md5(pg_get_triggerdef(tg.oid,true))=
                  'bf5ea83967f7957259aa5dc894705512')<>1
     OR (SELECT count(*)
           FROM pg_constraint c
          WHERE c.conrelid='public.tournaments'::regclass
            AND c.conname='tournaments_terminal_break_state_is_clear'
            AND c.contype='c'
            AND c.convalidated
            AND NOT c.condeferrable
            AND NOT c.condeferred
            AND NOT c.connoinherit
            AND md5(pg_get_constraintdef(c.oid,true))=
                  '37b2bc74f3d9ab88967864e55202238b')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_PERMANENT_INVARIANT_INEXACT';
  END IF;
END;
$verify_terminal_residue_success$;
SELECT pg_temp.stage_b_terminal_guard_fingerprint() AS restored_guard,
       (SELECT count(*)
          FROM public.tournament_terminal_break_normalization_receipts)
         AS normalization_receipts,
       (SELECT count(*) FROM public.tournaments
         WHERE upper(status::text) IN ('COMPLETED','CANCELLED')
           AND (on_break OR break_started_at IS NOT NULL
                OR break_ends_at IS NOT NULL)) AS terminal_residue;
SQL
  } | "${psql_cmd[@]}" --dbname="$database" \
        -v "expected_guard=$guard_before"
  echo 'STAGE_B_TERMINAL_RESIDUE_SUCCESS_OK'
}

run_terminal_candidate_behavior() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
DO $require_candidate_adapter_preimage$
BEGIN
  IF to_regprocedure(
       'smarter_private.fn_tournament_finish_readiness_for_terminal_candidate(uuid,uuid,text,boolean,timestamp with time zone,timestamp with time zone)'
     ) IS NULL
     OR (SELECT t.tgenabled
           FROM pg_trigger t
          WHERE t.tgrelid='public.tournaments'::regclass
            AND t.tgname='zzzzzz_tournaments_financial_certificate'
            AND NOT t.tgisinternal) IS DISTINCT FROM 'D' THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_CANDIDATE_ADAPTER_PREIMAGE_INEXACT';
  END IF;
END;
$require_candidate_adapter_preimage$;

-- Production enables this existing trigger at #5. Enable only that trigger in
-- this disposable #3 scenario so the candidate adapter is exercised without
-- replaying #4/#5 or weakening any other completion guard.
ALTER TABLE public.tournaments
  ENABLE TRIGGER zzzzzz_tournaments_financial_certificate;

BEGIN;
SET LOCAL session_replication_role=replica;

CREATE TEMP TABLE stage_b_terminal_candidates(
  tournament_id uuid PRIMARY KEY,
  winner_id uuid NOT NULL,
  rake_destination text NOT NULL,
  rake_settled_at timestamptz,
  rake_attributed_at timestamptz
) ON COMMIT PRESERVE ROWS;

INSERT INTO stage_b_terminal_candidates VALUES
  ('73000000-0000-0000-0000-000000000011',
   '73000000-0000-0000-0000-000000000101',
   'club_treasury:73000000-0000-0000-0000-000000000001',
   '2026-09-10 16:00:00+00','2026-09-10 16:00:00+00'),
  ('73000000-0000-0000-0000-000000000012',
   '73000000-0000-0000-0000-000000000102',
   'pending',NULL,NULL);

INSERT INTO auth.users(id)
SELECT winner_id FROM stage_b_terminal_candidates ORDER BY winner_id;
INSERT INTO public.profiles(id)
SELECT winner_id FROM stage_b_terminal_candidates ORDER BY winner_id;
INSERT INTO public.clubs(id,name,slug,code) VALUES (
  '73000000-0000-0000-0000-000000000001',
  'Stage B terminal candidate club','stage-b-terminal-candidate-club','SBTC17'
);

INSERT INTO public.tournaments(
  id,name,description,game_type,variant,buy_in_amount,buy_in_fee,start_time,
  status,current_players,max_players,created_at,updated_at,started_at,ended_at,
  club_id,prize_pool,prize_pool_finalized,total_rake,bounty_pool,
  bounty_pool_paid,on_break,break_started_at,break_ends_at
)
SELECT c.tournament_id,
       CASE WHEN c.rake_destination='pending'
            THEN 'Stage B blocked terminal candidate'
            ELSE 'Stage B ready terminal candidate' END,
       'Disposable PG17 candidate-aware terminal completion fixture',
       'NLH','standard',0,0,'2026-09-10 13:00:00+00','COMPLETING',1,9,
       '2026-09-10 12:00:00+00','2026-09-10 16:00:00+00',
       '2026-09-10 13:00:00+00','2026-09-10 16:00:00+00',
       '73000000-0000-0000-0000-000000000001',0,true,0,0,0,true,
       '2026-09-10 15:50:00+00','2026-09-10 16:05:00+00'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_players(
  id,tournament_id,user_id,chips,chip_count,status,position,prize,club_id,
  registered_at
)
SELECT CASE WHEN c.rake_destination='pending'
            THEN '73000000-0000-0000-0000-000000000202'::uuid
            ELSE '73000000-0000-0000-0000-000000000201'::uuid END,
       c.tournament_id,c.winner_id,1,1,'winner',1,0,
       '73000000-0000-0000-0000-000000000001',
       '2026-09-10 12:30:00+00'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_place_settlement_batches(
  tournament_id,mode,plan_fingerprint,place_count,amount_owed,
  escrow_required,escrow_available,source,prepared_at,settled_at
)
SELECT c.tournament_id,'structure','d751713988987e9331980363e24189ce',
       0,0,0,0,'stage_b_terminal_candidate',
       '2026-09-10 15:59:00+00','2026-09-10 16:00:00+00'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_finish_receipts(
  tournament_id,winner_user_id,finish_kind,claim_source,claimed_at
)
SELECT c.tournament_id,c.winner_id,'normal','stage_b_terminal_candidate',
       '2026-09-10 15:59:00+00'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_rake_settlements(
  tournament_id,club_id,amount,destination,source,created_at,settled_at,
  attributed_at,attributed_users
)
SELECT c.tournament_id,'73000000-0000-0000-0000-000000000001',0,
       c.rake_destination,'stage_b_terminal_candidate',
       '2026-09-10 15:59:00+00',c.rake_settled_at,c.rake_attributed_at,0
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_escrow(
  tournament_id,opened_from,opened_at,updated_at,closed_at,close_note
)
SELECT c.tournament_id,'stage_b_terminal_candidate',
       '2026-09-10 12:00:00+00','2026-09-10 16:00:00+00',
       '2026-09-10 16:00:00+00','stage_b_terminal_candidate_zero_close'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;

INSERT INTO public.tournament_terminal_settlements(
  tournament_id,winner_id,settlement_mode,started_status,prize_pool,bounty_pool,
  cash_payout_count,cash_payout_total,bounty_payout_total,mystery_was_active,
  mystery_pool_cents,cash_receipt,mystery_receipt,bounty_receipt,
  closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,
  released_seat_count,released_seat_ids,rake_amount,rake_destination,
  rake_settled_at,rake_attributed_at,rake_attributed_users,escrow_closed_at,
  escrow_close_note,completed_at,settled_at
)
SELECT c.tournament_id,c.winner_id,'places','COMPLETING',0,0,0,0,0,false,0,
       jsonb_build_object(
         'ok',true,'fully_settled',true,'status','COMPLETING','winner_amount',0,
         'payouts',jsonb_build_array(jsonb_build_object(
           'place',1,'user_id',c.winner_id,'amount',0)),
         'deal_shares','[]'::jsonb,'bubble_protection','null'::jsonb),
       jsonb_build_object('ok',true,'reason','not_a_mystery_tournament'),
       jsonb_build_object('ok',true,'reason','not_a_bounty_tournament'),
       0,ARRAY[]::uuid[],0,ARRAY[]::uuid[],0,ARRAY[]::uuid[],0,
       c.rake_destination,
       COALESCE(c.rake_settled_at,'2026-09-10 16:00:00+00'),
       COALESCE(c.rake_attributed_at,'2026-09-10 16:00:00+00'),0,
       '2026-09-10 16:00:00+00','stage_b_terminal_candidate_zero_close',
       '2026-09-10 16:00:00+00','2026-09-10 16:01:00+00'
  FROM stage_b_terminal_candidates c ORDER BY c.tournament_id;
COMMIT;

BEGIN;
UPDATE public.tournaments SET status='COMPLETED'
 WHERE id='73000000-0000-0000-0000-000000000011';
COMMIT;

DO $verify_ready_terminal_candidate$
BEGIN
  IF (SELECT count(*) FROM public.tournaments
       WHERE id='73000000-0000-0000-0000-000000000011'
         AND status='COMPLETED' AND on_break=false
         AND break_started_at IS NULL AND break_ends_at IS NULL)<>1
     OR (SELECT count(*) FROM public.tournament_finish_receipts
          WHERE tournament_id='73000000-0000-0000-0000-000000000011'
            AND certified_at IS NOT NULL
            AND completed_at='2026-09-10 16:00:00+00'
            AND COALESCE((evidence->>'ok')::boolean,false)
            AND evidence->'failures'='[]'::jsonb)<>1
     OR (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='73000000-0000-0000-0000-000000000011'
            AND terminal_closed_at='2026-09-10 16:00:00+00')<>1
     OR (SELECT count(*) FROM public.tournament_rake_settlements
          WHERE tournament_id='73000000-0000-0000-0000-000000000011'
            AND terminal_closed_at='2026-09-10 16:00:00+00')<>1 THEN
    RAISE EXCEPTION 'STAGE_B_READY_TERMINAL_CANDIDATE_NOT_CERTIFIED';
  END IF;
END;
$verify_ready_terminal_candidate$;

DO $verify_unrelated_failure_survives_adapter$
DECLARE
  v_message text;
BEGIN
  BEGIN
    UPDATE public.tournaments SET status='COMPLETED'
     WHERE id='73000000-0000-0000-0000-000000000012';
    RAISE EXCEPTION 'STAGE_B_TERMINAL_CANDIDATE_UNRELATED_FAILURE_ACCEPTED';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
    IF position('rake_not_settled' IN v_message)=0
       OR position('terminal_break_flag_set' IN v_message)>0 THEN
      RAISE EXCEPTION 'STAGE_B_TERMINAL_CANDIDATE_WRONG_FAILURE: %',v_message;
    END IF;
  END;

  IF (SELECT count(*) FROM public.tournaments
       WHERE id='73000000-0000-0000-0000-000000000012'
         AND status='COMPLETING' AND on_break
         AND break_started_at='2026-09-10 15:50:00+00'
         AND break_ends_at='2026-09-10 16:05:00+00')<>1
     OR (SELECT count(*) FROM public.tournament_finish_receipts
          WHERE tournament_id='73000000-0000-0000-0000-000000000012'
            AND certified_at IS NULL AND completed_at IS NULL
            AND evidence IS NULL)<>1
     OR (SELECT count(*) FROM public.tournament_players
          WHERE tournament_id='73000000-0000-0000-0000-000000000012'
            AND terminal_closed_at IS NOT NULL)<>0
     OR (SELECT count(*) FROM public.tournament_rake_settlements
          WHERE tournament_id='73000000-0000-0000-0000-000000000012'
            AND terminal_closed_at IS NOT NULL)<>0 THEN
    RAISE EXCEPTION 'STAGE_B_TERMINAL_CANDIDATE_FAILURE_DID_NOT_ROLL_BACK';
  END IF;
END;
$verify_unrelated_failure_survives_adapter$;
SQL
  echo 'STAGE_B_TERMINAL_CANDIDATE_BEHAVIOR_OK'
}

seed_noncanonical_missing_finish_claim() {
  local database="$1"
  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
SET session_replication_role=replica;
INSERT INTO public.tournament_place_settlement_batches(
  tournament_id,mode,plan_fingerprint,place_count,amount_owed,
  escrow_required,escrow_available,source,prepared_at,settled_at
) VALUES (
  '70000000-0000-0000-0000-000000000021','structure',
  '00000000000000000000000000000000',0,0,0,0,
  'stage_b_pg17_deliberate_noncanonical_missing_claim',
  '2026-09-09 14:59:59-05','2026-09-09 15:00:00-05'
);
SET session_replication_role=origin;
SQL
}

run_late_missing_finish_claim_rollback() {
  local database="$1"
  local tournament_id='70000000-0000-0000-0000-000000000021'
  local guard_before
  local missing_claim_log=''
  local expected_error='23514: expected one exact missing atomic finish claim, found 1 total / 0 exact'

  seed_terminal_tournament \
    "$database" \
    "$tournament_id" \
    'Stage-B deliberate late rollback' \
    'Disposable PG17 dirty terminal plus noncanonical settled batch'
  seed_noncanonical_missing_finish_claim "$database"
  guard_before="$(terminal_guard_fingerprint "$database")"
  if [[ "$guard_before" == 'missing' || -z "$guard_before" ]]; then
    echo 'The late-failure fixture is missing its original guard or trigger.' >&2
    exit 65
  fi

  if missing_claim_log="$(run_chain_prefix 2 false "$database" 2>&1)"; then
    echo 'Stage-B #2 accepted an unmeasured missing finish claim.' >&2
    exit 1
  fi
  if ! grep -Fq "$expected_error" <<<"$missing_claim_log"; then
    printf '%s\n' "$missing_claim_log" >&2
    echo 'Stage-B #2 did not fail at the late missing-finish-claim classifier.' >&2
    exit 1
  fi
  printf '%s\n' "$missing_claim_log" | grep -F "$expected_error"

  {
    emit_terminal_guard_fingerprint_function
    cat <<'SQL'
CREATE TEMP TABLE stage_b_expected_terminal_guard(fingerprint text PRIMARY KEY);
INSERT INTO stage_b_expected_terminal_guard VALUES (:'expected_guard');
DO $verify_late_missing_finish_claim_rollback$
DECLARE
  v_expected_guard text;
  v_current_guard text:=pg_temp.stage_b_terminal_guard_fingerprint();
BEGIN
  SELECT fingerprint INTO STRICT v_expected_guard
    FROM pg_temp.stage_b_expected_terminal_guard;
  IF v_current_guard='missing'
     OR v_current_guard IS DISTINCT FROM v_expected_guard THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_TERMINAL_GUARD';
  END IF;

  IF (SELECT count(*) FROM public.tournaments
       WHERE id='70000000-0000-0000-0000-000000000021'
         AND upper(status::text)='COMPLETED'
         AND on_break
         AND break_started_at='2026-09-09 14:50:00-05'::timestamptz
         AND break_ends_at='2026-09-09 15:05:00-05'::timestamptz
         AND updated_at='2026-09-09 15:00:00-05'::timestamptz)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_DIRTY_TOURNAMENT';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_place_settlement_batches
       WHERE tournament_id='70000000-0000-0000-0000-000000000021'
         AND plan_fingerprint='00000000000000000000000000000000'
         AND settled_at='2026-09-09 15:00:00-05'::timestamptz)<>1 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_CHANGED_SETTLEMENT_BATCH';
  END IF;

  IF (SELECT count(*)
        FROM public.tournament_terminal_break_normalization_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_seat_exit_authority_cutover)<>0
     OR (SELECT count(*) FROM public.tournament_finish_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_pending_zero_seat_cutover_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_paid_candidate_cutover_receipts)<>0
     OR (SELECT count(*)
           FROM public.tournament_positive_orphan_cutover_receipts)<>0 THEN
    RAISE EXCEPTION 'STAGE_B_LATE_FAILURE_LEAKED_REPAIR_STATE';
  END IF;
END;
$verify_late_missing_finish_claim_rollback$;
SELECT pg_temp.stage_b_terminal_guard_fingerprint() AS restored_guard,
       (SELECT count(*)
          FROM public.tournament_terminal_break_normalization_receipts)
         AS normalization_receipts,
       (SELECT count(*)
          FROM public.tournament_seat_exit_authority_cutover)
         AS authority_markers,
       (SELECT count(*) FROM public.tournament_finish_receipts)
         AS finish_receipts;
SQL
  } | "${psql_cmd[@]}" --dbname="$database" \
        -v "expected_guard=$guard_before"
  echo 'STAGE_B_LATE_MISSING_FINISH_CLAIM_ROLLBACK_OK'
}

run_keyshare_unknown_preimage_rollback() {
  local database="$1"
  local mixed_fingerprint_before
  local mixed_fingerprint_after
  local mixed_log=''
  local mixed_post

  "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'
ALTER TABLE public.engine_table_leases
  ADD CONSTRAINT engine_table_leases_owner_generation_key
  UNIQUE (table_id,instance_id,lease_generation);
SQL
  mixed_fingerprint_before="$(keyshare_postimage_fingerprint "$database")"
  if [[ "$mixed_fingerprint_before" == 'missing' ]]; then
    echo 'The #1-#5 mixed-state fixture is missing a key-share target function.' >&2
    return 65
  fi
  if mixed_log="$("${psql_cmd[@]}" --dbname="$database" -f "${chain_files[5]}" 2>&1)"; then
    echo 'Stage-B #6 accepted a mixed ownership-key preimage.' >&2
    return 1
  fi
  if ! grep -Fq 'LEASE_KEYSHARE_UNKNOWN_PREIMAGE: table key 1, tournament key 0' \
    <<<"$mixed_log"; then
    printf '%s\n' "$mixed_log" >&2
    echo 'Stage-B #6 did not fail at the authenticated unknown-preimage classifier.' >&2
    return 1
  fi
  mixed_post="$({
    "${psql_cmd[@]}" --dbname="$database" -Atq -F '|' <<'SQL'
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.engine_table_leases'::regclass
      AND conname='engine_table_leases_owner_generation_key'),
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.engine_tournament_leases'::regclass
      AND conname='engine_tournament_leases_owner_generation_key');
SQL
  })"
  mixed_fingerprint_after="$(keyshare_postimage_fingerprint "$database")"
  if [[ "$mixed_post" != '1|0' \
     || "$mixed_fingerprint_after" != "$mixed_fingerprint_before" ]]; then
    echo 'Stage-B #6 mixed-state refusal left a partial schema or function write.' >&2
    return 1
  fi
  echo 'STAGE_B_LEASE_KEYSHARE_UNKNOWN_PREIMAGE_ROLLBACK_OK'
}

thaw_synthetic_freeze_for_rollback_probe() {
  local database="$1"
  local freeze_fingerprint=''

  freeze_fingerprint="$(
    "${psql_cmd[@]}" --dbname="$database" -Atq <<'SQL'
SELECT encode(extensions.digest(
         convert_to(to_jsonb(b)::text,'UTF8'),'sha256'),'hex')
  FROM public.engine_maintenance_break b
 WHERE b.id
   AND b.phase='counting_down'
   AND b.enforce_freeze
   AND b.reason='Stage B PG17 Rehearsal'
   AND b.declared_by='stage-b-forward-chain-pg17'
   AND b.ownership_token='72000000-0000-4000-8000-000000000001'
   AND b.break_ends_at>clock_timestamp()+interval '2 minutes';
SQL
  )"
  if [[ ! "$freeze_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
    echo 'The rollback probe found no exact synthetic Stage-B freeze with enough headroom.' >&2
    return 1
  fi

  if ! "${psql_cmd[@]}" --dbname="$database" -q <<'SQL'; then
BEGIN;
DO $thaw_synthetic_freeze_for_rollback_probe$
DECLARE
  v_changed integer;
BEGIN
  IF (SELECT count(*) FROM public.engine_maintenance_break b
       WHERE b.id AND b.phase='counting_down' AND b.enforce_freeze
         AND b.reason='Stage B PG17 Rehearsal'
         AND b.declared_by='stage-b-forward-chain-pg17'
         AND b.ownership_token='72000000-0000-4000-8000-000000000001'
         AND b.break_ends_at>clock_timestamp()+interval '2 minutes')<>1
     OR public.fn_platform_frozen() IS NOT TRUE
     OR public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'STAGE_B_ROLLBACK_PROBE_FREEZE_PREIMAGE_DRIFTED'
      USING ERRCODE='55000';
  END IF;
  UPDATE public.engine_maintenance_break
     SET enforce_freeze=false
   WHERE id AND phase='counting_down' AND enforce_freeze
     AND reason='Stage B PG17 Rehearsal'
     AND declared_by='stage-b-forward-chain-pg17'
     AND ownership_token='72000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed<>1 OR public.fn_platform_frozen()
     OR public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'STAGE_B_ROLLBACK_PROBE_LOCAL_THAW_FAILED'
      USING ERRCODE='55000';
  END IF;
END;
$thaw_synthetic_freeze_for_rollback_probe$;
COMMIT;
SQL
    echo 'The rollback probe could not establish its bounded local thaw.' >&2
    return 1
  fi
  printf '%s\n' "$freeze_fingerprint"
}

restore_synthetic_freeze_after_rollback_probe() {
  local database="$1"
  local freeze_fingerprint="$2"

  if ! "${psql_cmd[@]}" --dbname="$database" -q \
      -v expected_freeze_fingerprint="$freeze_fingerprint" <<'SQL' >/dev/null
BEGIN;
SELECT set_config(
  'app.stage_b_expected_freeze_fingerprint',
  :'expected_freeze_fingerprint',true);
DO $restore_synthetic_freeze_after_rollback_probe$
DECLARE
  v_changed integer;
  v_restored_fingerprint text;
BEGIN
  IF (SELECT count(*) FROM public.engine_maintenance_break b
       WHERE b.id AND b.phase='counting_down' AND NOT b.enforce_freeze
         AND b.reason='Stage B PG17 Rehearsal'
         AND b.declared_by='stage-b-forward-chain-pg17'
         AND b.ownership_token='72000000-0000-4000-8000-000000000001')<>1
     OR public.fn_platform_frozen()
     OR public.fn_entry_purchases_frozen() THEN
    RAISE EXCEPTION 'STAGE_B_ROLLBACK_PROBE_LOCAL_THAW_DRIFTED'
      USING ERRCODE='55000';
  END IF;
  UPDATE public.engine_maintenance_break
     SET enforce_freeze=true
   WHERE id AND phase='counting_down' AND NOT enforce_freeze
     AND reason='Stage B PG17 Rehearsal'
     AND declared_by='stage-b-forward-chain-pg17'
     AND ownership_token='72000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  SELECT encode(extensions.digest(
           convert_to(to_jsonb(b)::text,'UTF8'),'sha256'),'hex')
    INTO STRICT v_restored_fingerprint
    FROM public.engine_maintenance_break b WHERE b.id;
  IF v_changed<>1
     OR v_restored_fingerprint IS DISTINCT FROM current_setting(
          'app.stage_b_expected_freeze_fingerprint')
     OR public.fn_platform_frozen() IS NOT TRUE
     OR public.fn_entry_purchases_frozen() IS NOT TRUE THEN
    RAISE EXCEPTION 'STAGE_B_ROLLBACK_PROBE_FREEZE_RESTORE_FAILED'
      USING ERRCODE='55000';
  END IF;
END;
$restore_synthetic_freeze_after_rollback_probe$;
COMMIT;
SQL
  then
    echo 'The rollback probe did not restore its exact synthetic Stage-B freeze.' >&2
    return 1
  fi
}

run_bounty_rebuy_generation_atomicity() {
  local database="$1"
  local probe_log=''
  local probe_status=0
  local freeze_fingerprint=''

  if ! freeze_fingerprint="$(
      thaw_synthetic_freeze_for_rollback_probe "$database")"; then
    return 1
  fi
  probe_log="$("${psql_cmd[@]}" --dbname="$database" \
    -f "$bounty_rebuy_fixture" -f "$bounty_rebuy_probe" 2>&1)" \
    || probe_status=$?
  if ! restore_synthetic_freeze_after_rollback_probe \
      "$database" "$freeze_fingerprint"; then
    return 1
  fi

  if (( probe_status == 0 )); then
    echo 'The bounty-rebuy probe did not end in its intentional rollback exception.' >&2
    return 1
  fi
  if ! grep -Fq \
    'AUDIT_TEST_PASS: bounty, PKO, and mystery rebuy each settled the exact old generation' \
    <<<"$probe_log"; then
    printf '%s\n' "$probe_log" >&2
    echo 'The post-six exact-generation bounty-rebuy proof failed.' >&2
    return 1
  fi
  echo 'STAGE_B_11052648_BOUNTY_REBUY_ATOMICITY_OK'
}

run_tournament_cancellation_entrant_refunds() {
  local database="$1"
  local probe_log=''
  local probe_status=0
  local freeze_fingerprint=''

  # Registration is correctly closed during the synthetic Stage-B freeze. Thaw
  # only this disposable scenario for the rollback-only semantic proof.
  if ! freeze_fingerprint="$(
      thaw_synthetic_freeze_for_rollback_probe "$database")"; then
    return 1
  fi
  probe_log="$("${psql_cmd[@]}" --dbname="$database" \
    -f "$cancellation_probe" 2>&1)" || probe_status=$?
  if ! restore_synthetic_freeze_after_rollback_probe \
      "$database" "$freeze_fingerprint"; then
    return 1
  fi

  if (( probe_status != 0 )); then
    printf '%s\n' "$probe_log" >&2
    echo 'The post-six exact-origin tournament cancellation proof failed.' >&2
    return 1
  fi
  if ! grep -Fq 'TOURNAMENT_CANCELLATION_ENTRANT_REFUNDS_PASS' \
      <<<"$probe_log" \
     || ! grep -Fq \
      'AUDIT_TEST_PASS: cancellation returned the cash entrant exactly 100 chips' \
      <<<"$probe_log"; then
    printf '%s\n' "$probe_log" >&2
    echo 'The post-six exact-origin tournament cancellation proof emitted no acceptance marker.' >&2
    return 1
  fi
  echo 'STAGE_B_11061723_CANCELLATION_EXACT_ORIGIN_OK'
}

run_post_six_rollback_probe() {
  local database="$1"
  local probe_file="$2"
  local receipt="$3"
  shift 3
  local probe_log=''
  local probe_status=0
  local freeze_fingerprint=''
  local acceptance_marker=''

  if ! freeze_fingerprint="$(
      thaw_synthetic_freeze_for_rollback_probe "$database")"; then
    return 1
  fi
  probe_log="$("${psql_cmd[@]}" --dbname="$database" \
    -f "$probe_file" 2>&1)" || probe_status=$?
  if ! restore_synthetic_freeze_after_rollback_probe \
      "$database" "$freeze_fingerprint"; then
    return 1
  fi

  if (( probe_status != 0 )); then
    printf '%s\n' "$probe_log" >&2
    echo "The post-six rollback probe failed: ${probe_file}." >&2
    return 1
  fi
  for acceptance_marker in "$@"; do
    if ! grep -Fq "$acceptance_marker" <<<"$probe_log"; then
      printf '%s\n' "$probe_log" >&2
      echo "The post-six rollback probe emitted no required marker: ${acceptance_marker}." >&2
      return 1
    fi
  done
  echo "$receipt"
}

run_all_unregistration_origin_proofs() {
  local database="$1"

  run_post_six_rollback_probe "$database" "$cash_unregistration_probe" \
    'STAGE_B_WALLET_CHARGE_UNREGISTRATION_AND_REPLAY_OK' \
    'AUDIT_TEST_PASS: buy-in and rebuy debited entry Club A' \
    'AUDIT_TEST_PASS: identical request replays one immutable cross-club receipt'
  run_post_six_rollback_probe "$database" "$satellite_ticket_return_probe" \
    'STAGE_B_SATELLITE_SEAT_AND_TOURNAMENT_TICKET_RETURN_REPLAY_OK' \
    'PASS satellite seat -> ticket -> admission -> ticket-only return' \
    'request-key replay exact before and after start' \
    'cash and forged redemptions refused'
  run_post_six_rollback_probe "$database" "$actual_start_unregistration_probe" \
    'STAGE_B_ACTUAL_START_AND_HAND_HISTORY_UNREGISTRATION_REFUSAL_OK' \
    'AUDIT_TEST_PASS: Spin and Heads-Up SNG separately refunded after their fill-window deadlines' \
    'AUDIT_TEST_PASS: persisted hand history independently closes Spin and Heads-Up SNG unregistration'
}

run_elimination_seat_exit_authority_proof() {
  local database="$1"

  run_post_six_rollback_probe "$database" "$elimination_seat_exit_probe" \
    'STAGE_B_ELIMINATION_SEAT_EXIT_AUTHORITY_OK' \
    'AUDIT_TEST_PASS: level- and minute-bounded rebuy clocks opened exact capped prompts' \
    'non-bounty and bounty eliminations each proved a distinct hand-history id' \
    'left no authorization row'
}

assert_donor_unchanged() {
  local donor_fingerprint_after
  restore_dump_lost_postgrest_role_setting
  donor_fingerprint_after="$(donor_state_fingerprint)"
  if [[ -z "$donor_fingerprint_after" \
     || "$donor_fingerprint_after" != "$donor_fingerprint_before" ]]; then
    echo 'The production-schema zero-data donor changed during rehearsal.' >&2
    return 1
  fi
  echo 'STAGE_B_ZERO_DATA_DONOR_UNCHANGED'
}

trap cleanup_scenario_databases EXIT

create_scenario_database 'normalized_input' "$expected_database"
normalized_input_database="$created_scenario_database"
normalize_dump_lost_hotfix_owner_acl "$normalized_input_database"
normalize_dump_lost_postgrest_role_setting
compose_current_live_tail "$normalized_input_database"
scenario_template_database="$normalized_input_database"

if [[ "$probe_mode" == 'mixed' ]]; then
  create_scenario_database 'keyshare_mixed'
  mixed_database="$created_scenario_database"
  seed_synthetic_freeze "$mixed_database"
  seed_unrelated_later_receipt "$mixed_database"
  run_chain_prefix 5 false "$mixed_database"
  assert_unrelated_later_receipt_survived "$mixed_database"
  assert_stage_b_bounded_postimage "$mixed_database"
  run_keyshare_unknown_preimage_rollback "$mixed_database"
  assert_stage_b_bounded_postimage "$mixed_database"
  assert_donor_unchanged
  exit 0
fi

if [[ "$probe_mode" == 'replay' ]]; then
  create_scenario_database 'keyshare_replay'
  replay_database="$created_scenario_database"
  seed_synthetic_freeze "$replay_database"
  seed_unrelated_later_receipt "$replay_database"
  run_chain_prefix 6 true "$replay_database"
  assert_unrelated_later_receipt_survived "$replay_database"
  assert_stage_b_bounded_postimage "$replay_database"
  run_tournament_cancellation_entrant_refunds "$replay_database"
  run_bounty_rebuy_generation_atomicity "$replay_database"
  run_elimination_seat_exit_authority_proof "$replay_database"
  run_all_unregistration_origin_proofs "$replay_database"
  echo 'STAGE_B_LEASE_KEYSHARE_REPLAY_OK'
  assert_donor_unchanged
  echo 'STAGE_B_FORWARD_CHAIN_PG17_OK'
  exit 0
fi

create_scenario_database 'terminal_residue'
terminal_residue_database="$created_scenario_database"
seed_synthetic_freeze "$terminal_residue_database"
run_terminal_residue_success "$terminal_residue_database"
run_terminal_candidate_behavior "$terminal_residue_database"

create_scenario_database 'late_finish_claim'
late_finish_claim_database="$created_scenario_database"
seed_synthetic_freeze "$late_finish_claim_database"
run_late_missing_finish_claim_rollback "$late_finish_claim_database"

echo 'STAGE_B_DEFECT_REPRODUCTIONS_PG17_OK'

# Apply #1-#5 once. The resulting database becomes the exact template for both
# #6 outcomes, so the authenticated current postimage and its Diamond fixture
# are not rebuilt for the replay and unknown-preimage branches.
create_scenario_database 'current_postimage'
current_postimage_database="$created_scenario_database"
seed_synthetic_freeze "$current_postimage_database"
seed_unrelated_later_receipt "$current_postimage_database"
seed_hotfix_move_receipt "$current_postimage_database"
move_receipts_before="$(move_receipt_fingerprint "$current_postimage_database")"
prepare_current_postimage_template "$current_postimage_database"
assert_unrelated_later_receipt_survived "$current_postimage_database"
move_receipts_after_stage_five="$(move_receipt_fingerprint "$current_postimage_database")"
if [[ "$move_receipts_after_stage_five" != "$move_receipts_before" ]]; then
  echo 'Stage-B #1-#5 changed the immutable hotfix move-receipt ledger.' >&2
  exit 1
fi
create_scenario_database 'keyshare_mixed' "$current_postimage_database"
mixed_database="$created_scenario_database"
seed_synthetic_freeze "$mixed_database"

create_scenario_database 'keyshare_clean' "$current_postimage_database"
clean_database="$created_scenario_database"
seed_synthetic_freeze "$clean_database"

run_keyshare_unknown_preimage_rollback "$mixed_database"
assert_stage_b_bounded_postimage "$mixed_database"
run_chain_prefix 6 true "$clean_database" 5
assert_stage_b_bounded_postimage "$clean_database"
run_tournament_cancellation_entrant_refunds "$clean_database"
run_bounty_rebuy_generation_atomicity "$clean_database"
run_elimination_seat_exit_authority_proof "$clean_database"
run_all_unregistration_origin_proofs "$clean_database"
echo 'STAGE_B_LEASE_KEYSHARE_REPLAY_OK'

move_receipts_after="$(move_receipt_fingerprint "$clean_database")"
if [[ "$move_receipts_after" != "$move_receipts_before" ]]; then
  echo 'The clean Stage-B chain changed the immutable hotfix move-receipt ledger.' >&2
  exit 1
fi
echo 'STAGE_B_HOTFIX_MOVE_RECEIPT_PRESERVED_PG17_OK'

assert_donor_unchanged
echo 'STAGE_B_FORWARD_CHAIN_PG17_OK'
