-- A privileged, evidenced ruling can invalidate a repair-created generation.
-- Candidate and accepted-hand identity/history is retained. Normal ranking
-- already selects only eliminated candidates; latest-generation purchase doors
-- must continue to see invalidated evidence and refuse to revive it.
BEGIN;
CREATE TABLE public.tournament_knockout_invalidations (
  id uuid PRIMARY KEY,
  invalid_candidate_id uuid NOT NULL UNIQUE REFERENCES public.tournament_knockout_candidates(id),
  source_candidate_id uuid NOT NULL UNIQUE REFERENCES public.tournament_knockout_candidates(id),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  user_id uuid NOT NULL,
  invalid_before jsonb NOT NULL,
  source_before jsonb NOT NULL,
  player_before jsonb NOT NULL,
  invalid_commit jsonb NOT NULL,
  source_commit jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL DEFAULT session_user,
  CHECK (invalid_candidate_id <> source_candidate_id)
);
ALTER TABLE public.tournament_knockout_invalidations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_knockout_invalidations FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.tournament_knockout_invalidations IS
  'Privileged, immutable before-images and accepted-hand receipts for an unpaid non-bounty ruling. Ordinary engine/player roles cannot create invalidation authority.';

CREATE FUNCTION public.fn_guard_tournament_knockout_invalidation_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC' AS $function$
DECLARE
  t public.tournaments%ROWTYPE;
  p public.tournament_players%ROWTYPE;
  bad public.tournament_knockout_candidates%ROWTYPE;
  real_bust public.tournament_knockout_candidates%ROWTYPE;
  c public.hand_atomic_commits%ROWTYPE;
  r record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'knockout invalidation evidence is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF EXISTS(SELECT 1 FROM public.tournament_knockout_invalidations e
    WHERE e.invalid_candidate_id IN (NEW.invalid_candidate_id,NEW.source_candidate_id)
       OR e.source_candidate_id IN (NEW.invalid_candidate_id,NEW.source_candidate_id)) THEN
    RAISE EXCEPTION 'a knockout generation already belongs to an immutable ruling' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT t FROM public.tournaments WHERE id=NEW.tournament_id FOR UPDATE;
  PERFORM id FROM public.tournament_players WHERE tournament_id=t.id ORDER BY id FOR UPDATE;
  SELECT * INTO STRICT p FROM public.tournament_players
    WHERE tournament_id=t.id AND user_id=NEW.user_id;
  PERFORM id FROM public.tournament_knockout_candidates
    WHERE tournament_id=t.id AND eliminated_user_id=NEW.user_id ORDER BY hand_number,id FOR UPDATE;
  SELECT * INTO STRICT bad FROM public.tournament_knockout_candidates WHERE id=NEW.invalid_candidate_id;
  SELECT * INTO STRICT real_bust FROM public.tournament_knockout_candidates WHERE id=NEW.source_candidate_id;
  IF t.status IS DISTINCT FROM 'RUNNING' OR t.prize_pool_finalized IS NOT TRUE
     OR COALESCE(t.is_bounty,false) OR COALESCE(t.is_pko,false) OR COALESCE(t.is_mystery_bounty,false)
     OR p.status IS DISTINCT FROM 'eliminated' OR p.chips IS DISTINCT FROM 0
     OR EXISTS(SELECT 1 FROM public.tournament_payouts WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_obligations WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_place_settlement_batches WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements WHERE tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
       WHERE tb.tournament_id=t.id AND s.user_id=NEW.user_id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'knockout ruling requires an unpaid running non-bounty event and an eliminated seatless player' USING ERRCODE='55000';
  END IF;
  IF bad.tournament_id<>t.id OR real_bust.tournament_id<>t.id
     OR bad.eliminated_user_id<>NEW.user_id OR real_bust.eliminated_user_id<>NEW.user_id
     OR bad.state<>'eliminated' OR real_bust.state<>'rebought'
     OR bad.hand_number<=real_bust.hand_number
     OR bad.seat_joined_at<=real_bust.created_at
     OR NEW.invalid_before IS DISTINCT FROM to_jsonb(bad)
     OR NEW.source_before IS DISTINCT FROM to_jsonb(real_bust)
     OR NEW.player_before IS DISTINCT FROM to_jsonb(p)
     OR NOT isfinite(NEW.created_at) OR NEW.created_at>clock_timestamp()
     OR NEW.created_by IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'knockout ruling before-images or generation identities changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.chip_ledger l
    WHERE l.tournament_id=t.id AND l.from_entity_id=NEW.user_id
      AND l.category IN ('rebuy','reentry') AND l.status='posted' AND l.amount>0
      AND l.from_type='player_wallet' AND l.to_type='prize_liability'
      AND l.created_at>real_bust.created_at AND l.created_at<=bad.created_at) THEN
    RAISE EXCEPTION 'paid re-entry evidence requires a different adjudication' USING ERRCODE='55000';
  END IF;
  FOR r IN SELECT real_bust.id AS candidate_id,real_bust.seat_id,real_bust.seat_joined_at,real_bust.stack_before,NEW.source_commit AS receipt
    UNION ALL SELECT bad.id,bad.seat_id,bad.seat_joined_at,bad.stack_before,NEW.invalid_commit LOOP
    SELECT a.* INTO STRICT c FROM public.hand_atomic_commits a
      JOIN public.tournament_knockout_candidates k ON k.table_id=a.table_id
        AND k.hand_number=a.hand_number AND k.hand_id=a.hand_id
      WHERE k.id=r.candidate_id FOR SHARE OF a;
    -- Older accepted requests lacked chair fields; their zero-stack seat
    -- generation receipt binds that same immutable chair incarnation instead.
    IF (c.stack_result->>'table_id')::uuid IS DISTINCT FROM c.table_id
       OR (c.stack_result->>'hand_number')::bigint IS DISTINCT FROM c.hand_number
       OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.stack_result#>'{request,stacks}','[]'::jsonb)) q
         WHERE q->>'user_id'=NEW.user_id::text AND (q->>'stack')::numeric=0
           AND (q->>'stack_before')::numeric=r.stack_before)
       OR NOT (
         EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.stack_result#>'{request,stacks}','[]'::jsonb)) q
           WHERE q->>'user_id'=NEW.user_id::text AND (q->>'stack')::numeric=0
             AND (q->>'seat_id')::uuid=r.seat_id
             AND (q->>'seat_joined_at')::timestamptz=r.seat_joined_at)
         OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.stack_result->'tournament_zero_stack_seat_generations','[]'::jsonb)) q
           WHERE q->>'user_id'=NEW.user_id::text AND (q->>'seat_id')::uuid=r.seat_id
             AND (q->>'joined_at')::timestamptz=r.seat_joined_at))
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.stack_result#>'{request,stacks}','[]'::jsonb)) q
         WHERE q->>'user_id'=NEW.user_id::text AND q->>'seat_id' IS NOT NULL
           AND ((q->>'seat_id')::uuid IS DISTINCT FROM r.seat_id
             OR (q->>'seat_joined_at')::timestamptz IS DISTINCT FROM r.seat_joined_at)) THEN
      RAISE EXCEPTION 'knockout ruling candidate seat generation differs from its accepted receipt' USING ERRCODE='55000';
    END IF;
    IF r.receipt IS DISTINCT FROM (to_jsonb(c)-ARRAY['post_commit_payload','post_commit_request_hash','post_commit_payload_hash','post_commit_completed_at','post_commit_result'])
       OR (c.stack_result->'written'->>NEW.user_id::text)::numeric IS DISTINCT FROM 0
       OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys s
         WHERE s.table_id=c.table_id AND s.hand_id::text=c.stack_result->>'hand_id'
           AND s.status='succeeded' AND s.completed_at IS NOT NULL
           AND s.result=c.stack_result) THEN
      RAISE EXCEPTION 'knockout ruling lacks an exact committed zero-stack settlement receipt' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NEW;
