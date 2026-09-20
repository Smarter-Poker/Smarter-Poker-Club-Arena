-- R37: a PKO head is captured only after its exact incoming knockouts settle.
-- This is admission and replay integrity. No historical money or head is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
DECLARE item jsonb; p record; identity oid;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)","before":"7891b176cdfdf8d8088c10b59240cfe3","after":"eb4fa0f4d743202037950334f0b99f83","acl":"{postgres=X/postgres}","volatility":"v"},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","before":"64474c90007dc5a91e253d02150dc94e","after":"bc621ffbddfd931897706f6d1f099109","acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v"},{"signature":"public.fn_pko_candidate_accepted_scope_v1(uuid,uuid)","before":null,"after":"34c837517891f25a801a6ec1f7f6b511","acl":"{postgres=X/postgres}","volatility":"s"},{"signature":"public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone)","before":null,"after":"bc18225d08c051506504196abacd7c83","acl":"{postgres=X/postgres}","volatility":"s"},{"signature":"public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)","before":null,"after":"9d67a9c6207fb00fb971adc8c3be0b77","acl":"{postgres=X/postgres}","volatility":"s"}]$manifest$::jsonb) LOOP
  identity:=to_regprocedure(item->>'signature');
  IF identity IS NULL THEN
   IF item->>'before' IS NOT NULL THEN RAISE EXCEPTION 'PKO dependency source missing: %',item->>'signature'; END IF;
   CONTINUE;
  END IF;
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner WHERE f.oid=identity;
  IF md5(p.prosrc) NOT IN (COALESCE(item->>'before',item->>'after'),item->>'after')
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM item->>'volatility' THEN
   RAISE EXCEPTION 'PKO dependency unreviewed source or metadata: %',item->>'signature';
  END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_exact_tournament_knockout_claimants(uuid,uuid,uuid)'::regprocedure)
      IS DISTINCT FROM '60a8abcd36fe5ee0849824b095f700a0'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_bounty_obligation_has_complete_marker(uuid)'::regprocedure)
      IS DISTINCT FROM '663946f381864909b4bef1b7755e37b6' THEN
  RAISE EXCEPTION 'PKO dependency evidence reader or marker source changed';
 END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_pko_candidate_accepted_scope_v1(p_tournament_id uuid, p_candidate_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c public.tournament_knockout_candidates%ROWTYPE;
  a public.hand_atomic_commits%ROWTYPE;
  h public.hand_history%ROWTYPE;
  k public.settlement_idempotency_keys%ROWTYPE;
  settlement_id uuid; raw_settlement_id text;
  hp jsonb; uid text; written_value text;
  participants jsonb := '[]'::jsonb;
  seen text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO c FROM public.tournament_knockout_candidates
   WHERE id=p_candidate_id AND tournament_id=p_tournament_id;
  IF NOT FOUND OR c.table_id IS NULL OR c.hand_id IS NULL
     OR c.hand_number<1000000 OR c.seat_joined_at IS NULL
     OR c.created_at IS NULL OR c.stack_after IS DISTINCT FROM 0
     OR c.stack_before IS NULL OR c.stack_before<=0 THEN
    RETURN jsonb_build_object('ok',false,'reason','candidate_identity_unproven');
  END IF;
  SELECT * INTO a FROM public.hand_atomic_commits
   WHERE table_id=c.table_id AND hand_number=c.hand_number AND hand_id=c.hand_id;
  IF NOT FOUND OR a.committed_at IS NULL OR c.created_at>a.committed_at
     OR a.stack_result->>'table_id' IS DISTINCT FROM c.table_id::text
     OR a.stack_result->>'hand_number' IS DISTINCT FROM c.hand_number::text
     OR jsonb_typeof(a.stack_result->'written') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok',false,'reason','atomic_identity_unproven');
  END IF;
  raw_settlement_id:=a.stack_result->>'hand_id';
  IF coalesce(raw_settlement_id,'') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('ok',false,'reason','settlement_identity_unproven');
  END IF;
  settlement_id:=raw_settlement_id::uuid;
  SELECT * INTO k FROM public.settlement_idempotency_keys
   WHERE table_id=c.table_id AND hand_id=settlement_id;
  IF NOT FOUND OR k.status IS DISTINCT FROM 'succeeded' OR k.completed_at IS NULL
     OR k.completed_at<c.seat_joined_at OR k.completed_at>a.committed_at
     OR k.result->>'table_id' IS DISTINCT FROM c.table_id::text
     OR k.result->>'hand_number' IS DISTINCT FROM c.hand_number::text
     OR jsonb_typeof(k.result->'written') IS DISTINCT FROM 'object'
     OR k.result->'written' IS DISTINCT FROM a.stack_result->'written' THEN
    RETURN jsonb_build_object('ok',false,'reason','accepted_settlement_unproven');
  END IF;
  -- Validate every written item before any cast. Numeric limits are the
  -- existing tournament stack domain; never cast an invalid item through OR.
  FOR uid,written_value IN SELECT key,value FROM jsonb_each_text(a.stack_result->'written') LOOP
    IF uid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR coalesce(written_value,'') !~ '^[0-9]+([.][0-9]+)?$'
       OR length(coalesce(written_value,''))>32 THEN
      RETURN jsonb_build_object('ok',false,'reason','accepted_stack_map_unproven');
    END IF;
    IF written_value::numeric<0 THEN
      RETURN jsonb_build_object('ok',false,'reason','accepted_stack_map_unproven');
    END IF;
  END LOOP;
  IF NOT (a.stack_result->'written' ? c.eliminated_user_id::text)
     OR (a.stack_result->'written'->>c.eliminated_user_id::text)::numeric IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','accepted_zero_unproven');
  END IF;
  SELECT * INTO h FROM public.hand_history
   WHERE id=c.hand_id AND table_id=c.table_id AND hand_number=c.hand_number
     AND tournament_id=c.tournament_id;
  IF NOT FOUND OR h.created_at IS NULL OR h.created_at<k.completed_at
     OR h.created_at<c.seat_joined_at OR h.created_at>a.committed_at
     OR jsonb_typeof(h.players) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',false,'reason','accepted_history_unproven');
  END IF;
  IF jsonb_array_length(h.players)=0 THEN
    RETURN jsonb_build_object('ok',false,'reason','accepted_roster_unproven');
  END IF;
  FOR hp IN SELECT value FROM jsonb_array_elements(h.players) LOOP
    uid:=coalesce(hp->>'userId',hp->>'user_id');
    IF coalesce(uid,'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR uid=ANY(seen) OR NOT (a.stack_result->'written' ? uid)
       OR coalesce(hp->>'stack','') !~ '^[0-9]+([.][0-9]+)?$'
       OR length(coalesce(hp->>'stack',''))>32 THEN
      RETURN jsonb_build_object('ok',false,'reason','accepted_roster_unproven');
    END IF;
    IF (hp->>'stack')::numeric IS DISTINCT FROM (a.stack_result->'written'->>uid)::numeric THEN
      RETURN jsonb_build_object('ok',false,'reason','accepted_roster_stack_conflict');
    END IF;
    seen:=array_append(seen,uid);
    participants:=participants||jsonb_build_array(uid);
  END LOOP;
  IF cardinality(seen)<>(SELECT count(*) FROM jsonb_object_keys(a.stack_result->'written')) THEN
    RETURN jsonb_build_object('ok',false,'reason','accepted_roster_incomplete');
  END IF;
  RETURN jsonb_build_object('ok',true,'candidate_id',c.id,
    'tournament_id',c.tournament_id,'table_id',c.table_id,'hand_id',c.hand_id,
    'hand_number',c.hand_number,'eliminated_user_id',c.eliminated_user_id,
    'seat_joined_at',c.seat_joined_at,'settlement_completed_at',k.completed_at,
    'committed_at',a.committed_at,
    'participants',participants);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_pko_claim_predecessor_status_v1(p_tournament_id uuid, p_eliminated_user_id uuid, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  target public.tournament_knockout_candidates%ROWTYPE;
  c public.tournament_knockout_candidates%ROWTYPE;
  o public.tournament_bounty_obligations%ROWTYPE;
  target_scope jsonb; prior_scope jsonb; claims jsonb;
  target_commit timestamptz; prior_commit timestamptz;
  inspected integer:=0; checked integer:=0;
  -- Reviewable work bound; never a truncated successful dependency proof.
  scope_limit constant integer:=10000;
  blocked jsonb:='[]'::jsonb; unknown jsonb:='[]'::jsonb;
  detail jsonb; known_marker boolean; conflicting_recipient_narrative boolean;
  same_accepted_hand boolean;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_table_id IS NULL OR p_hand_id IS NULL OR p_hand_number IS NULL
     OR p_seat_joined_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'status','unknown','reason','target_identity_required');
  END IF;
  SELECT * INTO target FROM public.tournament_knockout_candidates
   WHERE tournament_id=p_tournament_id AND hand_number=p_hand_number
     AND eliminated_user_id=p_eliminated_user_id;
  IF NOT FOUND OR target.table_id IS DISTINCT FROM p_table_id
     OR target.hand_id IS DISTINCT FROM p_hand_id
     OR target.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object('ok',false,'status','unknown','reason','target_identity_conflict');
  END IF;
  target_scope:=public.fn_pko_candidate_accepted_scope_v1(p_tournament_id,target.id);
  IF target_scope->>'ok' IS DISTINCT FROM 'true' THEN
    RETURN jsonb_build_object('ok',false,'status','unknown','reason','target_evidence_unproven',
      'detail',target_scope);
  END IF;
  target_commit:=(target_scope->>'committed_at')::timestamptz;

  -- A pending debt without its exact accepted candidate is not invisible work.
  -- Candidate enumeration alone cannot discharge this orphaned payment record.
  IF EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations debt
     WHERE debt.tournament_id=p_tournament_id AND debt.mode='pko' AND debt.state='pending'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_knockout_candidates candidate
          WHERE candidate.tournament_id=debt.tournament_id
            AND candidate.eliminated_user_id=debt.eliminated_user_id
            AND candidate.hand_number=debt.hand_number AND candidate.table_id=debt.table_id
            AND candidate.hand_id=debt.hand_id AND candidate.seat_joined_at=debt.seat_joined_at)
  ) THEN
    RETURN jsonb_build_object('ok',false,'status','unknown','reason','pending_pko_candidate_missing');
  END IF;

  -- Existing (tournament_id,hand_number,eliminated_user_id) unique index.
  -- The ordering is a scan cursor only, NOT chronological proof. Preallocation
  -- at another table can give an earlier accepted predecessor a larger number.
  FOR c IN SELECT * FROM public.tournament_knockout_candidates
    WHERE tournament_id=p_tournament_id
      AND eliminated_user_id<>p_eliminated_user_id
    ORDER BY hand_number,eliminated_user_id LIMIT scope_limit+1
  LOOP
    inspected:=inspected+1;
    IF inspected>scope_limit THEN
      RETURN jsonb_build_object('ok',false,'status','unknown','reason','predecessor_scope_incomplete',
        'inspected',scope_limit,'scope_limit',scope_limit,'predecessors',blocked,'unknown',unknown);
    END IF;
    -- Same-hand dependence uses the same exact marker proof as cross-hand
    -- dependence. The original side-pot/tie guard remains an additional veto,
    -- but its settled state alone is no longer enough to skip this proof.
    same_accepted_hand:=c.hand_id=p_hand_id AND c.table_id=p_table_id AND c.hand_number=p_hand_number;
    detail:=jsonb_build_object('candidate_id',c.id,'eliminated_user_id',c.eliminated_user_id,
      'table_id',c.table_id,'hand_id',c.hand_id,'hand_number',c.hand_number,
      'seat_joined_at',c.seat_joined_at,'candidate_state',c.state);
    prior_scope:=public.fn_pko_candidate_accepted_scope_v1(p_tournament_id,c.id);
    IF prior_scope->>'ok' IS DISTINCT FROM 'true' THEN
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','candidate_evidence_unproven','detail',prior_scope));
      END IF;
      CONTINUE;
    END IF;
    -- A complete accepted participant map proves a different table's head
    -- cannot flow into this player. No marker/pot work for that hand.
    IF NOT (prior_scope->'participants' ? p_eliminated_user_id::text) THEN
      -- Malformed history must not name an absent accepted participant as a
      -- recipient/eligible player. A raw scalar mention is only an UNKNOWN
      -- conflict witness, never attribution; JSONPath safely handles scalars.
      SELECT coalesce(jsonb_path_exists(h.pots,'$.** ? (@ == $uid)',
               jsonb_build_object('uid',p_eliminated_user_id::text)),false)
          OR coalesce(jsonb_path_exists(h.winners,'$.** ? (@ == $uid)',
               jsonb_build_object('uid',p_eliminated_user_id::text)),false)
        INTO conflicting_recipient_narrative FROM public.hand_history h
       WHERE h.id=c.hand_id;
      IF conflicting_recipient_narrative IS TRUE THEN
        IF jsonb_array_length(unknown)<20 THEN
          unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','recipient_outside_accepted_roster'));
        END IF;
      END IF;
      CONTINUE;
    END IF;
    prior_commit:=(prior_scope->>'committed_at')::timestamptz;
    IF NOT same_accepted_hand AND prior_commit>target_commit THEN CONTINUE; END IF;
    IF NOT same_accepted_hand AND prior_commit=target_commit THEN
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','cross_hand_causal_order_unproven'));
      END IF;
      CONTINUE;
    END IF;
    checked:=checked+1;
    -- Exact lookup by unique key, then compare every immutable identity.
    SELECT * INTO o FROM public.tournament_bounty_obligations
     WHERE tournament_id=p_tournament_id AND hand_number=c.hand_number
       AND eliminated_user_id=c.eliminated_user_id;
    IF FOUND THEN
      IF o.table_id IS DISTINCT FROM c.table_id OR o.hand_id IS DISTINCT FROM c.hand_id
         OR o.seat_joined_at IS DISTINCT FROM c.seat_joined_at OR o.mode IS DISTINCT FROM 'pko'
         OR o.settlement_completed_at IS DISTINCT FROM (prior_scope->>'settlement_completed_at')::timestamptz THEN
        IF jsonb_array_length(unknown)<20 THEN
          unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_obligation_identity_conflict','obligation_id',o.id));
        END IF;
        CONTINUE;
      END IF;
      IF jsonb_typeof(o.claimants) IS DISTINCT FROM 'array' THEN
        IF jsonb_array_length(unknown)<20 THEN
          unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_claimants_malformed','obligation_id',o.id));
        END IF;
        CONTINUE;
      END IF;
      IF jsonb_array_length(o.claimants)=0 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(o.claimants) e
         WHERE coalesce(e->>'user_id','') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR e->>'weight' IS DISTINCT FROM '1'
      ) THEN
        IF jsonb_array_length(unknown)<20 THEN
          unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_claimants_malformed','obligation_id',o.id));
        END IF;
        CONTINUE;
      END IF;
      IF jsonb_array_length(o.claimants)<>(SELECT count(DISTINCT (e->>'user_id')::uuid)
            FROM jsonb_array_elements(o.claimants) e)
         OR o.claimants @> jsonb_build_array(jsonb_build_object('user_id',o.eliminated_user_id,'weight',1)) THEN
        IF jsonb_array_length(unknown)<20 THEN
          unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_claimants_malformed','obligation_id',o.id));
        END IF;
        CONTINUE;
      END IF;
    END IF;
    BEGIN
      claims:=public.fn_exact_tournament_knockout_claimants(p_tournament_id,c.hand_id,c.eliminated_user_id);
    EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
      -- Only malformed read evidence is classified here. Cancellation,
      -- connection, permissions, and unexpected execution errors propagate.
      claims:=NULL;
    END;
    IF jsonb_typeof(claims) IS DISTINCT FROM 'array' THEN
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_recipients_unproven'));
      END IF;
      CONTINUE;
    END IF;
    IF jsonb_array_length(claims)=0 THEN
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_recipients_unproven'));
      END IF;
      CONTINUE;
    END IF;
    IF o.id IS NOT NULL AND o.claimants IS DISTINCT FROM claims THEN
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_claimant_snapshot_conflict','obligation_id',o.id));
      END IF;
      CONTINUE;
    END IF;
    IF NOT (claims @> jsonb_build_array(jsonb_build_object('user_id',p_eliminated_user_id,'weight',1))) THEN CONTINUE; END IF;
    IF o.id IS NOT NULL AND o.state='settled' THEN
      -- The marker discharges the accepted predecessor only after its exact
      -- recipient and settlement identities have also matched.
      IF public.fn_bounty_obligation_has_complete_marker(o.id) THEN CONTINUE; END IF;
      IF jsonb_array_length(unknown)<20 THEN
        unknown:=unknown||jsonb_build_array(detail||jsonb_build_object('reason','predecessor_marker_incomplete','obligation_id',o.id));
      END IF;
      CONTINUE;
    END IF;
    IF jsonb_array_length(blocked)<20 THEN
      blocked:=blocked||jsonb_build_array(detail||jsonb_build_object('obligation_id',o.id,
        'committed_at',prior_commit,'claimants',claims,
        'reason',CASE WHEN o.id IS NOT NULL THEN 'pending_pko_predecessor'
          WHEN c.state='pending' THEN 'unclaimed_pko_predecessor'
          ELSE 'closed_predecessor_claim_missing' END,
        'recovery_required',o.id IS NULL AND c.state<>'pending'));
    END IF;
  END LOOP;
  IF jsonb_array_length(unknown)>0 THEN
    RETURN jsonb_build_object('ok',false,'status','unknown','reason','predecessor_evidence_unproven',
      'inspected',inspected,'checked',checked,'predecessors',blocked,'unknown',unknown);
  END IF;
  IF jsonb_array_length(blocked)>0 THEN
    RETURN jsonb_build_object('ok',false,'status','blocked','reason','unsettled_pko_predecessor',
      'inspected',inspected,'checked',checked,'predecessors',blocked);
  END IF;
  RETURN jsonb_build_object('ok',true,'status','clear','inspected',inspected,'checked',checked);
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(p_tournament_id uuid, p_eliminated_user_id uuid, p_position integer, p_prize numeric, p_table_id uuid, p_hand_id uuid, p_hand_number bigint, p_seat_joined_at timestamp with time zone, p_knocker_user_id uuid, p_claimants jsonb, p_bubble_refund numeric DEFAULT 0, p_allow_existing_eliminated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_candidate public.tournament_knockout_candidates%ROWTYPE;
  v_atomic public.hand_atomic_commits%ROWTYPE;
  v_settlement_at timestamptz;
  v_settlement_hand_text text;
  v_settlement_hand_id uuid;
  v_mode text;
  v_claimants jsonb;
  v_input_claimants jsonb;
  v_knocker uuid;
  v_head numeric;
  v_hand_created_at timestamptz;
  v_position integer;
  v_prize numeric;
  v_claimed boolean := false;
  v_existing public.tournament_bounty_obligations%ROWTYPE;
  v_obligation_id uuid;
  v_activation_generation bigint := 0;
  v_pko_watermark bigint;
  v_bounty_blocked text := NULL;
  v_predecessors jsonb;
  v_activated_at timestamptz;
  v_bust_at timestamptz;
BEGIN
  IF p_tournament_id IS NULL OR p_eliminated_user_id IS NULL
     OR p_table_id IS NULL OR p_hand_id IS NULL OR p_hand_number IS NULL
     OR p_hand_number<1000000 OR p_seat_joined_at IS NULL
     OR p_bubble_refund IS NULL OR p_bubble_refund<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','missing_identity');
  END IF;
  IF p_bubble_refund<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;

  IF p_claimants IS NOT NULL THEN
    IF jsonb_typeof(p_claimants)<>'array' OR jsonb_array_length(p_claimants)=0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_claimants) e
          WHERE coalesce(e->>'user_id','')
                  !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR coalesce(e->>'weight','') !~ '^[0-9]+([.][0-9]+)?$'
             OR (e->>'weight')::numeric<=0
       ) THEN
      RETURN jsonb_build_object('ok',false,'reason','invalid_claimants');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('user_id',user_id,'weight',1)
                     ORDER BY user_id::text)
      INTO v_input_claimants
      FROM (
        SELECT DISTINCT (e->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(p_claimants) e
      ) q;
  END IF;

  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A hand triple is the immutable replay key. Two legitimate bounties may
  -- have the same player and seat_joined_at after a same-chair rebuy.
  SELECT * INTO v_existing
    FROM public.tournament_bounty_obligations o
   WHERE o.tournament_id=p_tournament_id
     AND o.table_id=p_table_id
     AND o.hand_id=p_hand_id
     AND o.hand_number=p_hand_number
     AND o.eliminated_user_id=p_eliminated_user_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.table_id IS DISTINCT FROM p_table_id
       OR v_existing.hand_id IS DISTINCT FROM p_hand_id
       OR v_existing.seat_joined_at IS DISTINCT FROM p_seat_joined_at
       OR v_existing.bubble_refund IS DISTINCT FROM round(p_bubble_refund,2)
       OR v_existing.position IS DISTINCT FROM p_position
       OR v_existing.prize IS DISTINCT FROM round(p_prize,2)
       OR (p_knocker_user_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(v_existing.claimants) c
              WHERE c->>'user_id'=p_knocker_user_id::text))
       OR (v_input_claimants IS NOT NULL
           AND v_existing.claimants IS DISTINCT FROM v_input_claimants) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','obligation_identity_conflict');
    END IF;
    IF v_existing.state='settled'
       AND NOT public.fn_bounty_obligation_has_complete_marker(v_existing.id) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','settled_marker_incomplete',
        'obligation_id',v_existing.id);
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'already',true,'claimed',false,
      'mode',v_existing.mode,'state',v_existing.state,
      'activation_generation',v_existing.activation_generation,
      'obligation_id',v_existing.id);
  END IF;

  IF NOT (coalesce(v_t.is_bounty,false) OR coalesce(v_t.is_pko,false)
          OR coalesce(v_t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok',false,'reason','not_bounty_tournament');
  END IF;
  IF upper(coalesce(v_t.status,''))<>'RUNNING'
     AND NOT (p_allow_existing_eliminated
              AND upper(coalesce(v_t.status,''))='COMPLETING') THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','tournament_lifecycle_not_claimable',
      'status',v_t.status);
  END IF;

  SELECT * INTO v_player FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','player_not_found');
  END IF;
  IF coalesce(v_player.chips,0)>0 THEN
    RETURN jsonb_build_object('ok',false,'reason','player_has_chips');
  END IF;
  IF v_player.status<>'playing' THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','status_not_claimable','status',v_player.status);
  END IF;
  IF p_position IS NULL OR p_position<2 OR p_prize IS NULL OR p_prize<0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  v_position:=p_position;
  v_prize:=p_prize;

  SELECT a.* INTO v_atomic
    FROM public.hand_atomic_commits a
   WHERE a.table_id=p_table_id
     AND a.hand_number=p_hand_number
     AND a.hand_id=p_hand_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.hand_atomic_commits a
       WHERE a.table_id=p_table_id AND a.hand_number=p_hand_number
    ) THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','atomic_knockout_history_identity_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_evidence_required');
  END IF;

  v_settlement_hand_text:=v_atomic.stack_result->>'hand_id';
  IF coalesce(v_settlement_hand_text,'')
       !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR v_atomic.stack_result->>'table_id'<>p_table_id::text
     OR coalesce(v_atomic.stack_result->>'hand_number','')
          !~ '^[0-9]+$'
     OR (v_atomic.stack_result->>'hand_number')::bigint<>p_hand_number
     OR coalesce(v_atomic.stack_result->'written'
                   ->>p_eliminated_user_id::text,'')
          !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (v_atomic.stack_result->'written'
           ->>p_eliminated_user_id::text)::numeric<>0 THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;
  v_settlement_hand_id:=v_settlement_hand_text::uuid;

  SELECT c.* INTO v_candidate
    FROM public.tournament_knockout_candidates c
   WHERE c.tournament_id=p_tournament_id
     AND c.table_id=p_table_id
     AND c.hand_number=p_hand_number
     AND c.hand_id=p_hand_id
     AND c.eliminated_user_id=p_eliminated_user_id;
  IF NOT FOUND
     OR v_candidate.seat_joined_at IS DISTINCT FROM p_seat_joined_at THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','atomic_knockout_candidate_identity_conflict');
  END IF;

  SELECT k.completed_at INTO v_settlement_at
    FROM public.settlement_idempotency_keys k
   WHERE k.table_id=p_table_id
     AND k.hand_id=v_settlement_hand_id
     AND k.status='succeeded'
     AND k.completed_at IS NOT NULL
     AND k.completed_at>=p_seat_joined_at
     AND coalesce(k.result->>'hand_number','') ~ '^[0-9]+$'
     AND (k.result->>'hand_number')::bigint=p_hand_number
     AND k.result->>'table_id'=p_table_id::text
     AND k.result->'written' ? p_eliminated_user_id::text
     AND coalesce(k.result->'written'->>p_eliminated_user_id::text,'')
           ~ '^-?[0-9]+([.][0-9]+)?$'
     AND (k.result->'written'->>p_eliminated_user_id::text)::numeric=0;
  IF v_settlement_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','accepted_zero_settlement_not_found');
  END IF;

  SELECT h.created_at INTO v_hand_created_at
    FROM public.hand_history h
   WHERE h.id=p_hand_id
     AND h.table_id=p_table_id
     AND h.hand_number=p_hand_number
     AND h.hand_number>=1000000
     AND h.created_at>=v_settlement_at
     AND h.created_at>=p_seat_joined_at
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) player
        WHERE coalesce(player->>'userId',player->>'user_id')=
                p_eliminated_user_id::text
          AND coalesce(player->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
          AND (player->>'stack')::numeric=0
     );
  IF v_hand_created_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','exact_knockout_history_not_found');
  END IF;

  v_claimants:=public.fn_exact_tournament_knockout_claimants(
    p_tournament_id,p_hand_id,p_eliminated_user_id);
  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN
    /* A PLACE IS NOT A BOUNTY (2026-09-10).
       fn_exact_tournament_knockout_claimants returns NULL when it cannot
       name the exact winner of the last pot the busted player was eligible
       for, and it is right to refuse to guess. That is a reason not to PAY
       a bounty. It is not a reason to withhold a finishing place from a
       player who provably busted - refusing here left 33 busts unrecorded
       across nine events and held their prize escrow for days. */
    v_bounty_blocked:='exact_pot_claimants_not_found';
    v_claimants:='[]'::jsonb;
  END IF;
  SELECT (e->>'user_id')::uuid INTO v_knocker
    FROM jsonb_array_elements(v_claimants) e
   ORDER BY e->>'user_id' LIMIT 1;
  IF v_bounty_blocked IS NULL AND p_knocker_user_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_claimants) e
        WHERE e->>'user_id'=p_knocker_user_id::text
     ) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_knocker');
  END IF;
  IF v_bounty_blocked IS NULL AND v_input_claimants IS NOT NULL
     AND v_input_claimants IS DISTINCT FROM v_claimants THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','claimants_do_not_match_exact_pot');
  END IF;

  /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11).
     The stage at the moment a claim is RECORDED says nothing about when the
     bust happened: a claim backlog recorded 06:27 busts at 13:57 as chest
     knockouts and spent another event's chests on them. v_atomic is the exact,
     identity-verified hand_atomic_commits row of the claimed hand; the sealed
     activation receipt of the current generation is the other end. Earlier ->
     the pre-activation mode the bust would have had. Later -> a chest. No
     receipt -> refused, as before. Order not provable -> the place is
     recorded and no bounty is paid (A PLACE IS NOT A BOUNTY). */
  IF coalesce(v_t.is_mystery_bounty,false)
     AND coalesce(v_t.mystery_bounty_stage,'pending')<>'pending' THEN
    v_activation_generation:=coalesce(v_t.mystery_bounty_activation_generation,0);
    SELECT ar.activated_at INTO v_activated_at
      FROM public.tournament_mystery_activation_receipts ar
     WHERE ar.tournament_id=p_tournament_id
       AND ar.activation_generation=v_activation_generation;
    IF v_activation_generation<=0 OR v_activated_at IS NULL THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','mystery_activation_evidence_missing');
    END IF;
    IF v_atomic.committed_at IS NOT NULL
       AND v_atomic.committed_at>v_activated_at THEN
      v_mode:='mystery_chest';
    ELSE
      v_mode:=CASE WHEN coalesce(v_t.is_pko,false) THEN 'pko'
                   ELSE 'mystery_pre' END;
      v_activation_generation:=0;
      IF v_atomic.committed_at IS NULL
         OR v_atomic.committed_at>=v_activated_at THEN
        v_bounty_blocked:=COALESCE(v_bounty_blocked,
                                   'mystery_phase_of_bust_not_proven');
      END IF;
    END IF;
  ELSE
    v_mode:=CASE
      WHEN coalesce(v_t.is_pko,false) THEN 'pko'
      WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
      ELSE 'regular'
    END;
    v_activation_generation:=0;
  END IF;

  IF v_mode='pko' THEN
    v_predecessors:=public.fn_pko_claim_predecessor_status_v1(
      p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,
      p_hand_number,p_seat_joined_at);
    IF v_predecessors->>'ok' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_predecessor_not_ready',
                               'predecessor_proof',v_predecessors);
    END IF;
  END IF;

  IF v_mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=p_tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN
      v_predecessors:=public.fn_pko_watermark_admission_status_v1(
        p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,
        p_hand_number,p_seat_joined_at,v_claimants);
      IF v_predecessors->>'ok' IS DISTINCT FROM 'true' THEN
        RETURN jsonb_build_object('ok',false,'reason','pko_order_unproven',
          'watermark_proof',v_predecessors);
      END IF;
    END IF;
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1 FROM public.tournament_bounty_obligations prior
     WHERE prior.tournament_id=p_tournament_id
       AND prior.mode='pko' AND prior.state='pending'
       AND (prior.hand_number<p_hand_number
            OR (prior.hand_number=p_hand_number
                AND prior.eliminated_user_id::text<
                    p_eliminated_user_id::text))
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(prior.claimants) c
          WHERE c->>'user_id'=p_eliminated_user_id::text
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','pending_pko_predecessor');
  END IF;

  IF v_bounty_blocked IS NULL AND v_mode='pko' AND EXISTS (
    SELECT 1
      FROM public.hand_history h
      CROSS JOIN LATERAL
        jsonb_array_elements(coalesce(h.players,'[]'::jsonb)) hp
     WHERE h.id=p_hand_id
       AND coalesce(hp->>'userId',hp->>'user_id','')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND coalesce(hp->>'userId',hp->>'user_id')<>
             p_eliminated_user_id::text
       AND coalesce(hp->>'stack','') ~ '^-?[0-9]+([.][0-9]+)?$'
       AND (hp->>'stack')::numeric<=0
       AND public.fn_exact_tournament_knockout_claimants(
             p_tournament_id,h.id,
             coalesce(hp->>'userId',hp->>'user_id')::uuid)
             @> jsonb_build_array(jsonb_build_object(
                  'user_id',p_eliminated_user_id,'weight',1))
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations predecessor
          WHERE predecessor.tournament_id=p_tournament_id
            AND predecessor.hand_number=p_hand_number
            AND predecessor.eliminated_user_id=
                coalesce(hp->>'userId',hp->>'user_id')::uuid
            AND predecessor.state='settled'
       )
  ) THEN
    RETURN jsonb_build_object('ok',false,'reason','same_hand_pko_predecessor');
  END IF;

  v_head:=coalesce(nullif(v_player.current_bounty,0),
                   nullif(v_t.bounty_amount,0));
  IF coalesce(v_head,0)<=0 THEN
    v_bounty_blocked:=COALESCE(v_bounty_blocked,'exact_head_value_not_found');
  END IF;

  /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). eliminated_at was
     now(), the moment this claim was accepted, so a bust accepted late was
     stamped later than busts that came after it. It is now the time of the
     bust, by the rule the non-bounty door stamps and
     fn_settle_tournament_places ranks with: the commit time of the accepted
     hand this claim is bound to, plus one microsecond per earlier rank in
     that hand - smaller hand-start stack first, then user id. A bust whose
     hand cannot be read is refused, never stamped with the clock; so is a
     generation the player provably played on from - a posted rebuy leg
     after it AND a later hand of this event that deals the player in - since
     its hand is then not the bust and nothing here can say which one is. */
  SELECT a.committed_at
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id=c.tournament_id
               AND s.table_id=c.table_id
               AND s.hand_number=c.hand_number
               AND s.hand_id=c.hand_id
               AND (s.stack_before,s.eliminated_user_id)
                   <(c.stack_before,c.eliminated_user_id))::integer
           * interval '1 microsecond'
    INTO v_bust_at
    FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id=c.table_id
     AND a.hand_number=c.hand_number
     AND a.hand_id=c.hand_id
   WHERE c.id=v_candidate.id
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_eliminated_user_id
     AND c.state='pending';
  IF v_bust_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_eliminated_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>v_candidate.created_at)
     AND EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.tournament_id=p_tournament_id
          AND h.hand_number>p_hand_number
          AND (h.players @> jsonb_build_array(jsonb_build_object(
                 'userId',p_eliminated_user_id::text))
               OR h.players @> jsonb_build_array(jsonb_build_object(
                 'user_id',p_eliminated_user_id::text)))) THEN
    /* Nothing newer can bind this player, who stays 'playing' at zero
       chips, so this refusal would hold the event open for ever without a
       word. It is written where the money board reads - once: one open alert
       per player. */
    INSERT INTO public.financial_alerts(severity,source,message,context)
    SELECT 'critical','knockout_door.payout_blocked_by_unrecordable_bust',
      'A busted player cannot be recorded, so the tournament cannot finish: '
        ||'the only knockout generation left to record them by is one they '
        ||'rebought from and played on after, and no later bust was captured. '
        ||'Their place needs a ruling from their last hand.',
      jsonb_build_object('tournament_id',p_tournament_id,'user_id',p_eliminated_user_id,
        'reason','knockout_bust_time_unproven',
        'detail','played_on_after_a_rebuy','hand_number',p_hand_number)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source='knockout_door.payout_blocked_by_unrecordable_bust'
          AND NOT fa.resolved
          AND fa.context->>'tournament_id'=p_tournament_id::text
          AND fa.context->>'user_id'=p_eliminated_user_id::text);
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven',
                              'detail','played_on_after_a_rebuy');
  END IF;

  UPDATE public.tournament_players tp
     SET status='eliminated',position=p_position,prize=p_prize,
         eliminated_at=v_bust_at
   WHERE tp.tournament_id=p_tournament_id
     AND tp.user_id=p_eliminated_user_id
     AND tp.status='playing' AND tp.chips<=0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bounty elimination CAS missed after locked claim'
      USING ERRCODE='serialization_failure';
  END IF;
  v_claimed:=true;

  IF v_bounty_blocked IS NULL THEN
  INSERT INTO public.tournament_bounty_obligations(
    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,
    settlement_completed_at,seat_joined_at,position,prize,bubble_refund,
    mode,activation_generation,head_amount,knocker_user_id,claimants,
    next_attempt_at)
  VALUES (
    p_tournament_id,p_eliminated_user_id,p_table_id,p_hand_id,p_hand_number,
    v_settlement_at,p_seat_joined_at,v_position,round(v_prize,2),0,
    v_mode,v_activation_generation,round(v_head,2),v_knocker,v_claimants,
    CASE WHEN v_mode='mystery_chest' THEN now()+interval '30 seconds'
         ELSE now() END)
  RETURNING id INTO v_obligation_id;
  ELSE
    /* The bust is recorded and placed above. The head could not be
       attributed, so no obligation is written: fn_tournament_has_unsettled_bounties
       only sees obligations that EXIST, so the event can finish, and the
       head stays in tournaments.bounty_pool for fn_finalize_bounty_pool to
       resolve as residual with its own completion receipt. This row is the
       record that it happened - severity `warning`, so
       fn_ca_financial_alert_to_incident (which promotes only `critical`)
       does not raise a board item per bust. A listed fact, not an alarm. */
    INSERT INTO public.financial_alerts(severity,source,message,context)
    VALUES ('warning',
      'fn_claim_tournament_bounty_elimination.bounty_head_not_attributed',
      'A bust was recorded and placed, but its bounty head could not be '
        ||'attributed ('||v_bounty_blocked||'); the head stays in the '
        ||'bounty pool as residual.',
      jsonb_build_object('tournament_id',p_tournament_id,
        'eliminated_user_id',p_eliminated_user_id,'table_id',p_table_id,
        'hand_id',p_hand_id,'hand_number',p_hand_number,
        'position',v_position,'head_amount',round(coalesce(v_head,0),2),
        'mode',v_mode,'reason',v_bounty_blocked));
  END IF;

  UPDATE public.table_seats s
     SET left_at=coalesce(s.left_at,now())
   WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id
     AND s.joined_at=p_seat_joined_at AND s.left_at IS NULL;
  UPDATE public.tables tb
     SET current_players=(
       SELECT count(*) FROM public.table_seats s
        WHERE s.table_id=p_table_id AND s.left_at IS NULL)
   WHERE tb.id=p_table_id;
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  UPDATE public.tournament_bounty_obligations o
     SET state='settled',settled_at=now()
   WHERE o.id=v_obligation_id
     AND public.fn_bounty_obligation_has_complete_marker(o.id);

  RETURN jsonb_build_object(
    'ok',true,'already',false,'claimed',v_claimed,'mode',v_mode,
    'bounty_blocked',v_bounty_blocked,
    'state',(SELECT o.state FROM public.tournament_bounty_obligations o
              WHERE o.id=v_obligation_id),
    'activation_generation',v_activation_generation,'bubble_refund',0,
    'obligation_id',v_obligation_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_collect_bounty(p_tournament_id uuid, p_eliminated_user_id uuid, p_collector_user_id uuid, p_claimants jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_result jsonb;
  v_shares jsonb;
  v_paid_cash numeric;
  v_added_to_head numeric;
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_prior_context text;
  v_obligation_count integer;
  v_pko_watermark bigint;
  v_predecessors jsonb;
  v_t record;
  v_elim record;
  v_head numeric;
  v_available numeric;
  v_payable numeric;
  v_cash numeric;
  v_to_head numeric;
  v_cents integer;
  v_cash_cents integer;
  v_mode text;
  v_funded boolean;
  v_claimants jsonb;
  v_n integer;
  v_total_weight numeric;
  v_paid_total numeric := 0;
  v_head_total numeric := 0;
  c record;
  v_share_cents integer;
  v_assigned_cents integer := 0;
  v_i integer := 0;
  v_prior numeric;
  v_settle jsonb;
  v_desc text;
  v_core_collector_user_id uuid;
  v_core_claimants jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;

  IF COALESCE(v_context,'')
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.id=v_context::uuid AND bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  ELSE
    SELECT count(*) INTO v_obligation_count
      FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest';
    IF v_obligation_count>1 THEN
      RETURN jsonb_build_object('ok',false,'reason','bounty_generation_identity_required');
    END IF;
    SELECT * INTO o FROM public.tournament_bounty_obligations bo
     WHERE bo.tournament_id=p_tournament_id
       AND bo.eliminated_user_id=p_eliminated_user_id
       AND bo.mode<>'mystery_chest'
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;
  IF o.state='settled' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id',b.collector_player_id,
             'cash',GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0)),
             'to_head',COALESCE(b.added_to_collector_bounty,0))
             ORDER BY b.collector_player_id),'[]'::jsonb),
           COALESCE(sum(GREATEST(0,b.bounty_amount-COALESCE(b.added_to_collector_bounty,0))),0),
           COALESCE(sum(b.added_to_collector_bounty),0)
      INTO v_shares,v_paid_cash,v_added_to_head
      FROM public.tournament_bounties b
     WHERE b.bounty_obligation_id=o.id;
    IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
      RETURN jsonb_build_object('ok',false,'reason','settled_marker_incomplete',
                                'obligation_id',o.id);
    END IF;
    IF o.mode='pko' THEN
      INSERT INTO public.tournament_pko_settlement_watermarks
        (tournament_id,last_settled_hand_number,last_obligation_id)
      VALUES (o.tournament_id,o.hand_number,o.id)
      ON CONFLICT (tournament_id) DO UPDATE
        SET last_settled_hand_number=GREATEST(
              public.tournament_pko_settlement_watermarks.last_settled_hand_number,
              EXCLUDED.last_settled_hand_number),
            last_obligation_id=CASE
              WHEN EXCLUDED.last_settled_hand_number>=
                   public.tournament_pko_settlement_watermarks.last_settled_hand_number
              THEN EXCLUDED.last_obligation_id
              ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
            updated_at=now();
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'obligation_id',o.id,
      'marker_verified',true,'mode',o.mode,'head',o.head_amount,
      'paid_cash',v_paid_cash,'added_to_head',v_added_to_head,
      'split',jsonb_array_length(v_shares)>1,'shares',v_shares);
  END IF;

  IF o.mode='pko' THEN
    v_predecessors:=public.fn_pko_claim_predecessor_status_v1(
      o.tournament_id,o.eliminated_user_id,o.table_id,o.hand_id,
      o.hand_number,o.seat_joined_at);
    IF v_predecessors->>'ok' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('ok',false,'reason','pko_predecessor_not_ready',
                               'predecessor_proof',v_predecessors);
    END IF;
  END IF;

  IF o.mode='pko' THEN
    SELECT w.last_settled_hand_number INTO v_pko_watermark
      FROM public.tournament_pko_settlement_watermarks w
     WHERE w.tournament_id=o.tournament_id FOR UPDATE;
    IF v_pko_watermark IS NOT NULL AND o.hand_number<v_pko_watermark THEN
      v_predecessors:=public.fn_pko_watermark_admission_status_v1(
        o.tournament_id,o.eliminated_user_id,o.table_id,o.hand_id,
        o.hand_number,o.seat_joined_at,o.claimants);
      IF v_predecessors->>'ok' IS DISTINCT FROM 'true' THEN
        RETURN jsonb_build_object('ok',false,'reason','pko_order_unproven',
          'watermark_proof',v_predecessors);
      END IF;
    END IF;
    -- The accepted-candidate guard above proves every actual incoming head
    -- dependency, including larger reserved hand numbers. Unrelated pending
    -- heads do not change this captured head and must not serialize its payout.
  END IF;

  -- Ignore caller ordering/weights. The exact pot-derived, roster-validated
  -- snapshot stored by the atomic claim is the only payout authority. The
  -- audited payer is inlined here so this root survives retirement of the
  -- temporary rolling-deployment body.
  v_core_collector_user_id := o.knocker_user_id;
  v_core_claimants := o.claimants;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);

  <<collect_core>>
  BEGIN
    IF v_core_collector_user_id IS NULL OR p_eliminated_user_id IS NULL THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'missing_party');
      EXIT collect_core;
    END IF;

    SELECT id, is_bounty, is_pko, is_mystery_bounty, bounty_amount,
           bounty_pool, bounty_pool_paid, mystery_bounty_stage
      INTO v_t FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
      EXIT collect_core;
    END IF;
    IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
            OR COALESCE(v_t.is_mystery_bounty,false)) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'not_a_bounty_tournament');
      EXIT collect_core;
    END IF;

    IF COALESCE(v_t.is_pko, false) AND COALESCE(v_t.is_mystery_bounty, false) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'undefined_pko_mystery_hybrid',
        'detail', 'PKO heads claim against bounty_pool; mystery chests are a sealed '
               || 'inventory. No split satisfies both. This event should not exist.');
      EXIT collect_core;
    END IF;

    /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11). A
       persisted mystery_pre obligation is a head earned before activation;
       the seed keeps it outside the chest pool, so it is paid from the
       regular half after the chests open. Refusing it only strands it. */
    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active'
       AND o.mode IS DISTINCT FROM 'mystery_pre' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
      EXIT collect_core;
    END IF;

    IF EXISTS (
      SELECT 1 FROM tournament_bounties b
       WHERE b.tournament_id = p_tournament_id
         AND b.eliminated_player_id = p_eliminated_user_id
         AND (
           b.bounty_obligation_id = (SELECT pending.id
             FROM tournament_bounty_obligations pending
            WHERE pending.tournament_id=p_tournament_id
              AND pending.eliminated_user_id=p_eliminated_user_id
              AND pending.mode <> 'mystery_chest' AND pending.state='pending'
            ORDER BY pending.hand_number, pending.created_at LIMIT 1)
           OR (b.bounty_obligation_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM tournament_bounty_obligations pending
              WHERE pending.tournament_id=p_tournament_id
                AND pending.eliminated_user_id=p_eliminated_user_id
                AND pending.mode <> 'mystery_chest' AND pending.state='pending'))
         )
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'already_collected');
      EXIT collect_core;
    END IF;

    SELECT current_bounty INTO v_elim
      FROM tournament_players
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'eliminated_player_not_in_tournament');
      EXIT collect_core;
    END IF;

    v_mode := CASE WHEN COALESCE(v_t.is_pko,false) THEN 'pko'
                   WHEN COALESCE(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
                   ELSE 'regular' END;

    v_head := COALESCE(NULLIF(v_elim.current_bounty, 0), v_t.bounty_amount, 0);
    IF v_head <= 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_head_value');
      EXIT collect_core;
    END IF;
    IF EXISTS (
      SELECT 1 FROM tournament_bounty_obligations pending
       WHERE pending.tournament_id=p_tournament_id
         AND pending.eliminated_user_id=p_eliminated_user_id
         AND pending.mode <> 'mystery_chest' AND pending.state='pending'
         AND pending.head_amount IS DISTINCT FROM round(v_head,2)
    ) THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'head_snapshot_changed');
      EXIT collect_core;
    END IF;

    v_funded := COALESCE(v_t.bounty_pool, 0) > 0;
    SELECT round(COALESCE(v_t.bounty_pool,0) - COALESCE(SUM(
             CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                  ELSE wt.amount END), 0), 2)
      INTO v_available
      FROM wallet_transactions wt
     WHERE wt.related_entity_id = p_tournament_id
       AND wt.category = 'bounty';
    -- DIAMOND PHASE 9: a Diamond bounty is a ledger row, not a wallet row;
    -- the bank is what the entries put in less what it already paid.
    IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
      SELECT e.bounty_balance INTO v_available
        FROM public.fn_poker_diamond_tournament_escrow(p_tournament_id) e;
    END IF;

    IF v_funded THEN
      IF v_available <= 0 THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_exhausted',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      IF v_available < v_head THEN
        v_result := jsonb_build_object('ok', false, 'reason', 'bounty_pool_underfunded',
                                      'head', v_head, 'available', v_available);
        EXIT collect_core;
      END IF;
      v_payable := v_head;
    ELSE
      v_payable := v_head;
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'user_id', x.uid, 'weight', x.w)), '[]'::jsonb)
      INTO v_claimants
      FROM (
        SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
          FROM jsonb_array_elements(COALESCE(v_core_claimants, '[]'::jsonb)) e
         WHERE (e->>'user_id') IS NOT NULL
           AND COALESCE((e->>'weight')::numeric, 0) > 0
           AND EXISTS (
             SELECT 1 FROM tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.user_id = (e->>'user_id')::uuid)
      ) x;
    v_n := jsonb_array_length(v_claimants);
    IF v_n <= 1 THEN
      v_claimants := jsonb_build_array(jsonb_build_object(
        'user_id', v_core_collector_user_id, 'weight', 1));
      v_n := 1;
    END IF;
    SELECT sum((e->>'weight')::numeric) INTO v_total_weight
      FROM jsonb_array_elements(v_claimants) e;

    v_cents := round(v_payable * 100)::integer;
    v_desc := CASE v_mode
      WHEN 'pko' THEN 'PKO bounty (cash half) from eliminated player'
      WHEN 'mystery_pre' THEN 'Bounty collected before the mystery phase opened'
      ELSE 'Bounty collected from eliminated player' END
      || CASE WHEN v_n > 1 THEN ' (split pot, ' || v_n || ' winners)' ELSE '' END;
    v_shares := '[]'::jsonb;

    FOR c IN
      SELECT (e->>'user_id')::uuid AS uid, (e->>'weight')::numeric AS w
        FROM jsonb_array_elements(v_claimants) e
       ORDER BY (e->>'weight')::numeric ASC, (e->>'user_id')
    LOOP
      v_i := v_i + 1;
      IF v_i < v_n THEN
        v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;
        IF v_share_cents > 0 THEN
          v_share_cents := public.fn_ca_unit_floor_cents(
            v_share_cents::bigint,
            public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;
        END IF;
      ELSE
        v_share_cents := v_cents - v_assigned_cents;
      END IF;
      v_assigned_cents := v_assigned_cents + v_share_cents;
      CONTINUE WHEN v_share_cents <= 0;

      IF v_mode = 'pko' THEN
        v_cash_cents := public.fn_ca_unit_floor_cents(
          (v_share_cents / 2)::bigint,
          public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;
        v_cash := v_cash_cents / 100.0;
        v_to_head := (v_share_cents - v_cash_cents) / 100.0;
      ELSE
        v_cash := v_share_cents / 100.0;
        v_to_head := 0;
      END IF;

      IF v_cash > 0 THEN
        v_prior := COALESCE((
          SELECT debt.amount_paid FROM public.tournament_obligations debt
           WHERE debt.tournament_id = p_tournament_id
             AND debt.kind = 'bounty'
             AND debt.place IS NULL
             AND debt.user_id = c.uid), 0);
        v_settle := public.fn_settle_tournament_obligation(
          p_tournament_id, 'bounty', NULL, c.uid, round(v_prior + v_cash, 2),
          'fn_collect_bounty', v_desc);
        IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: bounty of % to % in tournament % refused (%); nothing recorded',
            v_cash, c.uid, p_tournament_id,
            COALESCE(v_settle->>'refused_reason', 'unknown');
        END IF;
        IF round(COALESCE((v_settle->>'paid')::numeric, 0), 2)
             <> round(v_cash, 2) THEN
          RAISE EXCEPTION
            'fn_collect_bounty: obligation paid % but the share is % for % in tournament %; nothing recorded',
            v_settle->>'paid', v_cash, c.uid, p_tournament_id;
        END IF;
      END IF;

      UPDATE tournament_players
         SET bounties_collected = COALESCE(bounties_collected,0) + 1,
             bounty_winnings = round(COALESCE(bounty_winnings,0) + v_cash, 2),
             current_bounty = round(COALESCE(current_bounty,0) + v_to_head, 2)
       WHERE tournament_id = p_tournament_id AND user_id = c.uid;

      INSERT INTO tournament_bounties
        (tournament_id, eliminated_player_id, collector_player_id, bounty_amount,
         added_to_collector_bounty, is_mystery_revealed)
      VALUES
        (p_tournament_id, p_eliminated_user_id, c.uid,
         round(v_share_cents / 100.0, 2),
         CASE WHEN v_to_head > 0 THEN v_to_head ELSE NULL END, false);

      v_paid_total := v_paid_total + v_cash;
      v_head_total := v_head_total + v_to_head;
      v_shares := v_shares || jsonb_build_object(
        'user_id', c.uid, 'cash', v_cash, 'to_head', v_to_head);
    END LOOP;

    UPDATE tournament_players SET current_bounty = 0
     WHERE tournament_id = p_tournament_id AND user_id = p_eliminated_user_id;

    IF v_funded THEN
      UPDATE tournaments
         SET bounty_pool_paid = round(COALESCE(bounty_pool_paid,0) + v_paid_total, 2)
       WHERE id = p_tournament_id;
    END IF;

    v_result := jsonb_build_object(
      'ok', true, 'mode', v_mode, 'funded', v_funded,
      'head', v_head, 'paid_cash', round(v_paid_total, 2),
      'added_to_head', round(v_head_total, 2),
      'split', v_n > 1, 'shares', v_shares,
      'capped', v_funded AND v_payable < v_head,
      'pool_remaining', CASE WHEN v_funded
                             THEN round(v_available - v_paid_total, 2) END);
  END collect_core;

  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);

  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN
    -- A semantic pre-write refusal is safe to commit and stays pending. Any
    -- accepted payer result below must satisfy the exact marker postcondition
    -- or raise so its wallet/head/counter mutations roll back atomically.
    RETURN v_result || jsonb_build_object('obligation_id',o.id);
  END IF;

  UPDATE public.tournament_bounty_obligations bo
     SET state='settled',settled_at=COALESCE(settled_at,now()),last_error=NULL
   WHERE bo.id=o.id AND bo.state='pending'
     AND public.fn_bounty_obligation_has_complete_marker(bo.id);
  IF NOT public.fn_bounty_obligation_has_complete_marker(o.id)
     OR NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations bo
                     WHERE bo.id=o.id AND bo.state='settled') THEN
    RAISE EXCEPTION 'accepted bounty payout did not produce the exact settled marker for %',o.id
      USING ERRCODE='check_violation';
  END IF;
  IF o.mode='pko' THEN
    INSERT INTO public.tournament_pko_settlement_watermarks
      (tournament_id,last_settled_hand_number,last_obligation_id)
    VALUES (o.tournament_id,o.hand_number,o.id)
    ON CONFLICT (tournament_id) DO UPDATE
      SET last_settled_hand_number=GREATEST(
            public.tournament_pko_settlement_watermarks.last_settled_hand_number,
            EXCLUDED.last_settled_hand_number),
          last_obligation_id=CASE
            WHEN EXCLUDED.last_settled_hand_number>=
                 public.tournament_pko_settlement_watermarks.last_settled_hand_number
            THEN EXCLUDED.last_obligation_id
            ELSE public.tournament_pko_settlement_watermarks.last_obligation_id END,
          updated_at=now();
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'marker_verified',true);
END;
$function$;

