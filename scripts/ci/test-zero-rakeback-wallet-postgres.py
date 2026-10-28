#!/usr/bin/env python3
"""Run the actual original R2/R3 financial family with the narrow wallet-cohort installer."""
from pathlib import Path
import sys
root=Path(__file__).resolve().parents[2]
base=root/'scripts/ci/test-existing-transfer-discharge-postgres.py'
source=base.read_text()
marker="    for label,call in [('main',R2),('v3',R2V3),('cached-main',R2)]:"
assert source.count(marker)==1
extra=r'''    history_ddl=(R/'supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql').read_text()
    q(history_ddl[history_ddl.index('CREATE TABLE public.accounting_agreement_history'):history_ddl.index('CREATE FUNCTION public.fn_accounting_agreement_terms')])
    zero_setup="UPDATE rakeback_periods SET rakeback_amount=0,rakeback_earned=0,rakeback_rate=0 WHERE user_id=caw_u('P2');UPDATE accounting_rakeback_period_calculations SET rakeback_amount=0,display_rate=0,source_allocations=jsonb_set(source_allocations,'{0,rate}','0') WHERE player_id=caw_u('P2');UPDATE accounting_rakeback_period_calculations SET source_fingerprint=md5(jsonb_build_object('allocations',source_allocations,'rake',rake_generated,'amount',rakeback_amount,'rate',display_rate)::text)WHERE player_id=caw_u('P2');DELETE FROM club_members WHERE user_id=caw_u('P2');"
    ed_case('old-zero-entitlement-missing-wallet-blocks-positive-players',zero_setup+'SELECT '+R2+';SELECT '+R3+';','routed_rakeback_account_missing_or_invalid')
    wallet_migration=R/'supabase/migrations/20261027171556_zero_rakeback_receipts_need_no_player_wallet.sql'
    oldmeta=q("SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure").stdout.strip()
    frozen=q(wallet_migration.read_text().replace('BEGIN;','BEGIN;UPDATE dr_controls SET frozen=true;',1),check=False)
    assert frozen.returncode and 'zero_rakeback_wallet_install_frozen' in frozen.stderr
    forced=q(wallet_migration.read_text().replace('COMMIT;',"DO $$BEGIN RAISE EXCEPTION 'forced_wallet_rollback';END$$;COMMIT;"),check=False)
    assert forced.returncode and 'forced_wallet_rollback' in forced.stderr
    assert q("SELECT md5(pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))").stdout.strip()=='38e8a0bf0b309b973391107e3bd934d0'
    load(wallet_migration)
    assert q("SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure").stdout.strip()==oldmeta
    assert q("SELECT md5(pg_get_functiondef('fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'::regprocedure))").stdout.strip()=='b07dc0dc2bdfa00973b4613e0cfb83d5'
    replay=q(wallet_migration.read_text(),check=False);assert replay.returncode and 'zero_rakeback_wallet_owner_preimage_changed' in replay.stderr
    results.append({'case':'exact-positive-wallet-installer-frozen-rollback-metadata-postimage-replay','passed':True})
    ed_case('zero-entitlement-paid-receipt-without-wallet-or-credit',zero_setup+'SELECT '+R2+';SELECT '+R3+";SELECT caw_assert(NOT EXISTS(SELECT FROM club_members WHERE user_id=caw_u('P2')),'zero wallet nevercreated');SELECT caw_assert((SELECT status='paid' FROM rakeback_periods WHERE user_id=caw_u('P2')),'zero periodclosed');SELECT caw_assert((SELECT count(*)=1 AND sum(payout_amount)=0 FROM rakeback_period_payouts WHERE user_id=caw_u('P2')),'one zero receipt');SELECT caw_assert(NOT EXISTS(SELECT FROM wallet_transactions WHERE user_id=caw_u('P2')),'zero hasnowallettransaction');SELECT caw_assert(NOT EXISTS(SELECT FROM chip_ledger WHERE to_entity_id=caw_u('P2') OR from_entity_id=caw_u('P2')),'zero hasnofinancialleg');SELECT "+R3+';')
    ed_case('positive-missing-wallet-still-requires-original-history',"DELETE FROM club_members WHERE user_id=caw_u('P1');SELECT "+R2+';SELECT '+R3+';','historical_wallet_original_history_required')
    ed_case('positive-negative-wallet-refused-by-original-table-constraint',"SET LOCAL app.ledger_autoskip_club_members='1';UPDATE club_members SET chip_balance=-1 WHERE user_id=caw_u('P1');SELECT "+R2+';SELECT '+R3+';','club_members_chip_balance_nonneg')
    ed_case('positive-nan-wallet-remains-refused',"SET LOCAL app.ledger_autoskip_club_members='1';UPDATE club_members SET chip_balance='NaN'::numeric WHERE user_id=caw_u('P1');SELECT "+R2+';SELECT '+R3+';','routed_rakeback_account_missing_or_invalid')
'''
source=source.replace(marker,extra+marker)
exec(compile(source,str(base),'exec'),{'__name__':'__main__','__file__':str(base)})
