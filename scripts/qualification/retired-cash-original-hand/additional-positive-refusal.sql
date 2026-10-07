SET ROLE postgres;SET request.jwt.claim.role='service_role';SET request.jwt.claims='{"role":"service_role"}';
CREATE OR REPLACE FUNCTION cash_retirement_native.anonymous_financial_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'anonymous two-custody financial fault' USING ERRCODE='XX000';END $$;
CREATE OR REPLACE FUNCTION cash_retirement_native.anonymous_postcommit_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'anonymous two-custody postcommit fault' USING ERRCODE='XX000';END $$;
CREATE TRIGGER zz_anonymous_financial_fault BEFORE INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION cash_retirement_native.anonymous_financial_fault();
BEGIN;
DO $$DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM cash_retirement_native.anonymous_shape(9);EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=SQLERRM LIKE '%anonymous two-custody financial fault%';END;
 IF NOT refused OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody) OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE asset='chips') OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs) OR EXISTS(SELECT 1 FROM auth.users WHERE id::text LIKE '89%') THEN RAISE EXCEPTION 'POSITIVE_TWO_CUSTODY_FINANCIAL_REFUSAL_NOT_ROLLED_BACK';END IF;
 RAISE NOTICE 'POSITIVE_TWO_CUSTODY_FINANCIAL_REFUSAL_ROLLBACK_PASS';END $$;
ROLLBACK;
DROP TRIGGER zz_anonymous_financial_fault ON public.hand_projection_outbox;
CREATE TRIGGER zz_anonymous_postcommit_fault BEFORE UPDATE OF post_commit_completed_at ON public.hand_atomic_commits FOR EACH ROW WHEN(NEW.post_commit_completed_at IS NOT NULL) EXECUTE FUNCTION cash_retirement_native.anonymous_postcommit_fault();
BEGIN;
DO $$DECLARE refused boolean:=false;BEGIN
 BEGIN PERFORM cash_retirement_native.anonymous_shape(9);EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=SQLERRM LIKE '%POSTCOMMIT%';END;
 IF NOT refused OR EXISTS(SELECT 1 FROM smarter_private.retired_cash_hand_custody) OR EXISTS(SELECT 1 FROM public.ca_mint_ledger WHERE asset='chips') OR EXISTS(SELECT 1 FROM public.hand_atomic_commits) OR EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs) OR EXISTS(SELECT 1 FROM auth.users WHERE id::text LIKE '89%') THEN RAISE EXCEPTION 'POSITIVE_TWO_CUSTODY_POSTCOMMIT_REFUSAL_NOT_ROLLED_BACK';END IF;
 RAISE NOTICE 'POSITIVE_TWO_CUSTODY_POSTCOMMIT_REFUSAL_ROLLBACK_PASS';END $$;
ROLLBACK;
DROP TRIGGER zz_anonymous_postcommit_fault ON public.hand_atomic_commits;
