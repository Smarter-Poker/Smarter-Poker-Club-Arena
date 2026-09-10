-- Disposable protocol candidate, not a production migration.
-- Only four launch/evidence functions below the bootstrap are exact catalog captures.
CREATE TABLE public.tournaments (
 id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'RUNNING',
 current_level integer NOT NULL DEFAULT 1, level_started_at timestamptz,
 small_blind numeric NOT NULL DEFAULT 10, big_blind numeric NOT NULL DEFAULT 20,
 ante numeric NOT NULL DEFAULT 0, ended_at timestamptz
);
CREATE TABLE public.tables (
 id uuid PRIMARY KEY, tournament_id uuid, status text NOT NULL DEFAULT 'waiting',
 current_players integer NOT NULL DEFAULT 0, max_players integer NOT NULL DEFAULT 9,
 is_deleted boolean NOT NULL DEFAULT false, lifecycle text DEFAULT 'waiting',
 terminal_closed_at timestamptz, small_blind numeric DEFAULT 10,
 big_blind numeric DEFAULT 20, ante numeric DEFAULT 0
);
CREATE TABLE public.tournament_launch_receipts (
 tournament_id uuid PRIMARY KEY, launch_id uuid, lease_generation uuid, completed_at timestamptz
);
CREATE TABLE public.tournament_table_origins (
 table_id uuid PRIMARY KEY,tournament_id uuid,origin_kind text,launch_id uuid,launch_lease_generation uuid
);
CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY);
CREATE TABLE public.audit_clock_publications(tournament_id uuid PRIMARY KEY,active boolean NOT NULL,revision bigint NOT NULL);
CREATE TABLE public.audit_clock_operations(
 id uuid PRIMARY KEY,tournament_id uuid NOT NULL,delta integer NOT NULL,
 operation_xid xid8 NOT NULL,result jsonb
);
CREATE TABLE public.audit_clock_freeze(singleton boolean PRIMARY KEY DEFAULT true, frozen boolean NOT NULL);
INSERT INTO public.audit_clock_freeze VALUES(true,false);
CREATE TABLE public.audit_clock_trace(id bigint GENERATED ALWAYS AS IDENTITY,stage text NOT NULL,event_id uuid);
CREATE TABLE public.audit_clock_paid_entry(id uuid PRIMARY KEY,amount numeric NOT NULL);
CREATE TABLE public.audit_clock_wallet(singleton boolean PRIMARY KEY DEFAULT true,balance numeric NOT NULL);
INSERT INTO public.audit_clock_wallet VALUES(true,100);
CREATE FUNCTION public.audit_clock_event_gate(p_ids uuid[],p_wait boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 IF p_wait THEN PERFORM pg_advisory_xact_lock_shared(530090,1);
 ELSIF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'CLOCK_MAINTENANCE_BUSY' USING ERRCODE='40001';
 END IF;
 FOR v_id IN SELECT DISTINCT x FROM unnest(p_ids)x WHERE x IS NOT NULL ORDER BY x LOOP
  IF p_wait THEN PERFORM pg_advisory_xact_lock(hashtextextended(v_id::text,530091));
  ELSIF NOT pg_try_advisory_xact_lock(hashtextextended(v_id::text,530091)) THEN
   RAISE EXCEPTION 'CLOCK_EVENT_BUSY' USING ERRCODE='40001';
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.audit_clock_freeze WHERE frozen) THEN
  RAISE EXCEPTION 'CLOCK_FROZEN' USING ERRCODE='55000';
 END IF;
END $$;
CREATE FUNCTION public.audit_clock_prior_rows(p_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Every row acquired before an old parent-first or child-first writer proceeds is nonblocking.
 BEGIN
  PERFORM 1 FROM public.audit_clock_publications WHERE tournament_id=ANY(p_ids) ORDER BY tournament_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.tournament_launch_receipts WHERE tournament_id=ANY(p_ids) ORDER BY tournament_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.tournaments WHERE id=ANY(p_ids) ORDER BY id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CLOCK_PRIOR_ROW_BUSY' USING ERRCODE='40001';
 END;
END $$;
CREATE FUNCTION public.audit_clock_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ids uuid[];v_parent public.tournaments%ROWTYPE;
BEGIN
 v_ids:=CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW.tournament_id]
 WHEN TG_OP='DELETE' THEN ARRAY[OLD.tournament_id] ELSE ARRAY[OLD.tournament_id,NEW.tournament_id] END;
 -- No absent/inactive fast path exists before this gate.
 PERFORM public.audit_clock_event_gate(v_ids,false);
 PERFORM public.audit_clock_prior_rows(v_ids);
 INSERT INTO public.audit_clock_trace(stage,event_id) SELECT 'member',x FROM unnest(v_ids)x WHERE x IS NOT NULL;
 IF TG_OP<>'DELETE' AND NEW.tournament_id IS NOT NULL
 AND lower(NEW.status)<>'closed' AND NOT NEW.is_deleted
 AND EXISTS(SELECT 1 FROM public.audit_clock_publications WHERE tournament_id=NEW.tournament_id AND active) THEN
  SELECT * INTO STRICT v_parent FROM public.tournaments WHERE id=NEW.tournament_id;
  NEW.small_blind:=v_parent.small_blind;NEW.big_blind:=v_parent.big_blind;NEW.ante:=v_parent.ante;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER a0_tournament_clock_membership_gate BEFORE INSERT OR UPDATE OR DELETE ON public.tables
 FOR EACH ROW EXECUTE FUNCTION public.audit_clock_member_guard();
