-- UNRUN. Synthetic supplemental data for the protected full-catalog fixture.
-- Load after tournament-fee-lifecycle/full-lifecycle-seed.sql and the candidate,
-- before hooks-regression.sql. This is not a production baseline or a test of
-- union creation authorization. No source evidence, invoice, ECO or P&L claim
-- is fabricated. The tournament template remains an independent club.
BEGIN;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id='10000000-0000-0000-0000-000000000001')
  OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id='10000000-0000-0000-0000-000000000001') THEN
  RAISE EXCEPTION 'pnl_hook_seed_requires_lifecycle_owner';
 END IF;
 IF EXISTS(SELECT 1 FROM public.unions WHERE id IN
  ('00000000-0000-0000-0000-000000700001','00000000-0000-0000-0000-000000700002')) THEN
  RAISE EXCEPTION 'pnl_hook_seed_identity_conflicts';
 END IF;
END $$;
-- Match the captured lifecycle seed's explicit structural-fixture boundary.
-- Suppress creation allowlist/ladder triggers only while inserting this empty
-- synthetic union; the actual function calls run with all triggers enabled.
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug,settings,total_rake,chip_balance,
 rake_wallet,bbj_wallet,promo_wallet,promo_funded_from_bbj,promo_funded_from_bank)
VALUES('00000000-0000-0000-0000-000000700002','P&L Evidence Probe Union',
 '10000000-0000-0000-0000-000000000001','pnl-evidence-probe-union','{}',0,0,0,0,0,0,0);
INSERT INTO public.union_settlement_floor(union_id,earliest_period_start,reason,created_at)
VALUES('00000000-0000-0000-0000-000000700002','2026-09-07 07:00Z',
 'Synthetic supported-period input; no P&L baseline or earning proof',now());
COMMIT;