ALTER FUNCTION public.fn_pko_candidate_accepted_scope_v1(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_pko_candidate_accepted_scope_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $postflight$
DECLARE item jsonb;p record;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements($manifest$[{"signature":"public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)","before":"7891b176cdfdf8d8088c10b59240cfe3","after":"eb4fa0f4d743202037950334f0b99f83","acl":"{postgres=X/postgres}","volatility":"v"},{"signature":"public.fn_collect_bounty(uuid,uuid,uuid,jsonb)","before":"64474c90007dc5a91e253d02150dc94e","after":"bc621ffbddfd931897706f6d1f099109","acl":"{postgres=X/postgres,service_role=X/postgres}","volatility":"v"},{"signature":"public.fn_pko_candidate_accepted_scope_v1(uuid,uuid)","before":null,"after":"34c837517891f25a801a6ec1f7f6b511","acl":"{postgres=X/postgres}","volatility":"s"},{"signature":"public.fn_pko_claim_predecessor_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone)","before":null,"after":"bc18225d08c051506504196abacd7c83","acl":"{postgres=X/postgres}","volatility":"s"},{"signature":"public.fn_pko_watermark_admission_status_v1(uuid,uuid,uuid,uuid,bigint,timestamp with time zone,jsonb)","before":null,"after":"9d67a9c6207fb00fb971adc8c3be0b77","acl":"{postgres=X/postgres}","volatility":"s"}]$manifest$::jsonb) LOOP
  SELECT f.*,r.rolname owner INTO p FROM pg_proc f JOIN pg_roles r ON r.oid=f.proowner
   WHERE f.oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR md5(p.prosrc)<>item->>'after'
     OR p.owner<>'postgres' OR p.proacl::text IS DISTINCT FROM item->>'acl'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR p.prosecdef IS DISTINCT FROM true OR p.provolatile::text IS DISTINCT FROM item->>'volatility' THEN
   RAISE EXCEPTION 'PKO dependency postimage or metadata mismatch: %',item->>'signature';
  END IF;
 END LOOP;
END $postflight$;
COMMIT;
