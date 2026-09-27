#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work="$root/tests/fixtures/accounting-push"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
# Homebrew's postmaster refuses to start on macOS ("postmaster became
# multithreaded during startup") when no locale is set. Linux CI is untouched.
if [ "$(uname -s)" = Darwin ] && [ -z "${LC_ALL:-}" ]; then export LC_ALL=en_US.UTF-8; fi
reach_migration="$root/supabase/migrations/20260927221309_push_delivery_is_for_reachable_recipients.sql"
fixtures=()
cleanup(){
 for f in "${fixtures[@]}"; do
  "$pgbin/pg_ctl" -D "$f/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$f"
 done
}
trap cleanup EXIT

# One throwaway cluster per run. $1 = port, $2 = the reachability migration
# to apply (or /dev/null for the red control on the previous body).
run_chain(){
 local port=$1 reach=$2 fixture
 fixture=$(mktemp -d "${TMPDIR:-/tmp}/accounting-push-test.XXXXXX")
 fixtures+=("$fixture")
 mkdir "$fixture/socket"
 "$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
 "$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p $port -h ''" start >/dev/null
 sed -n '/^INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)$/,/^ON CONFLICT(accounting_notification_id) WHERE accounting_notification_id IS NOT NULL DO NOTHING;$/p' "$root/supabase/migrations/20260914141405_accounting_notifications_require_durable_push_receipts.sql" > "$fixture/repeat-backfill.sql"
 "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres \
  -f "$root/tests/fixtures/accounting-delivery/bootstrap.sql" \
  -f "$root/tests/fixtures/accounting-delivery/baseline.sql" \
  -f "$root/supabase/migrations/20260914113214_accounting_transfers_deliver_one_invoice_message_and_notification.sql" \
  -f "$root/supabase/migrations/20260914113315_transaction_receipts_require_a_source_and_preserve_issued_figures.sql" \
  -f "$root/tests/fixtures/club-weekly-summary/bootstrap.sql" \
  -f "$root/tests/fixtures/club-weekly-summary/delivery-preimage.sql" \
  -f "$root/tests/fixtures/club-weekly-summary/coordinator-preimage.sql" \
  -f "$root/tests/fixtures/club-weekly-summary/legacy.sql" \
  -f "$root/supabase/migrations/20260914124421_clubs_receive_one_weekly_accounting_statement.sql" \
  -f "$root/supabase/migrations/20260914124554_weekly_summary_respects_text_journal_settlement_identity.sql" \
  -f "$root/supabase/migrations/20260914130611_invoice_inboxes_only_show_visible_documents_and_discussions.sql" \
  -f "$root/tests/fixtures/club-weekly-summary/regression.sql" \
  -f "$work/bootstrap.sql" \
  -f "$work/preimage.sql" \
  -f "$work/legacy.sql" \
  -f "$work/historical-fixture.sql" \
  -f "$root/supabase/migrations/20260914141405_accounting_notifications_require_durable_push_receipts.sql" \
  -f "$fixture/repeat-backfill.sql" \
  -f "$work/regression.sql" \
  -f "$work/bridge-installed-cashier-generation.sql" \
  -f "$root/supabase/migrations/20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql" \
  -f "$work/owner-routing-regression.sql" \
  -f "$work/reachability-bootstrap.sql" \
  -f "$reach" \
  -f "$work/reachability-regression.sql"
}

# GREEN: the full chain, ending on the reachability migration and its regression.
run_chain 55493 "$reach_migration"

# RED CONTROL: the same regression against the previous (20260927143752) body
# must FAIL on a behaviour assertion. A regression that passes on the body it
# was written to replace proves nothing.
red_log=$(mktemp "${TMPDIR:-/tmp}/accounting-push-red.XXXXXX")
if run_chain 55494 /dev/null >"$red_log" 2>&1; then
 cat "$red_log"; rm -f "$red_log"
 echo 'RED CONTROL FAILED: the reachability regression passed on the previous body' >&2
 exit 1
fi
if ! grep -q 'FAIL: horse with no device: accounting receipt is skipped no_subscription' "$red_log"; then
 cat "$red_log"; rm -f "$red_log"
 echo 'RED CONTROL FAILED for the wrong reason' >&2
 exit 1
fi
rm -f "$red_log"
echo 'RED CONTROL OK: the previous body fails the reachability regression'
