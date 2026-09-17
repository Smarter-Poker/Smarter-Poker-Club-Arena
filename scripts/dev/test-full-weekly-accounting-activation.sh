#!/usr/bin/env bash
# Payload for approved protected execution; never a direct pipeline fallback.
# Relocated/expanded payload is UNRUN pending protected admission.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/tests/fixtures/full-weekly-accounting"
lifecycle="$root/tests/fixtures/tournament-fee-lifecycle"
correction_writer="$root/tests/fixtures/correction-writer-authority"
credit_reduction="$root/tests/fixtures/credit-reduction-authority"
: "${PG_BIN:?Qualified PostgreSQL provider must be supplied by the protected plan}"
: "${ACCOUNTING_FIXTURE_PARENT:?Reserved scratch directory must be supplied by the protected plan}"
: "${ACCOUNTING_TEST_OUTPUT_DIR:?Reserved durable output directory must be supplied by the protected plan}"
: "${ACCOUNTING_ACTIVATION_DIR:?Source-bound generated artifact directory must be supplied by the protected plan}"
candidate="$ACCOUNTING_ACTIVATION_DIR/candidate.sql"
privacy_predecessor="$ACCOUNTING_ACTIVATION_DIR/qualification-preprivacy.sql"
fixture_baseline="$ACCOUNTING_ACTIVATION_DIR/qualification-credit-baseline.sql"
pgbin="$PG_BIN"
mkdir -p "$ACCOUNTING_TEST_OUTPUT_DIR"
fixture=''
phase=''
started=0
fixture_retained=0
finish_fixture() {
  [ -n "$fixture" ] || return 0
  # A prior failed cleanup must never lose its sticky evidence-retention state.
  [ "$fixture_retained" = 0 ] || return 1
  local result=0 archive_failed=0 shutdown_failed=0 evidence_failed=0
  if [ "$started" = 1 ]; then
    if [ "$phase" = correction-writer-concurrency ]; then
      # Capture committed state on both success and failure before backend
      # retirement. A failed/partial capture must retain the stopped fixture.
      if ! PGCONNECT_TIMEOUT=5 PGPASSFILE=/dev/null "$pgbin/psql" -X -w -q -A -t -v ON_ERROR_STOP=1 \
        -U postgres -h "$fixture/socket" -p 55507 -d "$fixture_db" \
        -c "SET statement_timeout='10s';SET lock_timeout='2s';SET TimeZone='UTC';SET DateStyle='ISO,YMD';" \
        -f "$work/capture-rollback-state.sql" > "$fixture/correction-concurrency-final-rows.txt" 2> "$fixture/correction-concurrency-final-capture.log"; then
        evidence_failed=1
        result=1
      fi
    fi
    if [ "$phase" = credit-reduction-concurrency ]; then
      if ! PGCONNECT_TIMEOUT=5 PGPASSFILE=/dev/null "$pgbin/psql" -X -w -q -A -t -v ON_ERROR_STOP=1 \
        -U postgres -h "$fixture/socket" -p 55507 -d "$fixture_db" \
        -f "$credit_reduction/capture-final-state.sql" > "$fixture/credit-concurrency-final-rows.txt" 2> "$fixture/credit-concurrency-final-capture.log"; then
        evidence_failed=1
        result=1
      fi
    fi
    if ! "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop > "$fixture/stop.log" 2>&1; then
      result=1
      shutdown_failed=1
    fi
    started=0
  fi
  for artifact in credit-reduction.log credit-concurrency-setup.log credit-concurrency.log credit-concurrency-rows.txt credit-concurrency-final-rows.txt credit-concurrency-final-capture.log accepted-credit-reduction-authority.json initdb.log correction-concurrency-setup.log correction-concurrency.log correction-concurrency-rows.txt correction-concurrency-final-rows.txt correction-concurrency-final-capture.log start.log server.log stop.log baseline.log activation.log rejected.log assertions.log pnl-hooks.log historical-conflict.log period-authority.log period-privacy.log privacy-rejected.log messenger-privacy.log messenger-weekly.log push-ownership.log push-rotation.log credit-request.log cashier-document.log correction-document.log browser-period-observer.log scheduler-catalog.log managed-cron-role.log cron-before.json cron-after.json cron-fixture.log before.sql after.sql before-rows.txt after-rows.txt before-roles.txt after-roles.txt accepted-schema.sql accepted-authority.json accepted-correction-writer-authority.json accepted-roles.json accepted-rows.txt; do
    if [ -f "$fixture/$artifact" ]; then
      if ! cp "$fixture/$artifact" "$ACCOUNTING_TEST_OUTPUT_DIR/$phase/$artifact"; then
        result=1
        archive_failed=1
      fi
    fi
  done
  # Failed archival must preserve the only logs, even when shutdown succeeded.
  if [ -f "$fixture/data/postmaster.pid" ] || [ "$archive_failed" = 1 ] || [ "$shutdown_failed" = 1 ] || [ "$evidence_failed" = 1 ]; then
    fixture_retained=1
    echo "ERROR: fixture retained for protected cleanup/evidence recovery: $fixture" >&2
    result=1
  else
    if rm -rf "$fixture"; then fixture=''; else result=1; fixture_retained=1; fi
  fi
  return "$result"
}
cleanup() {
  result=$?
  trap - EXIT
  if ! finish_fixture; then result=1; fi
  exit "$result"
}
trap cleanup EXIT