END $function$;
CREATE TRIGGER guard_knockout_invalidation_evidence
BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_knockout_invalidations
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_knockout_invalidation_evidence();
CREATE TRIGGER guard_knockout_invalidation_evidence_truncate
BEFORE TRUNCATE ON public.tournament_knockout_invalidations
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_guard_tournament_knockout_invalidation_evidence();

CREATE FUNCTION public.fn_guard_tournament_knockout_invalidation_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC' AS $function$
DECLARE e public.tournament_knockout_invalidations%ROWTYPE;
  before_row jsonb; final_state text; final_row jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state='invalidated' THEN
      RAISE EXCEPTION 'an invalidation must preserve an existing generation' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO e FROM public.tournament_knockout_invalidations
    WHERE invalid_candidate_id=OLD.id OR source_candidate_id=OLD.id;
  IF NOT FOUND THEN
    IF TG_OP='UPDATE' AND NEW.state='invalidated' THEN
      RAISE EXCEPTION 'invalidation requires immutable privileged evidence' USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'an adjudicated knockout generation cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF OLD.id=e.invalid_candidate_id THEN
    before_row:=e.invalid_before; final_state:='invalidated';
  ELSE
    before_row:=e.source_before; final_state:='eliminated';
  END IF;
  final_row:=before_row||jsonb_build_object('state',final_state,'resolved_at',e.created_at);
  IF to_jsonb(OLD) NOT IN (before_row,final_row) OR to_jsonb(NEW) IS DISTINCT FROM final_row THEN
    RAISE EXCEPTION 'adjudicated candidate permits only its evidenced terminal transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER guard_knockout_invalidation_transition
