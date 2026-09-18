-- Original-process preparation cancellation, before a maintenance replacement.
-- Authority is the existing protocol-2 original Manager plus its irreversible
-- in-memory permit start fence. SQL absence alone is NEVER original no-start proof.
-- This API is invoked only after the original preparation has physically exited
-- without calling permit.start; replacements may read receipts, never create them.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
-- Admit all trigger-bearing relations before any catalog mutation. Never wait
-- holding an earlier hot relation while a live writer needs a later one.
DO $admission$
DECLARE v_deadline timestamptz := clock_timestamp()+interval '3 seconds';
BEGIN
 LOOP
  IF clock_timestamp()>=v_deadline THEN
   RAISE EXCEPTION 'F06_PREPARED_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
  END IF;
  BEGIN
   PERFORM set_config('lock_timeout',least(1000,greatest(1,ceil(extract(epoch FROM v_deadline-clock_timestamp())*1000)))::text||'ms',true);
   LOCK TABLE public.hand_atomic_commits IN SHARE ROW EXCLUSIVE MODE;
   LOCK TABLE public.hand_history,public.hand_state_snapshots,public.hand_private_state,
    public.table_hole_cards IN SHARE ROW EXCLUSIVE MODE NOWAIT;
   IF clock_timestamp()>=v_deadline THEN
    RAISE EXCEPTION 'F06_PREPARED_INSTALL_ADMISSION_BUSY' USING ERRCODE='55P03';
   END IF;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   -- The exception subtransaction released every partial relation lock.
   PERFORM pg_sleep(least(0.01,greatest(0,extract(epoch FROM v_deadline-clock_timestamp()))));
  END;
 END LOOP;
END $admission$;
SET LOCAL lock_timeout='1s';


CREATE TABLE smarter_private.f06_prepared_hand_cancellations (
 permit_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL, generation uuid NOT NULL, table_id uuid NOT NULL,
 lifecycle bigint NOT NULL, hand_number bigint NOT NULL, custody_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(table_id,hand_number)
);
ALTER TABLE smarter_private.f06_prepared_hand_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_prepared_hand_cancellations FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.f06_prepared_cancellation_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'F06_PREPARED_CANCELLATION_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER f06_prepared_cancellation_immutable BEFORE UPDATE OR DELETE
 ON smarter_private.f06_prepared_hand_cancellations FOR EACH ROW
 EXECUTE FUNCTION smarter_private.f06_prepared_cancellation_immutable();

CREATE FUNCTION public.fn_f06_cancel_prepared_hand(
 p_tournament_id uuid,p_lease_generation uuid,p_table_id uuid,p_lifecycle bigint,
 p_permit_id uuid,p_hand_number bigint,p_custody_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE h smarter_private.f06_hand_permits; r smarter_private.f06_prepared_hand_cancellations;
BEGIN
 IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_table_id IS NULL
 OR p_lifecycle IS NULL OR p_permit_id IS NULL OR p_hand_number IS NULL
 OR p_hand_number<1 OR p_custody_id IS NULL THEN
 RAISE EXCEPTION 'F06_PREPARED_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Unchanged protocol-2 admission and canonical lease/lane/physical-row order.
 -- A successor lease cannot certify the original process's local non-actuation.
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.generation,h.table_id,h.lifecycle,h.hand_number,h.custody_id)
 IS DISTINCT FROM(p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id) THEN
 RAISE EXCEPTION 'F06_PREPARED_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT * INTO r FROM smarter_private.f06_prepared_hand_cancellations WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (r.tournament_id,r.generation,r.table_id,r.lifecycle,r.hand_number,r.custody_id)
 IS DISTINCT FROM(p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id)
 OR h.state<>'never_started' OR h.evidence_id IS DISTINCT FROM p_permit_id THEN
 RAISE EXCEPTION 'F06_PREPARED_RECEIPT_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 IF h.state<>'reserved' OR h.evidence_id IS NOT NULL THEN
 RAISE EXCEPTION 'F06_PREPARED_NOT_RESERVED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id AND tb.f06_lifecycle=p_lifecycle
 AND upper(t.status)='RUNNING' AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 -- Durable witnesses only REFUSE a claimed no-start; their absence cannot grant it.
 -- The active snapshot uses its maintained partial index. Completed snapshot
 -- history is not scanned or inferred absent: positive original-process start
 -- exclusion (not a successor reconstruction) is the authority for this receipt.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND NOT is_complete AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RAISE EXCEPTION 'F06_PREPARED_START_EVIDENCE' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_prepared_hand_cancellations
 (permit_id,tournament_id,generation,table_id,lifecycle,hand_number,custody_id)
 VALUES(p_permit_id,p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id);
 UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=p_permit_id
 WHERE permit_id=p_permit_id RETURNING * INTO h;
 END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)
 TO service_role;

-- Covers raw snapshot/private/hand writers as well as canonical settlement.
-- The nonblocking shared lane serializes with cancellation's exclusive lane
-- without acquiring an earlier blocking lock after a physical writer row.
CREATE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE t uuid;
BEGIN
 -- Resolve the table even before BEGIN is visible; an absent permit cannot
 -- let an already-started writer cross cancellation's exclusive lane.
 SELECT tournament_id INTO t FROM public.tables WHERE id=NEW.table_id;
 IF t IS NOT NULL THEN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_CANCELLED_PREPARATION_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE rel text; BEGIN
 FOREACH rel IN ARRAY ARRAY['hand_atomic_commits','hand_history','hand_state_snapshots','hand_private_state','table_hole_cards'] LOOP
 EXECUTE format('CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()',rel);
 END LOOP;
END $$;
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES
 ('hand_atomic_commits','a00_f06_cancelled_preparation','Exact original no-start receipt; no monetary write'),
 ('hand_history','a00_f06_cancelled_preparation','Exact original no-start receipt; no monetary write');
REVOKE ALL ON FUNCTION smarter_private.f06_prepared_cancellation_immutable(),
 smarter_private.f06_cancelled_preparation_writer_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
