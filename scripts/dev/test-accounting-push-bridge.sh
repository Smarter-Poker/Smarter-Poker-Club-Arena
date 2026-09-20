#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work="$root/tests/fixtures/accounting-push"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/accounting-push-test.XXXXXX")
started=0
cleanup(){ if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55493 -h ''" start >/dev/null
started=1
sed -n '/^INSERT INTO public.push_outbox(recipient_user_id,title,body,url,event,tag,status,failure_reason,related_entity_id,accounting_notification_id)$/,/^ON CONFLICT(accounting_notification_id) WHERE accounting_notification_id IS NOT NULL DO NOTHING;$/p' "$root/supabase/migrations/20260914141405_accounting_notifications_require_durable_push_receipts.sql" > "$fixture/repeat-backfill.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -d postgres \
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
 -f "$work/regression.sql"
