#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work="$root/tests/fixtures/accounting-push"
alerts="$root/scripts/dev/fixtures/owner-accounting-alerts"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/accounting-push-test.XXXXXX")
started=0
cleanup(){ if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
# The mirror bodies this list names. A migration that defines
# fn_mirror_notification_to_push_outbox() and is not one of them, newer than
# the first, is applied after them in version order: the owner regression then
# judges the body production would end up running, not the body this list
# names, and a later body whose pre-image guard no longer matches fails here as
# it would on apply. Version order is not application order (#5489's version
# sorts before 20260928032225), so "newer than the first" is the rule, not
# "newer than the last".
mirrors=(20260914141405_accounting_notifications_require_durable_push_receipts.sql
 20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql
 20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql)
defines_mirror='create[[:space:]]+(or[[:space:]]+replace[[:space:]]+)?function[[:space:]]+("?public"?[[:space:]]*\.[[:space:]]*)?"?fn_mirror_notification_to_push_outbox"?[[:space:]]*\('
later=()
while IFS= read -r f; do
 b=${f##*/}
 [[ "$b" > "${mirrors[0]}" ]] || continue
 [[ " ${mirrors[*]} " == *" $b "* ]] && continue
 if tr '\n' ' ' < "$f" | grep -qiE "$defines_mirror"; then later+=(-f "$f"); fi
done < <(grep -li 'fn_mirror_notification_to_push_outbox' "$root"/supabase/migrations/*.sql | LC_ALL=C sort)
if [ ${#later[@]} -gt 0 ]; then echo "test-accounting-push-bridge: also applying $(( ${#later[@]} / 2 )) later mirror migration(s): ${later[*]}" >&2; fi
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
 -f "$work/regression.sql" \
 -f "$work/bridge-installed-cashier-generation.sql" \
 -f "$alerts/operational-alert-store.sql" \
 -f "$root/supabase/migrations/20260927143752_owner_accounting_notifications_routed_to_production_alerts.sql" \
 -f "$root/supabase/migrations/20260928032225_owner_accounting_alerts_carry_the_fleet_address.sql" \
 ${later[@]+"${later[@]}"} \
 -f "$alerts/owner-routing-regression.sql"