python3 - "$root" "$work" <<'PY'
from pathlib import Path
import hashlib, json, sys
root, work = map(Path, sys.argv[1:])
binding = json.loads((work / 'source-binding.json').read_text())
for name, expected in binding['fixtures'].items():
    if hashlib.sha256((work / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Captured fixture drift: ' + name)
for name, expected in binding['repository_fixtures'].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Repository lifecycle fixture drift: ' + name)
PY
python3 "$root/scripts/ci/build-weekly-accounting-activation.py" --output-dir "$ACCOUNTING_ACTIVATION_DIR" --check
python3 "$root/tests/fixtures/pnl-evidence/verify-wrapper-source-binding.py"

# Use sequential independent clusters. The real pg_cron launcher can keep a
# database connection even with job launching disabled, so do not clone it.
for phase in rejection-provenance rejection-authority rejection-privacy-bypass rejection-privacy rejection-messenger-reader rejection-push-writer rejection-push-rotation rejection-credit-request rejection-cashier-document rejection-correction-document rejection-browser-period rejection-correction-writer acceptance correction-writer-concurrency rejection-credit-reduction credit-reduction-concurrency; do
mkdir "$ACCOUNTING_TEST_OUTPUT_DIR/$phase"
fixture=$(mktemp -d "$ACCOUNTING_FIXTURE_PARENT/accounting-activation.XXXXXX")
fixture_retained=0
python3 - "$fixture" <<'PY'
from pathlib import Path
import re, sys
fixture = Path(sys.argv[1])
if not re.fullmatch(r'[A-Za-z0-9_./-]+', str(fixture)):
    raise SystemExit('Use an admitted short ASCII scratch path without whitespace for pg_ctl socket parsing')
if len(str(fixture / 'socket' / '.s.PGSQL.55507').encode()) > 100:
    raise SystemExit('Reserved scratch directory is too long for a portable Unix socket')
PY
mkdir "$fixture/socket"
fixture_db=postgres
fixture_bootstrap=postgres
# The bootstrap superuser cannot be demoted. Only the acceptance cluster later
# tests managed postgres permissions, so give it a separate bootstrap identity.
if [ "$phase" = acceptance ]; then fixture_bootstrap=accounting_fixture_bootstrap; fi
"$pgbin/initdb" -D "$fixture/data" -U "$fixture_bootstrap" -A trust --no-locale -E UTF8 > "$fixture/initdb.log" 2>&1
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55507 -h '' -c shared_preload_libraries=pg_cron -c cron.database_name=$fixture_db -c cron.launch_active_jobs=off" start > "$fixture/start.log" 2>&1
started=1
if [ "$phase" = acceptance ]; then
  "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U "$fixture_bootstrap" -h "$fixture/socket" -p 55507 -d postgres \
    -c 'CREATE ROLE postgres LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS; ALTER DATABASE postgres OWNER TO postgres;'
fi
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$fixture/socket" -p 55507)
"${psql[@]}" -d "$fixture_db" \
  -f "$fixture_baseline" -f "$work/policies.sql" -f "$work/access.sql" -f "$work/seed-registry.sql" \
  -f "$root/tests/fixtures/accounting-alert-38644/installed-period-basis.sql" \
  -f "$root/tests/fixtures/pnl-evidence/legacy-pnl-core-preimage.sql" \
  -f "$root/tests/fixtures/pnl-evidence/legacy-pnl-wrapper-preimages.sql" \
  -f "$work/legacy-recompute-definition.sql" \
  -f "$work/supplemental-function-access.sql" \
  -f "$work/legacy-period-writers-definitions.sql" \
  -f "$work/legacy-period-writers-access.sql" \
  -f "$root/tests/fixtures/messenger-private-accounting/captured-preimages.sql" \
  -f "$root/tests/fixtures/credit-request-authority/captured-preimages.sql" \
  -f "$root/tests/fixtures/cashier-document-authority/captured-preimages.sql" \
  -f "$root/tests/fixtures/correction-document-authority/captured-preimages.sql" \
  -f "$root/tests/fixtures/browser-period-observer/captured-preimages.sql" \
  -f "$correction_writer/catalog-bootstrap.sql" \
  -f "$credit_reduction/captured-dependencies.sql" \
  -f "$credit_reduction/captured-ledger-dependency.sql" \
  -f "$credit_reduction/catalog-bootstrap.sql" \
  -f "$credit_reduction/incoming-relations-bootstrap.sql" \
  -f "$root/tests/fixtures/weekly-scheduler-timing/captured-cron-prerequisites.sql" \
  -f "$lifecycle/current-settlement-predecessor.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/alerts-and-ledger.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/owner-notification-coexistence.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/direct-intake-prerequisites.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/direct-intake-installed.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/direct-intake-receipt-row-successor.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/finish-lane-prerequisites.sql" \
  -f "$root/supabase/migrations/20260917113717_the_finish_lane_is_exclusive_among_finishes.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/finish-lane-installed-readback.sql" \
  -f "$root/tests/fixtures/rakeback-write-authority/captured-stats-batch.sql" \
  -f "$root/tests/fixtures/union-provider-preimages-20260917/money-registry-ddl-guard.sql" 2>&1 | tee "$fixture/baseline.log"
# Actual extension-owned unrelated job: disabled launcher makes it inert.
"${psql[@]}" -A -t -d "$fixture_db" -c "SELECT cron.schedule('fixture-full-activation-unrelated','17 * * * *','SELECT 1');" > "$fixture/cron-fixture.log"
"${psql[@]}" -A -t -d "$fixture_db" -c 'SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j;' > "$fixture/cron-before.json"
if [ "$phase" = rejection-privacy ]; then
# Earlier guards correctly reject client inheritance of service_role. Stage
# the exact source-bound prefix first so this distinct probe reaches 161500.
# This qualifies that privacy component's guard, not a full-bundle rollback.
"${psql[@]}" -d "$fixture_db" -f "$privacy_predecessor" 2>&1 | tee "$fixture/activation.log"
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/before.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/before-rows.txt"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-roles.sql" > "$fixture/before-roles.txt"
# Command tags and SQLSTATE are required to distinguish the intended guard
# error/ROLLBACK from unrelated SQL errors hidden in an expected-failure file.
"$pgbin/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U postgres -h "$fixture/socket" -p 55507 -d "$fixture_db" \
  -f "$root/tests/fixtures/rakeback-history-privacy/rejected-service-membership.sql" 2>&1 | tee "$fixture/privacy-rejected.log"
python3 - "$fixture/privacy-rejected.log" <<'PY'
from pathlib import Path
import re, sys
log = Path(sys.argv[1]).read_text()
errors = re.findall(r'ERROR:\s+([0-9A-Z]{5}): ([^\n]+)', log)
expected = ('P0001', 'rakeback privacy unsafe API role: authenticated')
if len(errors) != len(re.findall(r'ERROR:', log)) or errors.count(expected) != 1 or any(error != expected and error[0] != '25P02' for error in errors):
    raise SystemExit('Privacy guard did not produce only its exact refusal and aborted-transaction follow-ons')
if len(re.findall(r'^ROLLBACK\s*$', log, re.M)) != 1:
    raise SystemExit('Privacy guard transaction rollback was not observed')
for notice in (
    'privacy guard assertion passed: inherited service role refused with unchanged policies, ACLs and role graph',
    'privacy guard assertion passed: original role graph restored',
):
    if log.count(notice) != 1:
        raise SystemExit('Missing or duplicated privacy guard assertion: ' + notice)
PY
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/after.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/after-rows.txt"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-roles.sql" > "$fixture/after-roles.txt"
cmp "$fixture/before.sql" "$fixture/after.sql"
cmp "$fixture/before-rows.txt" "$fixture/after-rows.txt"
cmp "$fixture/before-roles.txt" "$fixture/after-roles.txt"
echo 'PASS: final privacy component refuses inherited service access and restores the original fixture state'
elif [ "$phase" != acceptance ] && [ "$phase" != correction-writer-concurrency ] && [ "$phase" != credit-reduction-concurrency ]; then
expected_detail=''
if [ "$phase" = rejection-provenance ]; then
# Refuse an earning-club default after cron retirement.
"${psql[@]}" -d "$fixture_db" -c "ALTER TABLE public.rake_attributions ALTER COLUMN club_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid;"
expected_refusal='unknown earning club must remain nullable without a default'
elif [ "$phase" = rejection-privacy-bypass ]; then
# BYPASSRLS does not add table or function privileges, so the final privacy
# guard must reject it after all preceding components, including write closure.
"${psql[@]}" -d "$fixture_db" -c 'ALTER ROLE authenticated BYPASSRLS;'
expected_refusal='rakeback privacy unsafe API role: authenticated'
elif [ "$phase" = rejection-messenger-reader ]; then
# A changed installed reader must refuse after scheduler transition/retirement,
# continuation and timing, restoring the captured incoming job catalog too.
"${psql[@]}" -d "$fixture_db" -c "ALTER FUNCTION public.fn_messenger_search_messages(uuid,uuid[],text,integer) SET statement_timeout TO '2s';"
expected_refusal='messenger_search_source_changed'
elif [ "$phase" = rejection-push-writer ]; then
# An undisclosed client enrollment writer must refuse the final component.
"${psql[@]}" -d "$fixture_db" -c 'CREATE POLICY fixture_unsafe_push_writer ON public.push_subscriptions FOR INSERT TO authenticated WITH CHECK (true);'
expected_refusal='push_ownership_client_writer_present'
elif [ "$phase" = rejection-push-rotation ]; then
# A conflicting version contract must refuse after all original 30 components,
# restoring the actual incoming cron, endpoint indexes and ownership authority.
"${psql[@]}" -d "$fixture_db" -c 'ALTER TABLE public.push_subscriptions ADD COLUMN rotation_revision bigint;'
expected_refusal='push_rotation_contract_already_exists'
elif [ "$phase" = rejection-credit-request ]; then
# Changed credit notification authority must refuse the complete transaction,
# including the preceding subscription revision schema and trigger.
"${psql[@]}" -d "$fixture_db" -c "ALTER FUNCTION public.fn_notify_credit_request() SET statement_timeout TO '2s';"
expected_refusal='credit_request_notification_preimage_changed'
elif [ "$phase" = rejection-cashier-document ]; then
# Refuse a changed cashier writer at its component and restore the whole bundle.
"${psql[@]}" -d "$fixture_db" -c "ALTER FUNCTION public.fn_cashout_approve(uuid,text,uuid) SET statement_timeout TO '2s';"
expected_refusal='cashier_writer_preimage_changed'
expected_detail='fn_cashout_approve(uuid,text,uuid)'
elif [ "$phase" = rejection-correction-document ]; then
# The correction document must preserve the captured correction writer. A changed
# configuration refuses after all33 predecessors without partial authority changes.
"${psql[@]}" -d "$fixture_db" -c "ALTER FUNCTION public.fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb) SET lock_timeout TO '1s';"
expected_refusal='correction_document_dependency_preimage_changed'
expected_detail='fn_ca_post_correction(text,uuid,text,uuid,numeric,text,uuid,bigint,uuid,uuid,jsonb)'
elif [ "$phase" = rejection-browser-period ]; then
# Refuse a changed legacy status writer after all34 predecessor components;
# period/RPC retirement and the observer must share the one atomic activation.
"${psql[@]}" -d "$fixture_db" -c "ALTER FUNCTION public.fn_set_settlement_period_status(uuid,text) SET lock_timeout TO '1s';"
expected_refusal='legacy_period_function_preimage_changed'
expected_detail='fn_set_settlement_period_status(uuid,text)'
elif [ "$phase" = rejection-correction-writer ]; then
# A new-name conflict passes all35 original components, then must refuse36.
# Altering the old writer instead would only repeat component34's guard.
"${psql[@]}" -d "$fixture_db" -c 'CREATE TABLE public.ca_correction_request_intents_v1(fixture_conflict boolean);'
expected_refusal='correction_writer_contract_preexists'
expected_detail='public.ca_correction_request_intents_v1'
elif [ "$phase" = rejection-credit-reduction ]; then
# A new credit contract collision must pass all36 predecessor components and
# refuse37 without partially retaining the revision, writer or document changes.
"${psql[@]}" -d "$fixture_db" -c 'CREATE TABLE public.accounting_credit_reduction_operations_v1(fixture_conflict boolean);'
expected_refusal='credit_reduction_contract_preexists'
expected_detail='public.accounting_credit_reduction_operations_v1'
else
# An inherited column grant survives direct table/column revocation. The final
# authority postcondition must refuse it after retiring the legacy RPC and
# revoking direct rights. Never repair an unknown role graph during activation.
"${psql[@]}" -d "$fixture_db" <<'SQL'
CREATE ROLE accounting_fixture_inherited_column NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT UPDATE (rakeback_amount) ON public.rakeback_periods TO accounting_fixture_inherited_column;
GRANT accounting_fixture_inherited_column TO service_role WITH INHERIT TRUE;
SQL
expected_refusal='rakeback_write_authority_effective_column_privilege_remains: rakeback_periods.service_role:UPDATE'
fi
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/before.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/before-rows.txt"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-roles.sql" > "$fixture/before-roles.txt"
if "${psql[@]}" -v VERBOSITY=verbose -d "$fixture_db" -c 'SET search_path=public,pg_temp;' -f "$candidate" > "$fixture/rejected.log" 2>&1; then
  echo "ERROR: activation did not refuse the injected $phase contract" >&2
  exit 1
fi
# Match the emitted root error, never a guard name quoted in PL/pgSQL CONTEXT.
# ON_ERROR_STOP makes any earlier SQL/syntax/runtime failure an invalid probe.
python3 - "$fixture/rejected.log" "$expected_refusal" "$expected_detail" <<'PY'
from pathlib import Path
import re, sys
log = Path(sys.argv[1]).read_text()
header = r'^(?:psql:[^\n]*?:\d+:[ \t]*)?ERROR:'
errors = re.findall(header + r'[ \t]+([0-9A-Z]{5}): ([^\n]+)$', log, re.M)
if len(re.findall(header, log, re.M)) != 1 or errors != [('P0001', sys.argv[2])]:
    raise SystemExit('Full activation did not produce only the exact expected root refusal: ' + repr(errors))
if sys.argv[3]:
    details = re.findall(r'^DETAIL:\s+([^\n]+)$', log, re.M)
    if details != [sys.argv[3]]:
        raise SystemExit('Full activation refused a different dependency: ' + repr(details))
PY
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/after.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/after-rows.txt"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-roles.sql" > "$fixture/after-roles.txt"
cmp "$fixture/before.sql" "$fixture/after.sql"
cmp "$fixture/before-rows.txt" "$fixture/after-rows.txt"
cmp "$fixture/before-roles.txt" "$fixture/after-roles.txt"
echo 'PASS: late activation refusal leaves captured schema, access and application/cron rows unchanged; sequence allocation excluded'
elif [ "$phase" = credit-reduction-concurrency ]; then
# Exact public-entry races use their own isolated cluster and retained run marker.
"${psql[@]}" -d "$fixture_db" -f "$candidate" 2>&1 | tee "$fixture/activation.log"
"${psql[@]}" -d "$fixture_db" -f "$credit_reduction/concurrency-setup.sql" 2>&1 | tee "$fixture/credit-concurrency-setup.log"
python3 "$credit_reduction/concurrency-regression.py" "$pgbin/psql" "$fixture/socket" 55507 "$fixture_db" 2>&1 | tee "$fixture/credit-concurrency.log"
"${psql[@]}" -A -t -d "$fixture_db" -f "$credit_reduction/capture-final-state.sql" > "$fixture/credit-concurrency-rows.txt"
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/accepted-schema.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$credit_reduction/accepted-authority-supplement.sql" > "$fixture/accepted-credit-reduction-authority.json"
# Common cleanup captures committed credit evidence on failure too, and retains
# the fixture if capture, archival or actual backend retirement is uncertain.
elif [ "$phase" = correction-writer-concurrency ]; then
# A separate real cluster keeps committed concurrent evidence out of the
# rollback-only acceptance book. The preserved cron guard requires postgres;
# a fresh cluster/socket and setup marker distinguish this disposable database.
"${psql[@]}" -d "$fixture_db" -f "$candidate" 2>&1 | tee "$fixture/activation.log"
"${psql[@]}" -d "$fixture_db" -f "$correction_writer/concurrency-setup.sql" 2>&1 | tee "$fixture/correction-concurrency-setup.log"
python3 "$correction_writer/concurrency-regression.py" "$pgbin/psql" "$fixture/socket" 55507 "$fixture_db" 2>&1 | tee "$fixture/correction-concurrency.log"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/correction-concurrency-rows.txt"
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/accepted-schema.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$correction_writer/accepted-authority-supplement.sql" > "$fixture/accepted-correction-writer-authority.json"
# psql client retirement alone is not backend cancellation. The common
# finish_fixture must observe actual pg_ctl stop before deleting this cluster.
else
# Retain the predecessor-created legacy request in pg_temp across installation
# and all correction probes. Separate psql calls would lose its original input.
# Each post-install regression rolls back its own probes; the isolated committed
# legacy seed remains explicit and is never treated as a production row.
"${psql[@]}" -d "$fixture_db" \
  -f "$correction_writer/captured-store-policy.sql" \
  -f "$correction_writer/legacy-before-candidate.sql" \
  -f "$root/tests/fixtures/rakeback-write-authority/preactivation-regression.sql" \
  -f "$candidate" \
  -f "$root/tests/fixtures/rakeback-write-authority/transition-regression.sql" \
  -f "$correction_writer/legacy-replay-and-input-assertions.sql" \
  -f "$correction_writer/regression.sql" \
  -f "$correction_writer/owner-seeded-regression.sql" 2>&1 | tee "$fixture/activation.log"
echo 'PASS: full candidate installed atomically; legacy statistics retirement and correction probes completed in the retained legacy session'
# Record accepted definitions/access after the explicit isolated legacy seed
# and rolled-back correction probes, before the other synthetic financial
# probes. Source hashes or rejected-state dumps cannot supply this receipt.
"$pgbin/pg_dump" --schema-only -U postgres -h "$fixture/socket" -p 55507 "$fixture_db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$fixture/accepted-schema.sql"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-accepted-authority.sql" > "$fixture/accepted-authority.json"
"${psql[@]}" -A -t -d "$fixture_db" -f "$correction_writer/accepted-authority-supplement.sql" > "$fixture/accepted-correction-writer-authority.json"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-roles.sql" > "$fixture/accepted-roles.json"
"${psql[@]}" -A -t -d "$fixture_db" -f "$work/capture-rollback-state.sql" > "$fixture/accepted-rows.txt"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/weekly-scheduler-timing/full-activation-cron-regression.sql" 2>&1 | tee "$fixture/scheduler-catalog.log"
"${psql[@]}" -A -t -d "$fixture_db" -c 'SELECT jsonb_agg(to_jsonb(j) ORDER BY j.jobid) FROM cron.job j;' > "$fixture/cron-after.json"
python3 - "$fixture/cron-before.json" "$fixture/cron-after.json" <<'PY'
from pathlib import Path
import json, sys
before, after = (json.loads(Path(p).read_text()) for p in sys.argv[1:])
if sum(j['jobid'] == 271 for j in before) != 1 or sum(j['jobid'] == 272 for j in before) != 1:
    raise SystemExit('Actual captured cron identities missing from baseline')
expected = [dict(j, schedule='0,30 * * * *') if j['jobid'] == 272 else j
            for j in before if j['jobid'] != 271]
if after != expected:
    raise SystemExit('Final scheduler changed more than retirement and exact canonical schedule')
print('PASS: actual incoming cron identity/command/role/destination and unrelated job preserved; only duplicate retirement and canonical schedule changed')
PY
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$correction_writer/lifecycle-seed-after-activation.sql" \
  -f "$lifecycle/full-lifecycle-normal.sql" \
  -f "$lifecycle/full-lifecycle-satellite.sql" \
  -f "$lifecycle/full-lifecycle-earning.sql" \
  -f "$lifecycle/full-lifecycle-deferred.sql" 2>&1 | tee "$fixture/assertions.log"
python3 - "$fixture/assertions.log" "$work/source-binding.json" <<'PY'
from pathlib import Path
import json, re, sys
expected = json.loads(Path(sys.argv[2]).read_text())['expected_lifecycle_assertion_executions']
count = len(re.findall(r'NOTICE:\s+PASS ', Path(sys.argv[1]).read_text()))
if count != expected:
    raise SystemExit(f'Assertion count changed: expected {expected}, observed {count}')
print(f'Tournament lifecycle assertion executions: {count}')
PY
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/accounting-alert-38644/regression.sql" 2>&1 | tee "$fixture/historical-conflict.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/pnl-evidence/hooks-seed.sql" \
  -f "$root/tests/fixtures/pnl-evidence/hooks-regression.sql" 2>&1 | tee "$fixture/pnl-hooks.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/rakeback-write-authority/regression.sql" 2>&1 | tee "$fixture/period-authority.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/rakeback-history-privacy/regression.sql" 2>&1 | tee "$fixture/period-privacy.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/messenger-private-accounting/messenger-private-readers-regression.sql" 2>&1 | tee "$fixture/messenger-privacy.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/messenger-private-accounting/messenger-private-weekly-summary-regression.sql" 2>&1 | tee "$fixture/messenger-weekly.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/push-subscription-ownership/push-subscription-ownership-regression.sql" 2>&1 | tee "$fixture/push-ownership.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/push-subscription-rotation/regression.sql" 2>&1 | tee "$fixture/push-rotation.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/credit-request-authority/regression.sql" 2>&1 | tee "$fixture/credit-request.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/cashier-document-authority/regression.sql" 2>&1 | tee "$fixture/cashier-document.log"
# The successor correction-document regression already ran in activation.log
# in the retained legacy session. The historical34/35 fixture stays unchanged
# in source custody; its old replay/NaN expectations do not apply to36.
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$root/tests/fixtures/browser-period-observer/regression.sql" 2>&1 | tee "$fixture/browser-period-observer.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$credit_reduction/regression.sql" 2>&1 | tee "$fixture/credit-reduction.log"
"${psql[@]}" -A -t -d "$fixture_db" \
  -f "$credit_reduction/accepted-authority-supplement.sql" > "$fixture/accepted-credit-reduction-authority.json"
# Last probe in this disposable acceptance cluster: recreate actual disabled
# pg_cron under a distinct extension owner, then test SELECT-only postgres.
# It deliberately changes fixture role/extension setup after accepted evidence
# capture. No later financial probe runs under this different role model.
python3 "$root/tests/fixtures/weekly-scheduler-timing/managed-cron-role-regression.py" \
  "$pgbin/psql" "$fixture/socket" 55507 "$fixture_db" "$fixture/cron-before.json" \
  2>&1 | tee "$fixture/managed-cron-role.log"
fi
finish_fixture
done

# Original boundary capture is a separate prospective successor, never part of
# the sealed installed 37-component migration or a replay of it.
bash "$root/scripts/dev/test-union-pnl-inventory.sh"
