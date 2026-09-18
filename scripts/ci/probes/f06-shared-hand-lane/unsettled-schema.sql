CREATE TABLE smarter_private.f06_unsettled_hand_aborts(
 receipt_id uuid PRIMARY KEY,tournament_id uuid NOT NULL,table_id uuid NOT NULL,
 generation uuid NOT NULL,permit_id uuid NOT NULL UNIQUE,hand_number bigint NOT NULL,
 break_id uuid NOT NULL UNIQUE,expected jsonb NOT NULL,
 outcome text NOT NULL DEFAULT 'aborted_unsettled' CHECK(outcome='aborted_unsettled'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tournament_id,generation),UNIQUE(table_id,hand_number));
REVOKE ALL ON smarter_private.f06_unsettled_hand_aborts FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE smarter_private.f06_unsettled_hand_aborts ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.f06_operations ADD COLUMN abort_receipt_id uuid;
ALTER TABLE smarter_private.f06_operations DROP CONSTRAINT f06_operations_state_check;
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_operations_state_check
 CHECK(state IN('park_requested','begun','close_confirmed','acknowledged','withdrawn_before_manifest'));
ALTER TABLE smarter_private.f06_operations ADD CONSTRAINT f06_withdrawal_receipt
 CHECK((state='withdrawn_before_manifest')=(abort_receipt_id IS NOT NULL));
ALTER TABLE smarter_private.f06_hand_permits DROP CONSTRAINT f06_hand_permits_state_check;
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_state_check
 CHECK(state IN('reserved','accepted','never_started','aborted_unsettled'));
DROP INDEX smarter_private.f06_one_source;
CREATE UNIQUE INDEX f06_one_source ON smarter_private.f06_operations(source_table_id)
 WHERE state NOT IN('acknowledged','withdrawn_before_manifest');

CREATE FUNCTION smarter_private.f06_generation_aborted(t uuid,g uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $function$
BEGIN
 -- VOLATILE deliberately takes a fresh command snapshot after any row-lock wait.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND generation=g);
END $function$;
CREATE FUNCTION smarter_private.f06_aborted_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $function$
BEGIN
 IF smarter_private.f06_generation_aborted(NEW.tournament_id,NEW.lease_generation) THEN
 RAISE EXCEPTION 'F06_ABORTED_GENERATION_FENCED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;
-- AFTER is necessary: an INSERT blocked behind the original lease deletion
-- must check the committed tombstone after its unique-index conflict resolves.
CREATE TRIGGER f06_aborted_generation AFTER INSERT OR UPDATE
 ON public.engine_tournament_leases FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_aborted_generation_guard();

CREATE FUNCTION smarter_private.f06_abort_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'F06_ABORT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $function$;
CREATE TRIGGER f06_abort_receipt_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_unsettled_hand_aborts FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();

CREATE FUNCTION smarter_private.f06_aborted_hand_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE t uuid;
BEGIN
 SELECT tournament_id INTO t FROM smarter_private.f06_hand_permits
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF FOUND THEN
 -- A direct SQL insert may already own its row. Never wait for an earlier lane.
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORTED_HAND_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER a00_f06_aborted_hand BEFORE INSERT OR UPDATE ON public.hand_atomic_commits
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
CREATE TRIGGER a00_f06_aborted_history BEFORE INSERT OR UPDATE ON public.hand_history
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_hand_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('hand_atomic_commits','a00_f06_aborted_hand','Permanent interrupted-hand refusal; no monetary write'),
 ('hand_history','a00_f06_aborted_history','Permanent interrupted-hand refusal; no monetary write');
REVOKE ALL ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid),
 smarter_private.f06_aborted_generation_guard(),smarter_private.f06_abort_receipt_immutable(),
 smarter_private.f06_aborted_hand_guard() FROM PUBLIC,anon,authenticated,service_role;