BEFORE INSERT OR UPDATE OR DELETE ON public.tournament_knockout_candidates
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_knockout_invalidation_transition();

CREATE FUNCTION public.fn_assert_tournament_knockout_invalidation_closed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
SET timezone TO 'UTC' AS $function$
DECLARE stamp timestamptz; p public.tournament_players%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k
    WHERE k.id=NEW.invalid_candidate_id AND to_jsonb(k)=
      NEW.invalid_before||jsonb_build_object('state','invalidated','resolved_at',NEW.created_at))
    OR NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k
    WHERE k.id=NEW.source_candidate_id AND to_jsonb(k)=
      NEW.source_before||jsonb_build_object('state','eliminated','resolved_at',NEW.created_at)) THEN
    RAISE EXCEPTION 'both audited knockout transitions must commit together' USING ERRCODE='55000';
  END IF;
  SELECT (NEW.source_commit->>'committed_at')::timestamptz
    + (SELECT count(*) FROM public.tournament_knockout_candidates s
       WHERE s.tournament_id=NEW.tournament_id
         AND s.table_id=(NEW.source_before->>'table_id')::uuid
         AND s.hand_id=(NEW.source_before->>'hand_id')::uuid
         AND s.hand_number=(NEW.source_before->>'hand_number')::bigint
         AND (s.stack_before,s.eliminated_user_id)<
           ((NEW.source_before->>'stack_before')::numeric,NEW.user_id))::integer*interval '1 microsecond'
    INTO stamp;
  SELECT * INTO STRICT p FROM public.tournament_players
    WHERE tournament_id=NEW.tournament_id AND user_id=NEW.user_id;
  IF p.status IS DISTINCT FROM 'eliminated' OR p.chips IS DISTINCT FROM 0 OR p.eliminated_at IS DISTINCT FROM stamp
     OR to_jsonb(p)-'eliminated_at' IS DISTINCT FROM NEW.player_before-'eliminated_at' THEN
    RAISE EXCEPTION 'player elimination must carry the evidenced real bust time' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $function$;
CREATE CONSTRAINT TRIGGER assert_knockout_invalidation_closed
AFTER INSERT ON public.tournament_knockout_invalidations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public.fn_assert_tournament_knockout_invalidation_closed();

ALTER TABLE public.tournament_knockout_candidates
  DROP CONSTRAINT tournament_knockout_candidates_state_check;
ALTER TABLE public.tournament_knockout_candidates
  ADD CONSTRAINT tournament_knockout_candidates_state_check
  CHECK (state IN ('pending','rebought','eliminated','winner','invalidated'));
REVOKE ALL ON FUNCTION public.fn_guard_tournament_knockout_invalidation_evidence() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_knockout_invalidation_transition() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_assert_tournament_knockout_invalidation_closed() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