CREATE FUNCTION public.audit_clock_parent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM public.audit_clock_event_gate(ARRAY[NEW.id],false);
 PERFORM public.audit_clock_prior_rows(ARRAY[NEW.id]);
 IF EXISTS(SELECT 1 FROM public.audit_clock_publications WHERE tournament_id=NEW.id AND active)
 AND NOT EXISTS(SELECT 1 FROM public.audit_clock_operations WHERE tournament_id=NEW.id
 AND operation_xid=pg_current_xact_id() AND result IS NULL) THEN
  RAISE EXCEPTION 'CLOCK_AUTHORITY_REQUIRED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a0_tournament_clock_parent_gate BEFORE UPDATE OF current_level,level_started_at,small_blind,big_blind,ante
 ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.audit_clock_parent_guard();
CREATE FUNCTION public.audit_clock_publish(p_event uuid,p_op uuid,p_delta integer)
 RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_op public.audit_clock_operations%ROWTYPE;v_id uuid;v_result jsonb;
BEGIN
 PERFORM public.audit_clock_event_gate(ARRAY[p_event],true);
 INSERT INTO public.audit_clock_operations VALUES(p_op,p_event,p_delta,pg_current_xact_id(),NULL)
 ON CONFLICT(id) DO NOTHING;
 SELECT * INTO STRICT v_op FROM public.audit_clock_operations WHERE id=p_op FOR UPDATE;
 IF v_op.tournament_id<>p_event OR v_op.delta<>p_delta THEN
  RAISE EXCEPTION 'CLOCK_REPLAY_CONFLICT' USING ERRCODE='22023';
 END IF;
 IF v_op.result IS NOT NULL THEN
  RETURN jsonb_build_object('original',v_op.result,'current',
   (SELECT to_jsonb(t) FROM public.tournaments t WHERE id=p_event));
 END IF;
 INSERT INTO public.audit_clock_publications VALUES(p_event,false,0) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM public.audit_clock_publications WHERE tournament_id=p_event FOR UPDATE;
 PERFORM 1 FROM public.tournament_launch_receipts WHERE tournament_id=p_event FOR UPDATE;
 PERFORM 1 FROM public.tournaments WHERE id=p_event FOR UPDATE;
 -- Durable membership is scanned after the activation barrier, under the parent lock.
 PERFORM 1 FROM public.tables WHERE tournament_id=p_event AND lower(status)<>'closed'
 AND NOT is_deleted ORDER BY id FOR UPDATE;
 UPDATE public.audit_clock_publications SET active=true,revision=revision+1 WHERE tournament_id=p_event;
 UPDATE public.tournaments SET current_level=current_level+p_delta,
 small_blind=small_blind+10*p_delta,big_blind=big_blind+20*p_delta WHERE id=p_event;
 FOR v_id IN SELECT id FROM public.tables WHERE tournament_id=p_event AND lower(status)<>'closed'
 AND NOT is_deleted ORDER BY id LOOP
  UPDATE public.tables SET small_blind=(SELECT small_blind FROM public.tournaments WHERE id=p_event),
  big_blind=(SELECT big_blind FROM public.tournaments WHERE id=p_event) WHERE id=v_id;
 END LOOP;
 SELECT jsonb_build_object('level',t.current_level,'revision',p.revision) INTO v_result
 FROM public.tournaments t JOIN public.audit_clock_publications p ON p.tournament_id=t.id WHERE t.id=p_event;
 UPDATE public.audit_clock_operations SET result=v_result WHERE id=p_op;
 RETURN jsonb_build_object('original',v_result,'current',(SELECT to_jsonb(t) FROM public.tournaments t WHERE id=p_event));
END $$;
