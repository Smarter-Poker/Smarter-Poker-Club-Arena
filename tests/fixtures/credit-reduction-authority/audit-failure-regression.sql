\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Inject only table triggers, retain the actual writer.
RESET ROLE;
CREATE FUNCTION pg_temp.cr_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_ARGV[0]='suppress' THEN RETURN NULL;END IF;
 IF TG_ARGV[0]='before_audit' THEN NEW.reason:='Unrequested audit reason';RETURN NEW;END IF;
 IF TG_ARGV[0]='after_audit' THEN
  UPDATE public.credit_assignments SET reason='Late audit corruption' WHERE id=NEW.id;RETURN NEW;
 END IF;
 IF TG_ARGV[0]='after_audit_agent' THEN
  UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance+1 WHERE id=NEW.agent_id;RETURN NEW;
 END IF;
 IF TG_ARGV[0]='before_operation' THEN NEW.recorded_at:=NEW.recorded_at+interval '1 microsecond';RETURN NEW;END IF;
 RAISE EXCEPTION 'unknown audit fault';
END$$;
CREATE TRIGGER fixture_credit_audit BEFORE INSERT ON public.credit_assignments FOR EACH ROW
 WHEN(NEW.agent_id='e6371000-0000-4000-8000-000000000220'::uuid) EXECUTE FUNCTION pg_temp.cr_audit_fault('suppress');
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_admin_assignment_write_unconfirmed') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_audit ON public.credit_assignments;
CREATE TRIGGER fixture_credit_audit BEFORE INSERT ON public.credit_assignments FOR EACH ROW
 WHEN(NEW.agent_id='e6371000-0000-4000-8000-000000000220'::uuid) EXECUTE FUNCTION pg_temp.cr_audit_fault('before_audit');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_admin_assignment_write_unconfirmed') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_audit ON public.credit_assignments;
CREATE TRIGGER fixture_credit_audit AFTER INSERT ON public.credit_assignments FOR EACH ROW
 WHEN(NEW.agent_id='e6371000-0000-4000-8000-000000000220'::uuid) EXECUTE FUNCTION pg_temp.cr_audit_fault('after_audit');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_admin_assignment_retained_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_audit ON public.credit_assignments;
CREATE TRIGGER fixture_credit_audit AFTER INSERT ON public.credit_assignments FOR EACH ROW
 WHEN(NEW.agent_id='e6371000-0000-4000-8000-000000000220'::uuid) EXECUTE FUNCTION pg_temp.cr_audit_fault('after_audit_agent');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_admin_agent_retained_mismatch') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_audit ON public.credit_assignments;
CREATE TRIGGER fixture_credit_operation BEFORE INSERT ON public.accounting_credit_reduction_operations_v1
 FOR EACH ROW EXECUTE FUNCTION pg_temp.cr_audit_fault('suppress');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_operation_write_unconfirmed') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_operation ON public.accounting_credit_reduction_operations_v1;
CREATE TRIGGER fixture_credit_operation BEFORE INSERT ON public.accounting_credit_reduction_operations_v1
 FOR EACH ROW EXECUTE FUNCTION pg_temp.cr_audit_fault('before_operation');
SET LOCAL ROLE authenticated;
SELECT pg_temp.cr_expect_atomic_failure(q,'23514','credit_reduction_operation_write_unconfirmed') FROM cr_failure_intent;
RESET ROLE;DROP TRIGGER fixture_credit_operation ON public.accounting_credit_reduction_operations_v1;
-- A failure at any stage must leave the original action usable, not secretly
-- retired or partially recorded. Complete the exact original operation once.
SET LOCAL ROLE authenticated;
DO $after_faults$ DECLARE q jsonb;e jsonb;BEGIN
 SELECT q0.q INTO STRICT q FROM cr_failure_intent q0;e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,7,93,false);
 INSERT INTO cr_saved VALUES('after_faults',q,e,NULL);
END$after_faults$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
