-- Exact accepted elimination may finish before a source manifest is frozen.
-- No park withdrawal, money formula, candidate proof or public API change.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its exact enabled trigger definition is checked and retained; only the private owning function is composed below.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its exact enabled trigger definition is checked and retained; only the private owning function is composed below.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_try_lane(uuid)') AND md5(pg_get_functiondef(oid))='78a3a191b9991b0a3a343db39de335aa' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','smarter_private.f06_try_lane(uuid)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='smarter_private.f06_try_lane(uuid)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','smarter_private.f06_try_lane(uuid)'; END IF; END $preimage$;
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)') AND md5(pg_get_functiondef(oid))='d219ceeed1041eed5cf2c543315eb91b' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; END $preimage$;
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)') AND md5(pg_get_functiondef(oid))='2c34f4cb405753e1180aa59bfb8b1f35' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}, {"role": "service_role", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'; END IF; END $preimage$;
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)') AND md5(pg_get_functiondef(oid))='9eb078e5860e9bdd8c0afcdbffc02504' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}, {"role": "service_role", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_claim_tournament_bounty_elimination(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; END $preimage$;
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_source_guard()') AND md5(pg_get_functiondef(oid))='6c108a5830fa520b8e48b7cab04b053a' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','smarter_private.f06_source_guard()'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='smarter_private.f06_source_guard()'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','smarter_private.f06_source_guard()'; END IF; END $preimage$;
DO $preimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)') AND md5(pg_get_functiondef(oid))='be0bc3420eca1e0c6e579c35b31fed43' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_AUTHORITY_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF; END $preimage$;
DO $triggers$ BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND
   ((tgrelid='public.table_seats'::regclass AND tgname='a00_f06_source_seat'
     AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')
    OR (tgrelid='public.tournament_players'::regclass AND tgname='a00_f06_source_roster'
     AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')) AND tgenabled='O')<>2 THEN
 RAISE EXCEPTION 'F06_ELIMINATION_TRIGGER_DRIFT'; END IF;
END $triggers$;
CREATE TABLE smarter_private.f06_elimination_dispatch(
 xid bigint NOT NULL,relation_name text NOT NULL CHECK(relation_name IN ('tournament_players','table_seats')),
 row_id uuid NOT NULL,candidate_id uuid NOT NULL,old_record jsonb NOT NULL,new_record jsonb NOT NULL,
 PRIMARY KEY(xid,relation_name,row_id));
ALTER TABLE smarter_private.f06_elimination_dispatch OWNER TO postgres;
ALTER TABLE smarter_private.f06_elimination_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.f06_elimination_dispatch FROM PUBLIC,anon,authenticated,service_role;
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

  -- Only this validated claim can authorize its exact next roster write.
  -- No request setting or public API can mint this transaction-local proof.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'tournament_players',v_player.id,v_candidate.id,to_jsonb(v_player),
    to_jsonb(v_player)||jsonb_build_object('status','eliminated',
      'position',p_position,'prize',p_prize,'eliminated_at',v_bust_at)
  WHERE EXISTS(SELECT 1 FROM smarter_private.f06_operations o
    WHERE o.source_table_id=v_player.table_id
      AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));
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

  DELETE FROM smarter_private.f06_elimination_dispatch
   WHERE xid=txid_current() AND candidate_id=v_candidate.id
     AND relation_name='tournament_players';
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

  -- Closing the exact already-zero seat belongs to the same proven bust.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'table_seats',s.id,v_candidate.id,to_jsonb(s),
    to_jsonb(s)||jsonb_build_object('left_at',now())
  FROM public.table_seats s
  JOIN public.tournament_knockout_candidates c ON c.id=v_candidate.id
  WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id AND s.left_at IS NULL
    AND s.stack=0 AND s.id=c.seat_id AND s.joined_at=c.seat_joined_at
    AND s.table_id=c.table_id AND s.user_id=c.eliminated_user_id
    AND EXISTS(SELECT 1 FROM smarter_private.f06_operations o
      WHERE o.source_table_id=s.table_id
        AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));
  UPDATE public.table_seats s
     SET left_at=coalesce(s.left_at,now())
   WHERE s.table_id=p_table_id AND s.user_id=p_eliminated_user_id
     AND s.joined_at=p_seat_joined_at AND s.left_at IS NULL;

  DELETE FROM smarter_private.f06_elimination_dispatch
   WHERE xid=txid_current() AND candidate_id=v_candidate.id
     AND relation_name='table_seats';
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
REVOKE ALL ON FUNCTION public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean) FROM PUBLIC,anon,authenticated,service_role;
DO $postimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)') AND md5(pg_get_functiondef(oid))='b560eb4c685afe1081f5a6aea4aca363' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_POSTIMAGE_DRIFT: %','public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'; END IF; END $postimage$;
CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR o.revision<>0 OR o.custody_id IS NOT NULL OR o.custody_generation IS NOT NULL
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $postimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_source_guard()') AND md5(pg_get_functiondef(oid))='de1b25f96d2c08bf20213c0e194ae261' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_POSTIMAGE_DRIFT: %','smarter_private.f06_source_guard()'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='smarter_private.f06_source_guard()'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','smarter_private.f06_source_guard()'; END IF; END $postimage$;
CREATE OR REPLACE FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(p_tournament_id uuid, p_user_id uuid, p_position integer, p_prize numeric, p_bubble_refund numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_p public.tournament_players%ROWTYPE;
  v_changed integer;
  v_released_tables uuid[] := ARRAY[]::uuid[];
  v_bust_at timestamptz;
  v_bust_hand bigint;
  v_bust_captured_at timestamptz;
  v_resolved_candidate_id uuid;
BEGIN
  IF p_position < 2 OR p_prize IS NULL OR p_prize < 0
     OR p_bubble_refund IS NULL OR p_bubble_refund < 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_place_or_prize');
  END IF;
  IF p_bubble_refund <> 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','bubble_refund_requires_finalized_batch');
  END IF;
  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_running');
  END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_requires_outbox_claim');
  END IF;
  SELECT * INTO v_p FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','player_not_found'); END IF;
  IF v_p.status = 'winner' THEN
    RETURN jsonb_build_object('ok',false,'reason','player_is_winner');
  END IF;
  IF v_p.status = 'eliminated' THEN
    IF v_p.position IS DISTINCT FROM p_position
       OR round(COALESCE(v_p.prize,0),2) <> round(p_prize,2) THEN
      RETURN jsonb_build_object('ok',false,'reason','elimination_identity_conflict');
    END IF;
    RETURN jsonb_build_object('ok',true,'already',true,'position',v_p.position,'prize',v_p.prize);
  END IF;
  IF v_p.status <> 'playing' OR COALESCE(v_p.chips,0) > 0 THEN
    RETURN jsonb_build_object('ok',false,'reason','not_busted');
  END IF;
  /* A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11). eliminated_at was
     now(), the moment the door ACCEPTED a bust, so a bust the door refused
     for a while - an orphaned generation, a stale seat - was stamped later
     than busts that came after it. It is now the time of the bust: the
     commit time of the accepted hand of the generation the calling door has
     just bound and proved (the latest committed zero-stack generation), plus
     one microsecond per earlier rank in that hand - smaller hand-start stack
     first (it busts first and finishes lower), then user id. That is the
     rule fn_settle_tournament_places ranks places by: busts in different
     hands are ordered by those hands' commit times. A bust whose hand cannot
     be read is refused, never stamped with the clock; so is a generation the
     player provably played on from - a posted rebuy leg after it AND a later
     hand of this event that deals the player in - since its hand is then not
     the bust and nothing here can say which one is. */
  v_resolved_candidate_id:=public.fn_ca_latest_committed_knockout_candidate(
    p_tournament_id,p_user_id);
  SELECT a.committed_at
         + (SELECT count(*)
              FROM public.tournament_knockout_candidates s
             WHERE s.tournament_id=c.tournament_id
               AND s.table_id=c.table_id
               AND s.hand_number=c.hand_number
               AND s.hand_id=c.hand_id
               AND (s.stack_before,s.eliminated_user_id)
                   <(c.stack_before,c.eliminated_user_id))::integer
           * interval '1 microsecond',
         c.hand_number,c.created_at
    INTO v_bust_at,v_bust_hand,v_bust_captured_at
    FROM public.tournament_knockout_candidates c
    JOIN public.hand_atomic_commits a
      ON a.table_id=c.table_id
     AND a.hand_number=c.hand_number
     AND a.hand_id=c.hand_id
   WHERE c.id=v_resolved_candidate_id
     AND c.tournament_id=p_tournament_id
     AND c.eliminated_user_id=p_user_id
     AND c.state='pending';
  IF v_bust_at IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven');
  END IF;
  IF EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.from_entity_id=p_user_id
          AND l.tournament_id=p_tournament_id
          AND l.category='rebuy'
          AND l.from_type='player_wallet'
          AND l.to_type='prize_liability'
          AND l.status='posted'
          AND l.amount>0
          AND l.created_at>v_bust_captured_at)
     AND EXISTS (
       SELECT 1 FROM public.hand_history h
        WHERE h.tournament_id=p_tournament_id
          AND h.hand_number>v_bust_hand
          AND (h.players @> jsonb_build_array(jsonb_build_object(
                 'userId',p_user_id::text))
               OR h.players @> jsonb_build_array(jsonb_build_object(
                 'user_id',p_user_id::text)))) THEN
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
      jsonb_build_object('tournament_id',p_tournament_id,'user_id',p_user_id,
        'reason','knockout_bust_time_unproven',
        'detail','played_on_after_a_rebuy','hand_number',v_bust_hand)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts fa
        WHERE fa.source='knockout_door.payout_blocked_by_unrecordable_bust'
          AND NOT fa.resolved
          AND fa.context->>'tournament_id'=p_tournament_id::text
          AND fa.context->>'user_id'=p_user_id::text);
    RETURN jsonb_build_object('ok',false,'reason','knockout_bust_time_unproven',
                              'detail','played_on_after_a_rebuy');
  END IF;
  -- Only this validated claim can authorize its exact next roster write.
  -- No request setting or public API can mint this transaction-local proof.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'tournament_players',v_p.id,v_resolved_candidate_id,to_jsonb(v_p),
    to_jsonb(v_p)||jsonb_build_object('status','eliminated',
      'position',p_position,'prize',round(p_prize,2),'eliminated_at',v_bust_at)
  WHERE EXISTS(SELECT 1 FROM smarter_private.f06_operations o
    WHERE o.source_table_id=v_p.table_id
      AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));
  UPDATE public.tournament_players
     SET status='eliminated',position=p_position,prize=round(p_prize,2),eliminated_at=v_bust_at
   WHERE tournament_id=p_tournament_id AND user_id=p_user_id
     AND status='playing' AND COALESCE(chips,0)<=0;
  GET DIAGNOSTICS v_changed=ROW_COUNT;
  IF v_changed <> 1 THEN
    RAISE EXCEPTION 'zero-stack elimination CAS changed % rows',v_changed
      USING ERRCODE='serialization_failure';
  END IF;


  DELETE FROM smarter_private.f06_elimination_dispatch
   WHERE xid=txid_current() AND candidate_id=v_resolved_candidate_id
     AND relation_name='tournament_players';
  -- Closing the exact already-zero seat belongs to the same proven bust.
  INSERT INTO smarter_private.f06_elimination_dispatch
    (xid,relation_name,row_id,candidate_id,old_record,new_record)
  SELECT txid_current(),'table_seats',s.id,v_resolved_candidate_id,to_jsonb(s),
    to_jsonb(s)||jsonb_build_object('left_at',now())
  FROM public.table_seats s
  JOIN public.tournament_knockout_candidates c ON c.id=v_resolved_candidate_id
  WHERE s.user_id=p_user_id AND s.left_at IS NULL
    AND s.stack=0 AND s.id=c.seat_id AND s.joined_at=c.seat_joined_at
    AND s.table_id=c.table_id AND s.user_id=c.eliminated_user_id
    AND EXISTS(SELECT 1 FROM smarter_private.f06_operations o
      WHERE o.source_table_id=s.table_id
        AND o.state NOT IN ('acknowledged','withdrawn_before_manifest'));
  WITH released AS (
    UPDATE public.table_seats s SET left_at=now()
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id
       AND s.user_id=p_user_id AND s.left_at IS NULL
    RETURNING s.table_id
  ) SELECT COALESCE(array_agg(DISTINCT table_id),ARRAY[]::uuid[])
      INTO v_released_tables FROM released;

  DELETE FROM smarter_private.f06_elimination_dispatch
   WHERE xid=txid_current() AND candidate_id=v_resolved_candidate_id
     AND relation_name='table_seats';
  UPDATE public.tables tb SET current_players=(
    SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL)
   WHERE tb.id=ANY(v_released_tables);
  PERFORM public.fn_sync_seat_first_player_count(p_tournament_id);

  RETURN jsonb_build_object('ok',true,'claimed',true,'position',p_position,
                            'prize',round(p_prize,2),'bubble_refund',0);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric) FROM PUBLIC,anon,authenticated,service_role;
DO $postimage$ DECLARE a jsonb; BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)') AND md5(pg_get_functiondef(oid))='5086f465475086bb869b31ed78ea96f2' AND pg_get_userbyid(proowner)='postgres') THEN RAISE EXCEPTION 'F06_ELIMINATION_POSTIMAGE_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF; SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,x.privilege_type) INTO a FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.oid='public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'::regprocedure; IF a IS DISTINCT FROM '[{"role": "postgres", "grantor": "postgres", "grantable": false, "privilege": "EXECUTE"}]'::jsonb THEN RAISE EXCEPTION 'F06_ELIMINATION_ACL_DRIFT: %','public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric)'; END IF; END $postimage$;
COMMIT;
