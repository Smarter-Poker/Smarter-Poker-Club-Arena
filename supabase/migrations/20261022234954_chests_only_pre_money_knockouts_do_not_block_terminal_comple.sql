-- 20261022234954_chests_only_pre_money_knockouts_do_not_block_terminal_comple.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- Chests-only mystery events intentionally create no pre-money bounty debt.
-- The prior completion reader refused every such accepted knockout as unpaid,
-- stranding three decided events with 533 legitimate pre-activation busts.
-- Exempt only resolved generations whose exact accepted hand precedes the
-- immutable activation receipt. Every other missing obligation still refuses.
-- This replaces one read-only helper; it pays nobody and rewrites no record.
-- @live-proof: (SELECT md5(prosrc) = '3141d9ce658bee2ea74ae95cbeb96ff1' FROM pg_proc WHERE oid='public.fn_bounty_candidate_completion_status_v1(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
DO $preflight$
DECLARE f record;
BEGIN
 SELECT p.*,pg_get_userbyid(proowner) owner INTO f FROM pg_proc p
 WHERE oid='public.fn_bounty_candidate_completion_status_v1(uuid)'::regprocedure;
 IF md5(f.prosrc) NOT IN ('a75843500f5fc5f21ccb49f75388e4d6','3141d9ce658bee2ea74ae95cbeb96ff1')
    OR f.owner<>'postgres' OR f.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
    OR f.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
    OR NOT f.prosecdef OR f.provolatile<>'s' THEN
  RAISE EXCEPTION 'Chests-only terminal coverage source or authority changed';
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_pko_candidate_accepted_scope_v1(uuid,uuid)'::regprocedure)
      IS DISTINCT FROM '34c837517891f25a801a6ec1f7f6b511' THEN
  RAISE EXCEPTION 'Chests-only accepted-hand proof dependency changed';
 END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.fn_bounty_candidate_completion_status_v1(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tournaments%ROWTYPE;
  c public.tournament_knockout_candidates%ROWTYPE;
  accepted jsonb; claimants jsonb; identity jsonb;
  activated_at timestamptz;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;
  IF NOT (coalesce(t.is_bounty,false) OR coalesce(t.is_pko,false)
          OR coalesce(t.is_mystery_bounty,false)) THEN
    RETURN jsonb_build_object('ok',true,'reason','not_a_bounty_tournament');
  END IF;
  -- Visit every uncovered generation; return the first non-exempt refusal.
  -- Success covers the entire event. Workflow labels and current heads
  -- alone prove neither payment nor a pre-activation exemption.
  FOR c IN
  SELECT candidate.* FROM public.tournament_knockout_candidates candidate
   WHERE candidate.tournament_id=p_tournament_id
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_bounty_obligations obligation
        WHERE obligation.tournament_id=candidate.tournament_id
          AND obligation.eliminated_user_id=candidate.eliminated_user_id
          AND obligation.table_id=candidate.table_id
          AND obligation.hand_id=candidate.hand_id
          AND obligation.hand_number=candidate.hand_number
          AND obligation.seat_joined_at=candidate.seat_joined_at)
   ORDER BY candidate.hand_number,candidate.eliminated_user_id,candidate.id
  LOOP
    identity:=jsonb_build_object('candidate_id',c.id,'tournament_id',c.tournament_id,
      'eliminated_user_id',c.eliminated_user_id,'table_id',c.table_id,
      'hand_id',c.hand_id,'hand_number',c.hand_number,'seat_joined_at',c.seat_joined_at);
    accepted:=public.fn_pko_candidate_accepted_scope_v1(p_tournament_id,c.id);
    IF accepted->>'ok' IS DISTINCT FROM 'true' THEN
      RETURN identity||jsonb_build_object('ok',false,
        'reason','bounty_candidate_evidence_unknown','evidence',accepted);
    END IF;
    -- Chests-only terms create no head liability before the money. Prove
    -- the exact accepted hand precedes the sealed activation generation; the
    -- current stage and a resolved workflow label alone never establish that.
    IF coalesce(t.is_mystery_bounty,false)
       AND NOT coalesce(t.is_pko,false)
       AND t.mystery_bounty_regular_pool_percent=0
       AND t.mystery_bounty_activation_generation>0
       AND c.state IN ('eliminated','rebought','winner')
       AND c.resolved_at IS NOT NULL THEN
      SELECT receipt.activated_at INTO activated_at
        FROM public.tournament_mystery_activation_receipts receipt
       WHERE receipt.tournament_id=p_tournament_id
         AND receipt.activation_generation=t.mystery_bounty_activation_generation;
      IF activated_at IS NOT NULL
         AND (accepted->>'committed_at')::timestamptz < activated_at
         AND c.resolved_at >= (accepted->>'committed_at')::timestamptz THEN
        CONTINUE;
      END IF;
    END IF;
    BEGIN
      claimants:=public.fn_exact_tournament_knockout_claimants(
        p_tournament_id,c.hand_id,c.eliminated_user_id);
    EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation
                   OR numeric_value_out_of_range THEN
      RETURN identity||jsonb_build_object('ok',false,
        'reason','bounty_candidate_evidence_unknown','detail','claimant_evidence_malformed');
    END;
    IF jsonb_typeof(claimants) IS DISTINCT FROM 'array' THEN
      RETURN identity||jsonb_build_object('ok',false,
        'reason','bounty_candidate_evidence_unknown','detail','claimants_unproven');
    END IF;
    IF jsonb_array_length(claimants)=0 THEN
      RETURN identity||jsonb_build_object('ok',false,
        'reason','bounty_candidate_evidence_unknown','detail','claimants_unproven');
    END IF;
    RETURN identity||jsonb_build_object('ok',false,
      'reason','unclaimed_bounty_candidate','claimants',claimants);
  END LOOP;
  RETURN jsonb_build_object('ok',true,'reason','all_candidate_generations_recorded');
END;
$function$;
ALTER FUNCTION public.fn_bounty_candidate_completion_status_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_bounty_candidate_completion_status_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $postflight$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc
     WHERE oid='public.fn_bounty_candidate_completion_status_v1(uuid)'::regprocedure)
      IS DISTINCT FROM '3141d9ce658bee2ea74ae95cbeb96ff1' THEN
  RAISE EXCEPTION 'Chests-only terminal coverage postimage mismatch';
 END IF;
END $postflight$;
COMMIT;
