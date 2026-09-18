-- Independent PKO heads may settle below a later watermark without changing
-- any previously consumed head. Preserve genuine causal dependencies, every
-- immutable accepted witness, complete payouts, pending refusal and generation.
-- No financial rows, public writers, grants, or watermark values are changed.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $preimage$
DECLARE p record;
BEGIN
 SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
 WHERE f.oid=to_regprocedure('public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)');
 IF NOT FOUND OR md5(p.prosrc) NOT IN ('9d67a9c6207fb00fb971adc8c3be0b77','709e8251c3ce3381f4515b78af540b75')
    OR p.owner IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM 's' THEN
  RAISE EXCEPTION 'PKO independent watermark preimage differs';
 END IF;
END $preimage$;
CREATE OR REPLACE FUNCTION public.fn_pko_watermark_admission_status_v1(p_tournament_id uuid, p_eliminated_user_id uuid, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_claimants jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  participants uuid[]; others uuid[]; target_candidate uuid;
  target_scope jsonb; later_scope jsonb; exact_claimants jsonb;
  target_commit timestamptz; later_commit timestamptz;
  watermark bigint; watermark_obligation uuid;
  o public.tournament_bounty_obligations%ROWTYPE;
  c public.tournament_knockout_candidates%ROWTYPE;
  inspected integer:=0; scope_limit constant integer:=10000;
  overlapping boolean;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL OR p_table_id IS NULL
     OR p_hand_id IS NULL OR p_hand_number IS NULL OR p_seat_joined_at IS NULL
     OR jsonb_typeof(p_claimants) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',false,'reason','watermark_target_identity_unproven');
  END IF;
  IF jsonb_array_length(p_claimants)=0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_claimants) e
     WHERE coalesce(e->>'user_id','') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR e->>'weight' IS DISTINCT FROM '1'
  ) THEN RETURN jsonb_build_object('ok',false,'reason','watermark_target_claimants_unproven'); END IF;
  SELECT ARRAY[p_eliminated_user_id]||array_agg((e->>'user_id')::uuid)
    INTO participants FROM jsonb_array_elements(p_claimants) e;
  IF cardinality(participants)<>(SELECT count(DISTINCT u) FROM unnest(participants) u)
     OR EXISTS (SELECT 1 FROM unnest(participants[2:cardinality(participants)]) u
         WHERE NOT EXISTS (SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id=p_tournament_id AND tp.user_id=u AND tp.status='playing')) THEN
    RETURN jsonb_build_object('ok',false,'reason','watermark_target_generation_unproven');
  END IF;
  SELECT id INTO target_candidate FROM public.tournament_knockout_candidates
   WHERE tournament_id=p_tournament_id AND hand_number=p_hand_number
     AND eliminated_user_id=p_eliminated_user_id AND table_id=p_table_id
     AND hand_id=p_hand_id AND seat_joined_at=p_seat_joined_at;
  IF target_candidate IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','watermark_target_candidate_missing');
  END IF;
  target_scope:=public.fn_pko_candidate_accepted_scope_v1(p_tournament_id,target_candidate);
  IF target_scope->>'ok' IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('ok',false,'reason','watermark_target_evidence_unproven','detail',target_scope);
  END IF;
  BEGIN
    exact_claimants:=public.fn_exact_tournament_knockout_claimants(p_tournament_id,p_hand_id,p_eliminated_user_id);
  EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    exact_claimants:=NULL;
  END;
  IF exact_claimants IS DISTINCT FROM p_claimants THEN
    RETURN jsonb_build_object('ok',false,'reason','watermark_target_claimants_conflict');
  END IF;
  target_commit:=(target_scope->>'committed_at')::timestamptz;
  SELECT w.last_settled_hand_number,w.last_obligation_id
    INTO watermark,watermark_obligation FROM public.tournament_pko_settlement_watermarks w
    JOIN public.tournament_bounty_obligations b ON b.id=w.last_obligation_id
     AND b.tournament_id=w.tournament_id AND b.hand_number=w.last_settled_hand_number
     AND b.state='settled' AND b.mode='pko'
   WHERE w.tournament_id=p_tournament_id;
  -- This helper is only the exception for a caller which saw a greater
  -- watermark. Missing/corrupt/not-applicable state cannot authorize it.
  IF watermark IS NULL OR watermark<=p_hand_number OR EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations b
     WHERE b.tournament_id=p_tournament_id AND b.mode='pko'
       AND b.state='settled' AND b.hand_number>watermark
  ) THEN RETURN jsonb_build_object('ok',false,'reason','watermark_identity_unproven'); END IF;

  FOR o IN SELECT * FROM public.tournament_bounty_obligations
    WHERE tournament_id=p_tournament_id AND mode='pko' AND hand_number>p_hand_number
    ORDER BY hand_number,eliminated_user_id LIMIT scope_limit+1
  LOOP
    inspected:=inspected+1;
    IF inspected>scope_limit THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_scope_incomplete','inspected',scope_limit);
    END IF;
    IF jsonb_typeof(o.claimants) IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_claimants_unproven','obligation_id',o.id);
    END IF;
    IF jsonb_array_length(o.claimants)=0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(o.claimants) e
       WHERE coalesce(e->>'user_id','') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR e->>'weight' IS DISTINCT FROM '1'
    ) THEN RETURN jsonb_build_object('ok',false,'reason','watermark_claimants_unproven','obligation_id',o.id); END IF;
    SELECT ARRAY[o.eliminated_user_id]||array_agg((e->>'user_id')::uuid)
      INTO others FROM jsonb_array_elements(o.claimants) e;
    IF cardinality(others)<>(SELECT count(DISTINCT u) FROM unnest(others) u)
       OR o.state IS NULL OR o.state NOT IN ('pending','settled') OR o.table_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_obligation_unproven','obligation_id',o.id);
    END IF;
    IF o.state='settled' AND public.fn_bounty_obligation_has_complete_marker(o.id) IS NOT TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_marker_incomplete','obligation_id',o.id);
    END IF;
    overlapping:=o.table_id=p_table_id OR others && participants;
    -- Preserve R35's disjoint-table commutativity, including complete later
    -- settled heads and disjoint pending snapshots. Extra chronology is only
    -- needed to admit a SHARED participant/table after a larger hand number.
    IF NOT overlapping THEN CONTINUE; END IF;
    IF o.state IS DISTINCT FROM 'settled' THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_shared_head_pending','obligation_id',o.id);
    END IF;
    SELECT * INTO c FROM public.tournament_knockout_candidates
     WHERE tournament_id=p_tournament_id AND hand_number=o.hand_number
       AND eliminated_user_id=o.eliminated_user_id;
    IF NOT FOUND OR c.table_id IS DISTINCT FROM o.table_id
       OR c.hand_id IS DISTINCT FROM o.hand_id OR c.seat_joined_at IS DISTINCT FROM o.seat_joined_at THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_prior_candidate_conflict','obligation_id',o.id);
    END IF;
    later_scope:=public.fn_pko_candidate_accepted_scope_v1(p_tournament_id,c.id);
    IF later_scope->>'ok' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_prior_evidence_unproven',
        'obligation_id',o.id,'detail',later_scope);
    END IF;
    IF (later_scope->>'settlement_completed_at')::timestamptz IS DISTINCT FROM o.settlement_completed_at THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_prior_settlement_conflict','obligation_id',o.id);
    END IF;
    BEGIN
      exact_claimants:=public.fn_exact_tournament_knockout_claimants(p_tournament_id,c.hand_id,c.eliminated_user_id);
    EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
      exact_claimants:=NULL;
    END;
    IF exact_claimants IS DISTINCT FROM o.claimants THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_prior_claimants_conflict','obligation_id',o.id);
    END IF;
    -- Settled independent heads commute even at the same table. Adding two
    -- independently proved carries to a common collector also commutes: the
    -- collector's existing head never sets either incoming cash/carry split.
    -- Keep every accepted identity, exact claimant and complete-marker proof
    -- above. A consumed collector head, credit to the target eliminated head,
    -- or repeated eliminated identity still needs the causal proof below.
    IF NOT (o.eliminated_user_id=ANY(participants)
            OR p_eliminated_user_id=ANY(others)) THEN CONTINUE; END IF;
    later_commit:=(later_scope->>'committed_at')::timestamptz;
    IF later_commit>=target_commit THEN
      RETURN jsonb_build_object('ok',false,'reason','watermark_shared_head_not_causally_prior',
        'obligation_id',o.id,'prior_committed_at',later_commit,'target_committed_at',target_commit);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'reason','independent_or_causally_prior',
    'inspected',inspected,'watermark',watermark);
END;
$function$;
DO $postimage$
DECLARE p record;
BEGIN
 SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
 WHERE f.oid=to_regprocedure('public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)');
 IF NOT FOUND OR md5(p.prosrc) NOT IN ('709e8251c3ce3381f4515b78af540b75')
    OR p.owner IS DISTINCT FROM 'postgres' OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM 's' THEN
  RAISE EXCEPTION 'PKO independent watermark postimage differs';
 END IF;
END $postimage$;
COMMIT;
