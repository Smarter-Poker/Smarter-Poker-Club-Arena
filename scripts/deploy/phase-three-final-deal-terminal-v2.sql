-- Approved Phase 3 final-deal v2 terminal contract. NOT APPLIED.
-- Writes immutable evidence only after the existing canonical cash payer has
-- proved every real obligation, wallet credit, payout and final standing.
-- Version 1 evidence and its original verifier retain their existing contract.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
-- BEGIN CANONICAL TERMINAL FINAL DEAL BATCH CONTRACT
-- Read-only source and schema prerequisites run before any relation DDL.
DO $final_deal_prerequisites$
DECLARE v_identity text; v_expected text; v_oid oid;
BEGIN
 FOR v_identity,v_expected IN SELECT * FROM (VALUES
  ('public.fn_ca_lock_settlement_lane_global()','343015440ea5c84ee4ca7ae583c73d30'),
  ('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)','3acb4c1d763181905cf5b64287f8f28f'),
  ('public.fn_ca_share_settlement_lane_for_table(uuid)','006d78a441e65d000d1d78929649bb44')
 ) expected(identity,body_md5)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(v_identity)
    AND md5(prosrc)=v_expected AND proowner='postgres'::regrole
    AND NOT prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN
   RAISE EXCEPTION 'canonical final deal current settlement lane differs: %',v_identity;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE
  oid='public.tournament_final_table_deal_batches'::regclass
  AND relowner='postgres'::regrole AND relrowsecurity)
  OR has_table_privilege('anon','public.tournament_final_table_deal_batches','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated','public.tournament_final_table_deal_batches','SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('service_role','public.tournament_final_table_deal_batches','INSERT,UPDATE,DELETE')
  OR NOT has_table_privilege('service_role','public.tournament_final_table_deal_batches','SELECT')
 THEN RAISE EXCEPTION 'canonical final deal batch ownership or access differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE
  conrelid='public.tournament_final_table_deal_batches'::regclass
  AND conname='tournament_final_table_deal_bubble_shape' AND convalidated
  AND md5(pg_get_constraintdef(oid)) IN ('951da39af2daadb80fa0cf6a73f86e82','e685ad4c6440decb7f57310d455c5bd0'))
 THEN RAISE EXCEPTION 'canonical final deal Bubble constraint source differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
  oid=to_regprocedure('public.fn_claim_tournament_finish(uuid,uuid,text)')
  AND md5(prosrc)='f311bf0c9982cb078e3ead104b61b310'
  AND proowner='postgres'::regrole AND prosecdef
  AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[])
  OR has_function_privilege('anon','public.fn_claim_tournament_finish(uuid,uuid,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_claim_tournament_finish(uuid,uuid,text)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_claim_tournament_finish(uuid,uuid,text)','EXECUTE')
 THEN RAISE EXCEPTION 'canonical final deal requires the exact real finish claim'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE
  oid=to_regprocedure('public.fn_tournament_finish_kind(uuid)')
  AND md5(prosrc)='1269d0dc07db2ff5fcc5182ea5606caa'
  AND proowner='postgres'::regrole AND prosecdef)
 THEN RAISE EXCEPTION 'canonical final deal finish classification differs'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE
  tgrelid='public.tournament_final_table_deal_batches'::regclass
  AND tgname='zzzz_freeze_canonical_final_deal_batch'
  AND (tgfoid IS DISTINCT FROM to_regprocedure('public.trg_freeze_canonical_final_deal_batch()')
   OR tgtype<>27 OR tgenabled<>'O' OR tgisinternal OR tgnargs<>0 OR tgqual IS NOT NULL))
 THEN RAISE EXCEPTION 'canonical final deal immutability trigger already has another contract'; END IF;
 FOR v_identity,v_expected IN SELECT * FROM (VALUES
  ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)','260c94b41d7f2bb021a88a546a1714ac'),
  ('public.trg_freeze_canonical_final_deal_batch()','80362aed787137219432f6039bf03158')
 ) expected(identity,body_md5)
 LOOP
  v_oid:=to_regprocedure(v_identity);
  IF v_oid IS NOT NULL AND (
   NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND md5(prosrc)=v_expected
    AND proowner='postgres'::regrole AND prosecdef
    AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
    aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=v_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner))
  THEN RAISE EXCEPTION 'canonical final deal helper already exists with another contract: %',v_identity; END IF;
 END LOOP;
END;
$final_deal_prerequisites$;

-- The expansion left the terminal implementation at the public name. Preserve
-- its OID and implementation, then place its genuine seat capability wrapper
-- at that public name. Existing callers must traverse the same tested wrapper.
DO $final_deal_terminal_seat_composition$
DECLARE
 v_public oid := 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
 v_private oid := to_regprocedure('public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)');
 v_src text; v_def text;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid) INTO v_src,v_def FROM pg_proc WHERE oid=v_public;
 IF md5(v_src) NOT IN ('f4275f9fa8cb2711f19ffdf7b16a04e6','96a61ea5e16560735bcb70b355aa79ab')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_public AND proowner='postgres'::regrole AND prosecdef)
    OR (v_private IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_private
       AND md5(prosrc)='f4275f9fa8cb2711f19ffdf7b16a04e6' AND prosecdef
       AND proowner='postgres'::regrole))
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=
       'public.fn_ca_open_tournament_seat_exit_authority(uuid,text,uuid)'::regprocedure
       AND md5(prosrc)='0f491a45693fcf3182719647c5ed7aee' AND prosecdef
       AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}')
 THEN RAISE EXCEPTION 'final deal terminal seat composition source differs'; END IF;
 IF v_private IS NULL THEN
  IF md5(v_src)<>'f4275f9fa8cb2711f19ffdf7b16a04e6' THEN
   RAISE EXCEPTION 'final deal terminal wrapper has no verified private implementation';
  END IF;
  EXECUTE replace(v_def,
    'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(',
    'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(');
 END IF;
 REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
 EXECUTE $terminal_wrapper$CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(
  p_tournament_id uuid,p_observed_winner_id uuid,p_settlement_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '45s'
AS $terminal_with_seat_authority$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$terminal_with_seat_authority$;$terminal_wrapper$;
 REVOKE ALL ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
 GRANT EXECUTE ON FUNCTION public.fn_complete_tournament_terminal(uuid,uuid,text) TO service_role;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_public
    AND md5(prosrc)='96a61ea5e16560735bcb70b355aa79ab'
    AND proconfig=ARRAY['search_path=public, pg_temp','statement_timeout=45s']::text[] AND prosecdef
    AND proacl::text='{postgres=X/postgres,service_role=X/postgres}')
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=
    'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure
    AND md5(prosrc)='f4275f9fa8cb2711f19ffdf7b16a04e6'
    AND proconfig=ARRAY['search_path=public','statement_timeout=45s']::text[]
    AND proowner='postgres'::regrole AND prosecdef AND proacl::text='{postgres=X/postgres}') THEN
  RAISE EXCEPTION 'final deal terminal seat composition postflight differs';
 END IF;
END;
$final_deal_terminal_seat_composition$;


ALTER TABLE public.tournament_final_table_deal_batches
 ADD COLUMN IF NOT EXISTS contract_version integer NOT NULL DEFAULT 1;
DO $final_deal_version$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d
  ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.tournament_final_table_deal_batches'::regclass
   AND a.attname='contract_version' AND a.atttypid='integer'::regtype
   AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='1') THEN
  RAISE EXCEPTION 'final deal version column differs';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE
  conrelid='public.tournament_final_table_deal_batches'::regclass
  AND conname='tournament_final_deal_contract_version') THEN
  ALTER TABLE public.tournament_final_table_deal_batches ADD CONSTRAINT
   tournament_final_deal_contract_version CHECK(contract_version IN (1,2));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE
  conrelid='public.tournament_final_table_deal_batches'::regclass
  AND conname='tournament_final_deal_contract_version' AND convalidated
  AND pg_get_constraintdef(oid)='CHECK ((contract_version = ANY (ARRAY[1, 2])))') THEN
  RAISE EXCEPTION 'final deal version constraint differs';
 END IF;
END;
$final_deal_version$;

-- The version 1 expression remains byte-for-byte equivalent, including its
-- historical NULL semantics. Only version 2 requires a non-NULL canonical source.
ALTER TABLE public.tournament_final_table_deal_batches
 DROP CONSTRAINT tournament_final_table_deal_bubble_shape;
ALTER TABLE public.tournament_final_table_deal_batches
 ADD CONSTRAINT tournament_final_table_deal_bubble_shape CHECK (
 (contract_version=1 AND (
  (bubble_contract_required AND bubble_obligation_id IS NOT NULL
   AND bubble_user_id IS NOT NULL
   AND bubble_source IN ('engine.eliminatePlayer','engine.atomicFinalTableDeal')
   AND bubble_amount_owed>0)
  OR (NOT bubble_contract_required AND bubble_obligation_id IS NULL
   AND bubble_user_id IS NULL AND bubble_source IS NULL
   AND bubble_amount_owed=0 AND bubble_amount_paid_before=0)))
 OR (contract_version=2 AND (
  (bubble_contract_required AND bubble_obligation_id IS NOT NULL
   AND bubble_user_id IS NOT NULL AND bubble_source IS NOT NULL
   AND bubble_source IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement',
    'engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   AND bubble_amount_owed>0)
  OR (NOT bubble_contract_required AND bubble_obligation_id IS NULL
   AND bubble_user_id IS NULL AND bubble_source IS NULL
   AND bubble_amount_owed=0 AND bubble_amount_paid_before=0))));

CREATE OR REPLACE FUNCTION public.fn_ca_verify_terminal_final_deal_batch(
 p_tournament_id uuid,p_require_terminal boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $verify_terminal_final_deal_batch$
DECLARE
 v_t public.tournaments%ROWTYPE;
 v_b public.tournament_final_table_deal_batches%ROWTYPE;
 v_e public.tournament_escrow%ROWTYPE;
 v_ob public.tournament_obligations%ROWTYPE;
 v_input jsonb; v_tail jsonb; v_ladder jsonb; v_expected jsonb;
 v_field integer; v_ladder_count integer; v_max_place integer;
 v_place_total numeric; v_deal_cents bigint; v_chips numeric;
 v_bubble numeric:=0; v_bubble_user uuid;
 v_line record; v_amount numeric; v_paid numeric; v_count integer;
 v_not_pool text[]:=ARRAY['satellite_seat','bounty','mystery_bounty',
  'bounty_residual','own_bounty','mystery_bounty_residual'];
BEGIN
 SELECT * INTO STRICT v_t FROM public.tournaments WHERE id=p_tournament_id;
 SELECT * INTO STRICT v_b FROM public.tournament_final_table_deal_batches
  WHERE tournament_id=p_tournament_id;
 IF v_b.contract_version<>2 OR v_b.settled_at IS NULL
  OR v_b.source IS DISTINCT FROM 'engine.fn_settle_tournament_final_table_deal'
  OR v_t.prize_pool_finalized IS DISTINCT FROM true
  OR v_t.prize_pool IS NULL OR v_t.prize_pool<=0
  OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
  OR v_t.prize_pool<>round(v_t.prize_pool,2)
  OR v_t.prize_pool<COALESCE(v_t.guaranteed_prize,0)
  OR lower(COALESCE(v_t.variant,''))='satellite'
  OR upper(COALESCE(v_t.tournament_type,''))='SATELLITE'
  OR v_t.satellite_target_id IS NOT NULL OR v_t.satellite_target IS NOT NULL
 THEN RAISE EXCEPTION 'canonical final deal is not a settled funded cash batch'; END IF;
 SELECT count(*) INTO v_field FROM public.tournament_players WHERE tournament_id=p_tournament_id;
 IF v_field<>v_b.field_count OR v_b.live_count>v_field
  OR v_b.live_count>v_t.table_size OR v_b.live_count<2
  OR (SELECT count(DISTINCT position) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id)<>v_field
  OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND status='winner' AND position=1 AND user_id=v_b.chip_leader
   AND eliminated_at IS NULL AND elimination_sequence IS NULL)<>1
  OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id
   AND (position IS NULL OR position<1 OR position>v_field
    OR status NOT IN ('winner','eliminated')
    OR (position>1 AND (status<>'eliminated' OR eliminated_at IS NULL
     OR elimination_sequence IS NULL OR elimination_sequence<=0))
    OR (status='winner' AND position<>1)))
  OR (SELECT count(DISTINCT elimination_sequence) FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND status='eliminated')<>v_field-1
  OR EXISTS(SELECT 1 FROM (SELECT position,
   row_number() OVER(ORDER BY elimination_sequence DESC,id)+1 expected
   FROM public.tournament_players WHERE tournament_id=p_tournament_id
    AND status='eliminated') q WHERE position<>expected)
 THEN RAISE EXCEPTION 'canonical final deal durable standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,
  'chips',tp.chips,'registered_at',extract(epoch FROM tp.registered_at))
  ORDER BY tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id),'[]'::jsonb),
  sum(tp.chips)
 INTO v_input,v_chips FROM public.tournament_players tp
 WHERE tp.tournament_id=p_tournament_id AND tp.position<=v_b.live_count;
 IF v_input IS DISTINCT FROM v_b.live_input_snapshot
  OR md5(v_input::text) IS DISTINCT FROM v_b.live_input_fingerprint
  OR jsonb_array_length(v_input)<>v_b.live_count OR v_chips IS NULL OR v_chips<=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_input) x
   WHERE x->>'chips' IS NULL OR (x->>'chips')::numeric<0
    OR x->>'chips' IN ('NaN','Infinity','-Infinity'))
  OR (v_input->0->>'user_id')::uuid IS DISTINCT FROM v_b.chip_leader
  OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=v_b.deal_table_id
    AND tournament_id=p_tournament_id)
 THEN RAISE EXCEPTION 'canonical final deal immutable input differs'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,
  'club_id',tp.club_id,'position',tp.position,'eliminated_at',extract(epoch FROM tp.eliminated_at),
  'elimination_sequence',tp.elimination_sequence) ORDER BY tp.position),'[]'::jsonb)
 INTO v_tail FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
  AND tp.position>v_b.live_count;
 IF md5(v_tail::text) IS DISTINCT FROM v_b.prior_standings_fingerprint
 THEN RAISE EXCEPTION 'canonical final deal prior standings differ'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('place',a.place,'amount',a.amount)
  ORDER BY a.place),'[]'::jsonb),count(*),max(a.place),
  COALESCE(sum(a.amount) FILTER(WHERE a.place>v_b.live_count),0)
 INTO v_ladder,v_ladder_count,v_max_place,v_place_total
 FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
 IF v_ladder_count=0 OR v_ladder_count<>v_b.structure_place_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_ladder) x
    WHERE (x->>'amount')::numeric<0
     OR (x->>'amount')::numeric<>round((x->>'amount')::numeric,2))
 THEN RAISE EXCEPTION 'canonical final deal structure differs'; END IF;
 IF v_t.bubble_protection AND v_max_place+1<=v_field AND v_max_place+1>v_b.live_count THEN
  v_bubble:=v_t.buy_in_amount;
  IF v_bubble IS NULL OR v_bubble<=0 OR v_bubble::text IN ('NaN','Infinity','-Infinity')
   OR v_bubble<>round(v_bubble,2) THEN RAISE EXCEPTION 'canonical final deal Bubble amount invalid'; END IF;
  SELECT user_id INTO STRICT v_bubble_user FROM public.tournament_players
   WHERE tournament_id=p_tournament_id AND position=v_max_place+1 AND status='eliminated';
 END IF;
 v_deal_cents:=round((v_t.prize_pool-v_place_total-v_bubble)*100)::bigint;
 IF v_deal_cents<=0 THEN RAISE EXCEPTION 'canonical final deal residual invalid'; END IF;
 WITH live AS (
  SELECT (x->>'user_id')::uuid user_id,(x->>'club_id')::uuid club_id,ord::integer place,
   floor((x->>'chips')::numeric*v_deal_cents/v_chips)::bigint cents
  FROM jsonb_array_elements(v_input) WITH ORDINALITY z(x,ord)
 ), all_lines AS (
  SELECT 'final_table_deal' kind,place,user_id,club_id,
   cents+CASE WHEN place=1 THEN v_deal_cents-(SELECT sum(cents) FROM live) ELSE 0 END cents
   FROM live
  UNION ALL
  SELECT 'place',(x->>'place')::integer,tp.user_id,tp.club_id,
   round((x->>'amount')::numeric*100)::bigint
  FROM jsonb_array_elements(v_ladder) x JOIN public.tournament_players tp
   ON tp.tournament_id=p_tournament_id AND tp.position=(x->>'place')::integer
  WHERE (x->>'place')::integer>v_b.live_count AND (x->>'amount')::numeric>0
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'place',place,
  'user_id',user_id,'club_id',club_id,'cents',cents) ORDER BY place),'[]'::jsonb)
 INTO v_expected FROM all_lines;
 IF v_b.plan IS DISTINCT FROM v_expected OR v_b.plan_fingerprint IS DISTINCT FROM md5(v_expected::text)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE (x->>'cents')::bigint<=0)
  OR v_b.place_amount IS DISTINCT FROM v_place_total
  OR v_b.deal_amount IS DISTINCT FROM v_deal_cents::numeric/100
  OR v_b.amount_owed IS DISTINCT FROM v_t.prize_pool-v_bubble
  OR v_b.deal_line_count<>v_b.live_count
  OR v_b.place_line_count<>jsonb_array_length(v_expected)-v_b.live_count
  OR v_b.escrow_prize_after IS DISTINCT FROM 0::numeric
  OR v_b.escrow_prize_before IS DISTINCT FROM v_b.amount_moved
  OR v_b.amount_moved<0 OR v_b.amount_moved>v_t.prize_pool
 THEN RAISE EXCEPTION 'canonical final deal plan or escrow proof differs'; END IF;
 FOR v_line IN SELECT (x->>'kind') kind,(x->>'place')::integer place,
  (x->>'user_id')::uuid user_id,(x->>'cents')::numeric/100 amount
  FROM jsonb_array_elements(v_expected) x
 LOOP
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations o WHERE
   o.tournament_id=p_tournament_id AND o.kind=v_line.kind
   AND (CASE WHEN v_line.kind='place' THEN o.place=v_line.place
    ELSE o.place IS NULL AND o.user_id=v_line.user_id END);
  IF v_ob.user_id IS DISTINCT FROM v_line.user_id OR v_ob.amount_owed IS DISTINCT FROM v_line.amount
   OR v_ob.amount_paid IS DISTINCT FROM v_line.amount OR v_ob.settled_at IS NULL
   OR (v_line.kind='final_table_deal' AND (v_ob.source IS DISTINCT FROM 'final_table_deal'
    OR v_ob.adjustment_id IS NOT NULL))
  THEN RAISE EXCEPTION 'canonical final deal obligation differs at place %',v_line.place; END IF;
  SELECT COALESCE(sum(p.amount),0),count(*) INTO v_paid,v_count FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND p.user_id=v_line.user_id
    AND (CASE WHEN v_line.kind='place' THEN p.position=v_line.place
      AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND p.source<>'final_table_deal'
     ELSE p.position IS NULL AND p.source='final_table_deal' END);
  IF v_paid IS DISTINCT FROM v_line.amount OR v_count<1
   OR (v_line.kind='final_table_deal' AND v_count<>1)
  THEN RAISE EXCEPTION 'canonical final deal payout differs at place %',v_line.place; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x
    WHERE o.kind=x->>'kind' AND o.user_id=(x->>'user_id')::uuid
     AND (CASE WHEN o.kind='place' THEN o.place=(x->>'place')::integer ELSE o.place IS NULL END)))
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted debt'; END IF;
 SELECT count(*) INTO v_count FROM public.tournament_obligations
  WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
 IF v_bubble>0 THEN
  SELECT * INTO STRICT v_ob FROM public.tournament_obligations
   WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  IF v_count<>1 OR v_ob.place IS NOT NULL OR v_ob.user_id IS DISTINCT FROM v_bubble_user
   OR v_ob.amount_owed IS DISTINCT FROM v_bubble OR v_ob.amount_paid IS DISTINCT FROM v_bubble
   OR v_ob.settled_at IS NULL OR v_ob.source IS NULL
   OR v_ob.source NOT IN ('engine.eliminatePlayer','engine.atomicPlaceSettlement',
    'engine.fn_settle_tournament_places','engine.fn_settle_tournament_bubble_protection')
   OR v_b.bubble_contract_required IS DISTINCT FROM true
   OR v_b.bubble_obligation_id IS DISTINCT FROM v_ob.id
   OR v_b.bubble_user_id IS DISTINCT FROM v_bubble_user
   OR v_b.bubble_source IS DISTINCT FROM v_ob.source
   OR v_b.bubble_amount_owed IS DISTINCT FROM v_bubble
   OR v_b.bubble_amount_paid_before<0 OR v_b.bubble_amount_paid_before>v_bubble
   OR (SELECT COALESCE(sum(amount),0) FROM public.tournament_payouts
    WHERE tournament_id=p_tournament_id AND source='bubble_protection') IS DISTINCT FROM v_bubble
  THEN RAISE EXCEPTION 'canonical final deal Bubble proof differs'; END IF;
 ELSIF v_count<>0 OR v_b.bubble_contract_required IS DISTINCT FROM false
  OR v_b.bubble_obligation_id IS NOT NULL OR v_b.bubble_user_id IS NOT NULL
  OR v_b.bubble_source IS NOT NULL OR v_b.bubble_amount_owed<>0 OR v_b.bubble_amount_paid_before<>0
 THEN RAISE EXCEPTION 'canonical final deal has uncontracted Bubble'; END IF;
 IF EXISTS(SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id=p_tournament_id
  AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)) AND
   (p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity')
    OR p.amount<>round(p.amount,2) OR p.idempotency_key IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.wallet_credit_idempotency k WHERE
     k.key=p.idempotency_key AND k.user_id=p.user_id AND k.amount=p.amount)
    OR NOT(
     (p.source='bubble_protection' AND p.position IS NULL AND p.user_id=v_bubble_user AND v_bubble>0)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_expected) x WHERE p.user_id=(x->>'user_id')::uuid
      AND CASE WHEN x->>'kind'='place' THEN p.position=(x->>'place')::integer
        AND p.source<>'final_table_deal' AND p.source<>'bubble_protection'
       ELSE p.position IS NULL AND p.source='final_table_deal' END))))
  OR (SELECT COALESCE(sum(p.amount),0) FROM public.tournament_payouts p
   WHERE p.tournament_id=p_tournament_id AND NOT(COALESCE(p.source,'')=ANY(v_not_pool)))
    IS DISTINCT FROM v_t.prize_pool
  OR EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id
   AND tp.prize IS DISTINCT FROM COALESCE((SELECT sum(p.amount) FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.user_id=tp.user_id
     AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))),0))
 THEN RAISE EXCEPTION 'canonical final deal wallet proof or cache differs'; END IF;
 -- Every obligation-scoped wallet credit must retain its exact payout witness.
 -- This also rejects an extra spent key hidden behind otherwise-correct totals.
 IF EXISTS(SELECT 1 FROM public.tournament_obligations o
  JOIN public.wallet_credit_idempotency k
   ON k.key LIKE 'tourney:'||p_tournament_id::text||':obl:'||o.id::text||':%'
  WHERE o.tournament_id=p_tournament_id AND o.kind IN ('place','final_table_deal','bubble_protection')
   AND NOT EXISTS(SELECT 1 FROM public.tournament_payouts p
    WHERE p.tournament_id=p_tournament_id AND p.idempotency_key=k.key
     AND p.user_id=k.user_id AND p.user_id=o.user_id AND p.amount=k.amount
     AND CASE WHEN o.kind='place' THEN p.position=o.place
       AND NOT(COALESCE(p.source,'')=ANY(v_not_pool))
       AND p.source NOT IN ('final_table_deal','bubble_protection')
      ELSE p.position IS NULL AND p.source=o.kind END))
 THEN RAISE EXCEPTION 'canonical final deal has an orphaned wallet credit'; END IF;
 SELECT * INTO STRICT v_e FROM public.tournament_escrow WHERE tournament_id=p_tournament_id;
 IF v_e.enforced IS DISTINCT FROM true OR v_e.prize_balance IS DISTINCT FROM 0::numeric
  OR (p_require_terminal AND (v_e.bounty_balance IS DISTINCT FROM 0::numeric
   OR v_e.fee_balance IS DISTINCT FROM 0::numeric OR v_e.closed_at IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
    WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
     AND f.winner_user_id=v_b.chip_leader)
   OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
    WHERE t.tournament_id=p_tournament_id AND (s.left_at IS NULL OR s.status IS DISTINCT FROM 'left'))))
 THEN RAISE EXCEPTION 'canonical final deal has open custody, seats or missing finish claim'; END IF;
 RETURN jsonb_build_object('ok',true,'contract_version',2,'plan_fingerprint',v_b.plan_fingerprint,
  'place_amount',v_place_total,'deal_amount',v_deal_cents::numeric/100,'bubble_amount',v_bubble,
  'chip_leader',v_b.chip_leader);
END;
$verify_terminal_final_deal_batch$;
REVOKE ALL ON FUNCTION public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
-- The same exact private cash leaves are installed atomically with the writer.
DO $contract_cash_batch_payers$
DECLARE
  v_row record;
  v_source text;
  v_definition text;
  v_old CONSTANT text := 'public.fn_settle_tournament_obligation(';
  v_new CONSTANT text := 'public.fn_settle_tournament_obligation_before_atomic_batch_gate(';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(
       'public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)')
       AND md5(p.prosrc)='ebabbaf0456d80335aaa2e04471d0ab6'
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[]
  ) THEN
    RAISE EXCEPTION 'Stage-B cash contraction requires the exact private obligation core';
  END IF;

  FOR v_row IN SELECT * FROM (VALUES
    ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)',
     '329237bd65214e17d4ca3298f363f248', '3585ddbfdb0a197243d5e6eefb6b670f'),
    ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)',
     '3a5a0f079b7884a5bd2e6bfe6a15ccb7', 'f1fc7a0bf480b1034f0f1d9cba3b4d0b'),
    ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)',
     '58e2768644b692f23a9a071a8a5d1ee8', '852e35483b67c1fc59b6347b51c79cb8')
  ) expected(identity, before_md5, after_md5)
  LOOP
    SELECT p.prosrc, pg_get_functiondef(p.oid)
      INTO v_source, v_definition
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
     WHERE p.oid=to_regprocedure(v_row.identity)
       AND md5(p.prosrc) IN (v_row.before_md5,v_row.after_md5)
       AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
       AND l.lanname='plpgsql'
       AND p.proconfig=ARRAY['search_path=public']::text[];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stage-B cash payer source differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.before_md5 AND (
       (length(v_source)-length(replace(v_source,v_old,''))) IS DISTINCT FROM length(v_old)
       OR position(v_new IN v_source)>0) THEN
      RAISE EXCEPTION 'Stage-B cash payer preimage differs: %',v_row.identity;
    END IF;
    IF md5(v_source)=v_row.after_md5 AND (
       position(v_old IN v_source)>0
       OR (length(v_source)-length(replace(v_source,v_new,''))) IS DISTINCT FROM length(v_new)) THEN
      RAISE EXCEPTION 'Stage-B cash payer postimage differs: %',v_row.identity;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer is not owner-only: %',v_row.identity;
    END IF;

    IF md5(v_source)=v_row.before_md5 THEN
      EXECUTE replace(v_definition,v_old,v_new);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND md5(p.prosrc)=v_row.after_md5
         AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
         AND l.lanname='plpgsql'
         AND p.proconfig=ARRAY['search_path=public']::text[]
         AND position(v_old IN p.prosrc)=0
         AND (length(p.prosrc)-length(replace(p.prosrc,v_new,'')))=length(v_new)
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(
        COALESCE(p.proacl,acldefault('f',p.proowner))) privilege
       WHERE p.oid=to_regprocedure(v_row.identity)
         AND privilege.privilege_type='EXECUTE'
         AND privilege.grantee<>p.proowner
    ) OR has_function_privilege('anon',v_row.identity,'EXECUTE')
      OR has_function_privilege('authenticated',v_row.identity,'EXECUTE')
      OR has_function_privilege('service_role',v_row.identity,'EXECUTE') THEN
      RAISE EXCEPTION 'Stage-B cash payer postcondition differs: %',v_row.identity;
    END IF;
  END LOOP;
END;
$contract_cash_batch_payers$;

DO $canonical_final_deal_writer$
DECLARE v_oid oid; v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.fn_settle_tournament_final_table_deal(uuid)');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  AND proconfig=ARRAY['search_path=public','statement_timeout=30s']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical_final_deal_writer metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('141c723b5225bcec588b8957cf039184','b1941b2e55dade307ecd74068ab3e500') THEN
  RAISE EXCEPTION 'canonical_final_deal_writer prerequisite source differs'; END IF;
 IF md5(v_source)='141c723b5225bcec588b8957cf039184' THEN
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_0$  v_not_pool text[] := ARRAY[$canonical_final_deal_writer_old_0$,'')))<>length($canonical_final_deal_writer_old_0$  v_not_pool text[] := ARRAY[$canonical_final_deal_writer_old_0$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 0 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_0$  v_not_pool text[] := ARRAY[$canonical_final_deal_writer_old_0$,$canonical_final_deal_writer_new_0$  v_modern_batch public.tournament_final_table_deal_batches%ROWTYPE;
  v_modern_input jsonb;
  v_modern_tail jsonb;
  v_modern_plan jsonb;
  v_modern_table uuid;
  v_modern_escrow_before numeric;
  v_modern_required numeric;
  v_modern_claim jsonb;
  v_not_pool text[] := ARRAY[$canonical_final_deal_writer_new_0$);
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_1$  -- The chop and any guarantee overlay are one commit.$canonical_final_deal_writer_old_1$,'')))<>length($canonical_final_deal_writer_old_1$  -- The chop and any guarantee overlay are one commit.$canonical_final_deal_writer_old_1$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 1 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_1$  -- The chop and any guarantee overlay are one commit.$canonical_final_deal_writer_old_1$,$canonical_final_deal_writer_new_1$  -- Replay a certified v2 batch without changing even transient money/cache state.
  SELECT * INTO v_modern_batch FROM public.tournament_final_table_deal_batches
   WHERE tournament_id=p_tournament_id FOR UPDATE;
  IF FOUND AND v_modern_batch.contract_version=2 THEN
    IF v_status NOT IN ('COMPLETING','COMPLETED') THEN
      RAISE EXCEPTION 'canonical final deal batch has no claimed lifecycle';
    END IF;
    PERFORM public.fn_ca_verify_terminal_final_deal_batch(
      p_tournament_id,v_status='COMPLETED');
    IF NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
      WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
       AND f.winner_user_id=v_modern_batch.chip_leader
       AND (v_status<>'COMPLETED' OR f.certified_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'canonical final deal replay has no matching finish receipt';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('place',(x->>'place')::integer,
      'user_id',(x->>'user_id')::uuid,'amount',(x->>'cents')::numeric/100)
      ORDER BY (x->>'place')::integer),
      max((x->>'cents')::numeric/100) FILTER(WHERE (x->>'place')::integer=1)
      INTO v_payouts,v_winner_amount FROM jsonb_array_elements(v_modern_batch.plan) x
      WHERE x->>'kind'='final_table_deal';
    RETURN jsonb_build_object('ok',true,'fully_settled',true,'status',v_status,
      'payouts',v_payouts,'winner_amount',v_winner_amount,
      'money_path','fn_settle_tournament_final_table_deal');
  ELSIF FOUND AND v_status='RUNNING' THEN
    RAISE EXCEPTION 'prepared historical deal requires its original authority';
  END IF;

  -- The chop and any guarantee overlay are one commit.$canonical_final_deal_writer_new_1$);
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_2$  -- Price in integer cents. Each proportional share is floored; the exact$canonical_final_deal_writer_old_2$,'')))<>length($canonical_final_deal_writer_old_2$  -- Price in integer cents. Each proportional share is floored; the exact$canonical_final_deal_writer_old_2$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 2 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_2$  -- Price in integer cents. Each proportional share is floored; the exact$canonical_final_deal_writer_old_2$,$canonical_final_deal_writer_new_2$  -- Snapshot only real locked roster input, after canonical tail normalization.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',tp.user_id,'club_id',tp.club_id,
    'chips',tp.chips,'registered_at',extract(epoch FROM tp.registered_at))
    ORDER BY tp.chips DESC,tp.registered_at ASC NULLS LAST,tp.user_id),'[]'::jsonb)
    INTO v_modern_input FROM public.tournament_players tp
    WHERE tp.tournament_id=p_tournament_id AND tp.status='playing' AND tp.eliminated_at IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',tp.id,'user_id',tp.user_id,
    'club_id',tp.club_id,'position',tp.position,'eliminated_at',extract(epoch FROM tp.eliminated_at),
    'elimination_sequence',tp.elimination_sequence) ORDER BY tp.position),'[]'::jsonb)
    INTO v_modern_tail FROM public.tournament_players tp
    WHERE tp.tournament_id=p_tournament_id AND tp.position>v_live_count;
  SELECT DISTINCT s.table_id INTO STRICT v_modern_table
    FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
    WHERE tb.tournament_id=p_tournament_id AND lower(tb.status::text) IN ('running','waiting')
      AND s.left_at IS NULL AND s.user_id IS NOT NULL;

  -- Price in integer cents. Each proportional share is floored; the exact$canonical_final_deal_writer_new_2$);
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_3$  -- The complete positive obligation set now exists and is locked. Settle an$canonical_final_deal_writer_old_3$,'')))<>length($canonical_final_deal_writer_old_3$  -- The complete positive obligation set now exists and is locked. Settle an$canonical_final_deal_writer_old_3$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 3 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_3$  -- The complete positive obligation set now exists and is locked. Settle an$canonical_final_deal_writer_old_3$,$canonical_final_deal_writer_new_3$  SELECT e.prize_balance INTO STRICT v_modern_escrow_before
    FROM public.tournament_escrow e WHERE e.tournament_id=p_tournament_id AND e.enforced FOR UPDATE;
  v_modern_required:=(v_fixed_shortfall_cents+v_bubble_shortfall_cents+v_undistributed_cents)::numeric/100;
  IF v_modern_required<0 OR v_modern_escrow_before IS DISTINCT FROM v_modern_required THEN
    RAISE EXCEPTION 'canonical final deal lacks exact pre-credit custody';
  END IF;

  -- The complete positive obligation set now exists and is locked. Settle an$canonical_final_deal_writer_new_3$);
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_4$  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = v_now
   WHERE id = p_tournament_id AND upper(status::text) = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its RUNNING deal claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
  v_status := 'COMPLETING';$canonical_final_deal_writer_old_4$,'')))<>length($canonical_final_deal_writer_old_4$  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = v_now
   WHERE id = p_tournament_id AND upper(status::text) = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its RUNNING deal claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
  v_status := 'COMPLETING';$canonical_final_deal_writer_old_4$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 4 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_4$  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = v_now
   WHERE id = p_tournament_id AND upper(status::text) = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its RUNNING deal claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
  v_status := 'COMPLETING';$canonical_final_deal_writer_old_4$,$canonical_final_deal_writer_new_4$  -- Keep RUNNING until every canonical payment and standing is proved below.
  -- Only fn_claim_tournament_finish may claim the lifecycle transition.$canonical_final_deal_writer_new_4$);
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_writer_old_5$  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;$canonical_final_deal_writer_old_5$,'')))<>length($canonical_final_deal_writer_old_5$  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;$canonical_final_deal_writer_old_5$) THEN
   RAISE EXCEPTION 'canonical_final_deal_writer exact fragment 5 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_writer_old_5$  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;$canonical_final_deal_writer_old_5$,$canonical_final_deal_writer_new_5$  -- Publish the immutable v2 header only after all original canonical proofs.
  SELECT jsonb_agg(jsonb_build_object('kind',q.kind,'place',q.place,
    'user_id',q.user_id,'club_id',tp.club_id,'cents',q.cents) ORDER BY q.place)
    INTO v_modern_plan FROM (
      SELECT 'place' kind,(x->>'place')::integer place,(x->>'user_id')::uuid user_id,
        round((x->>'amount')::numeric*100)::bigint cents FROM jsonb_array_elements(v_fixed) x
      UNION ALL
      SELECT 'final_table_deal',(x->>'place')::integer,(x->>'user_id')::uuid,
        (x->>'cents')::bigint FROM jsonb_array_elements(v_shares) x
    ) q JOIN public.tournament_players tp
      ON tp.tournament_id=p_tournament_id AND tp.user_id=q.user_id;
  IF v_has_bubble THEN
    SELECT * INTO STRICT v_ob FROM public.tournament_obligations
     WHERE tournament_id=p_tournament_id AND kind='bubble_protection';
  END IF;
  IF (SELECT prize_balance FROM public.tournament_escrow WHERE tournament_id=p_tournament_id)
      IS DISTINCT FROM v_modern_escrow_before-v_modern_required THEN
    RAISE EXCEPTION 'canonical final deal lost exact custody delta';
  END IF;
  INSERT INTO public.tournament_final_table_deal_batches(
    tournament_id,plan_fingerprint,plan,prior_standings_fingerprint,
    live_input_snapshot,live_input_fingerprint,field_count,live_count,
    structure_place_count,place_line_count,deal_line_count,place_amount,deal_amount,
    amount_owed,bubble_contract_required,bubble_obligation_id,bubble_user_id,bubble_source,
    bubble_amount_owed,bubble_amount_paid_before,amount_moved,
    escrow_prize_before,escrow_prize_after,deal_table_id,chip_leader,source,settled_at,contract_version)
  VALUES(p_tournament_id,md5(v_modern_plan::text),v_modern_plan,md5(v_modern_tail::text),
    v_modern_input,md5(v_modern_input::text),v_field_size,v_live_count,
    jsonb_array_length(v_ladder),v_fixed_count,v_live_count,v_fixed_entitlement_cents::numeric/100,
    v_undistributed_cents::numeric/100,
    (v_fixed_entitlement_cents+v_undistributed_cents)::numeric/100,v_has_bubble,
    CASE WHEN v_has_bubble THEN v_ob.id ELSE NULL END,
    CASE WHEN v_has_bubble THEN v_bubble_user_id ELSE NULL END,
    CASE WHEN v_has_bubble THEN v_ob.source ELSE NULL END,
    v_bubble_amount,v_bubble_paid_cents::numeric/100,v_modern_required,
    v_modern_escrow_before,0,v_modern_table,v_leader,
    'engine.fn_settle_tournament_final_table_deal',transaction_timestamp(),2);
  PERFORM public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,false);
  v_modern_claim:=public.fn_claim_tournament_finish(
    p_tournament_id,v_leader,'engine.fn_settle_tournament_final_table_deal');
  IF COALESCE((v_modern_claim->>'ok')::boolean,false) IS NOT TRUE
    OR v_modern_claim->>'finish_kind' IS DISTINCT FROM 'final_table_deal'
    OR (v_modern_claim->>'winner_user_id')::uuid IS DISTINCT FROM v_leader
    OR v_modern_claim->>'status' IS DISTINCT FROM 'COMPLETING'
    OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND status='COMPLETING')
    OR NOT EXISTS(SELECT 1 FROM public.tournament_finish_receipts f
      WHERE f.tournament_id=p_tournament_id AND f.finish_kind='final_table_deal'
       AND f.winner_user_id=v_leader) THEN
    RAISE EXCEPTION 'canonical final deal finish claim refused: %',v_modern_claim;
  END IF;
  v_status:='COMPLETING';
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;$canonical_final_deal_writer_new_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'b1941b2e55dade307ecd74068ab3e500' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical_final_deal_writer source or metadata postcondition differs'; END IF;
END;
$canonical_final_deal_writer$;
DO $canonical_final_deal_completion$
DECLARE v_oid oid; v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.trg_atomic_final_table_deal_completion_guard()');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  AND proconfig=ARRAY['search_path=public']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical_final_deal_completion metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('e06ea880dfb7c1efe77daddc51a893b9','9f5f5fefa77ae93bfeffc9f414a63a0d') THEN
  RAISE EXCEPTION 'canonical_final_deal_completion prerequisite source differs'; END IF;
 IF md5(v_source)='e06ea880dfb7c1efe77daddc51a893b9' THEN
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_completion_old_0$  v_check := public.fn_check_atomic_final_table_deal(NEW.id);$canonical_final_deal_completion_old_0$,'')))<>length($canonical_final_deal_completion_old_0$  v_check := public.fn_check_atomic_final_table_deal(NEW.id);$canonical_final_deal_completion_old_0$) THEN
   RAISE EXCEPTION 'canonical_final_deal_completion exact fragment 0 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_completion_old_0$  v_check := public.fn_check_atomic_final_table_deal(NEW.id);$canonical_final_deal_completion_old_0$,$canonical_final_deal_completion_new_0$  IF EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b
    WHERE b.tournament_id=NEW.id AND b.contract_version=2) THEN
    v_check:=public.fn_ca_verify_terminal_final_deal_batch(NEW.id,true);
  ELSE
    v_check := public.fn_check_atomic_final_table_deal(NEW.id);
  END IF;$canonical_final_deal_completion_new_0$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'9f5f5fefa77ae93bfeffc9f414a63a0d' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical_final_deal_completion source or metadata postcondition differs'; END IF;
END;
$canonical_final_deal_completion$;
DO $canonical_final_deal_marker$
DECLARE v_oid oid; v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 v_oid:=to_regprocedure('public.trg_freeze_atomic_final_table_deal_obligation()');
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  AND proconfig=ARRAY['search_path=public']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'canonical_final_deal_marker metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('56a96a897002da48ccd79c9dde14eb59','d338c5278ef1247ff0f4a7c4ba774cc5') THEN
  RAISE EXCEPTION 'canonical_final_deal_marker prerequisite source differs'; END IF;
 IF md5(v_source)='56a96a897002da48ccd79c9dde14eb59' THEN
  IF (length(v_definition)-length(replace(v_definition,$canonical_final_deal_marker_old_0$  IF v_gate <> OLD.tournament_id::text THEN$canonical_final_deal_marker_old_0$,'')))<>length($canonical_final_deal_marker_old_0$  IF v_gate <> OLD.tournament_id::text THEN$canonical_final_deal_marker_old_0$) THEN
   RAISE EXCEPTION 'canonical_final_deal_marker exact fragment 0 differs'; END IF;
  v_definition:=replace(v_definition,$canonical_final_deal_marker_old_0$  IF v_gate <> OLD.tournament_id::text THEN$canonical_final_deal_marker_old_0$,$canonical_final_deal_marker_new_0$  -- Only the exact lifecycle marker may change after canonical v2 completion.
  IF OLD.terminal_closed_at IS NULL AND NEW.terminal_closed_at IS NOT NULL
    AND isfinite(NEW.terminal_closed_at)
    AND (to_jsonb(NEW)-'terminal_closed_at') IS NOT DISTINCT FROM
        (to_jsonb(OLD)-'terminal_closed_at')
    AND EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b
      WHERE b.tournament_id=OLD.tournament_id AND b.contract_version=2 AND b.settled_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM public.tournaments t
      WHERE t.id=OLD.tournament_id AND upper(t.status::text)='COMPLETED'
       AND t.ended_at IS NOT DISTINCT FROM NEW.terminal_closed_at) THEN
    PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.tournament_id,true);
    RETURN NEW;
  END IF;
  IF v_gate <> OLD.tournament_id::text THEN$canonical_final_deal_marker_new_0$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'d338c5278ef1247ff0f4a7c4ba774cc5' OR v_before IS DISTINCT FROM v_after THEN
  RAISE EXCEPTION 'canonical_final_deal_marker source or metadata postcondition differs'; END IF;
END;
$canonical_final_deal_marker$;

CREATE OR REPLACE FUNCTION public.trg_freeze_canonical_final_deal_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $freeze_canonical_final_deal_batch$
BEGIN
 IF OLD.contract_version=2
  OR (TG_OP='UPDATE' AND NEW.contract_version=2) THEN
  RAISE EXCEPTION 'canonical final deal batch is immutable' USING ERRCODE='23514';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$freeze_canonical_final_deal_batch$;
REVOKE ALL ON FUNCTION public.trg_freeze_canonical_final_deal_batch()
 FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zzzz_freeze_canonical_final_deal_batch
 ON public.tournament_final_table_deal_batches;
CREATE TRIGGER zzzz_freeze_canonical_final_deal_batch
 BEFORE UPDATE OR DELETE ON public.tournament_final_table_deal_batches
 FOR EACH ROW EXECUTE FUNCTION public.trg_freeze_canonical_final_deal_batch();

-- BEGIN CANONICAL TERMINAL READINESS DISPATCH
-- Only the versioned format proof changes. Shared finish claim, winner,
-- obligation, custody, rake, bounty and mystery certification remain intact.
DO $contract_terminal_batch_readiness$
DECLARE v_oid oid:='public.fn_tournament_finish_readiness(uuid,uuid)'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
  AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
  OR has_function_privilege('anon',v_oid,'EXECUTE')
  OR has_function_privilege('authenticated',v_oid,'EXECUTE')
  OR has_function_privilege('service_role',v_oid,'EXECUTE') THEN
  RAISE EXCEPTION 'terminal readiness owner-only metadata differs';
 END IF;
 SELECT prosrc,pg_get_functiondef(oid),
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('ac4a33b4428ca68fb385b7de764a8590','993e6e1de9edba2fe235d86ff6c243c9') THEN RAISE EXCEPTION 'terminal readiness source differs'; END IF;
 IF md5(v_source)='ac4a33b4428ca68fb385b7de764a8590' THEN
  IF position($readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 0 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_0$  v_bad_satellite_seats integer := 0;$readiness_old_0$,$readiness_new_0$  v_modern_place boolean := false;
  v_modern_deal boolean := false;
  v_bad_satellite_seats integer := 0;$readiness_new_0$);
  IF position($readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 1 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);$readiness_old_1$,$readiness_new_1$  v_kind := public.fn_tournament_finish_kind(p_tournament_id);
  IF v_kind='normal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_place FROM public.tournament_place_settlement_batches b
     WHERE b.tournament_id=p_tournament_id;
  ELSIF v_kind='final_table_deal' THEN
    SELECT COALESCE((to_jsonb(b)->>'contract_version')::integer,1)=2
      INTO v_modern_deal FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=p_tournament_id;
  END IF;
  v_modern_place:=COALESCE(v_modern_place,false);
  v_modern_deal:=COALESCE(v_modern_deal,false);
$readiness_new_1$);
  IF position($readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 2 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_2$  IF v_kind <> 'satellite' THEN$readiness_old_2$,$readiness_new_2$  IF v_kind <> 'satellite' AND NOT v_modern_place AND NOT v_modern_deal THEN$readiness_new_2$);
  IF position($readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 3 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_3$    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_old_3$,$readiness_new_3$    IF v_modern_place THEN
      BEGIN
        v_domain_check:=public.fn_ca_verify_terminal_place_batch(p_tournament_id,true);
        IF COALESCE((v_domain_check->>'ok')::boolean,false) IS NOT TRUE THEN
          RAISE EXCEPTION 'canonical place proof refused';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_failures:=v_failures||jsonb_build_array(jsonb_build_object(
          'code','canonical_place_batch_not_proven','detail',SQLERRM));
      END;
    END IF;

    SELECT round(COALESCE(sum(o.amount_owed),0),2) INTO v_place_owed$readiness_new_3$);
  IF position($readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 4 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_4$    IF abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_old_4$,$readiness_new_4$    IF NOT v_modern_place AND abs(v_place_owed - round(COALESCE(v_t.prize_pool,0),2)) > 0.005 THEN$readiness_new_4$);
  IF position($readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$ IN v_definition)=0 THEN RAISE EXCEPTION 'readiness fragment 5 absent'; END IF;
  v_definition:=replace(v_definition,$readiness_old_5$      v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);$readiness_old_5$,$readiness_new_5$      IF v_modern_deal THEN
        BEGIN
          v_domain_check:=public.fn_ca_verify_terminal_final_deal_batch(p_tournament_id,true);
        EXCEPTION WHEN OTHERS THEN
          v_domain_check:=jsonb_build_object('ok',false,'reason',SQLERRM);
        END;
      ELSE
        v_domain_check := public.fn_check_atomic_final_table_deal(p_tournament_id);
      END IF;$readiness_new_5$);
  EXECUTE v_definition;
 END IF;
 SELECT prosrc,
  jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,
    'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'993e6e1de9edba2fe235d86ff6c243c9' OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'readiness source or metadata postcondition differs'; END IF;
END;
$contract_terminal_batch_readiness$;
-- END CANONICAL TERMINAL READINESS DISPATCH


-- Version 2 requires the real immutable finish receipt and RPC claim owner.
-- The version 1 branch retains its existing historical contract.
DO $canonical_final_deal_claim_guard$
DECLARE v_oid oid:='public.fn_guard_tournament_completing_claim()'::regprocedure;
 v_source text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,
  'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('619bf63e5c77c29400de480a882b9322','82078938fd926c94a0ab778acd77dd61')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[])
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
   aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=v_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner)
 THEN RAISE EXCEPTION 'canonical final deal claim guard prerequisite differs'; END IF;
 IF md5(v_source)='619bf63e5c77c29400de480a882b9322' THEN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completing_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''public'',''pg_temp''
AS $function$
DECLARE
  v_kind text;
  v_finish public.tournament_finish_receipts%ROWTYPE;
BEGIN
  IF NEW.status = ''COMPLETING'' AND OLD.status IS DISTINCT FROM ''COMPLETING'' THEN
    IF OLD.status IS DISTINCT FROM ''RUNNING'' THEN
      RAISE EXCEPTION ''tournament % cannot claim completion from status %'',
        NEW.id, OLD.status USING ERRCODE = ''check_violation'';
    END IF;

    v_kind := public.fn_tournament_finish_kind(NEW.id);
    IF v_kind = ''final_table_deal'' AND NOT EXISTS (
      SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id=NEW.id AND b.contract_version=2
    ) THEN
      IF current_setting(''app.atomic_final_table_deal_batch'', true)
           IS DISTINCT FROM NEW.id::text THEN
        RAISE EXCEPTION ''final-table-deal tournament % has no atomic claim owner'', NEW.id
          USING ERRCODE = ''check_violation'';
      END IF;
      RETURN NEW;
    END IF;

    IF v_kind = ''final_table_deal'' THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(NEW.id,false);
    END IF;

    SELECT * INTO v_finish
      FROM public.tournament_finish_receipts f
     WHERE f.tournament_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION ''tournament % cannot enter COMPLETING without an immutable finish claim'',
        NEW.id USING ERRCODE = ''check_violation'';
    END IF;
    IF v_finish.finish_kind IS DISTINCT FROM v_kind THEN
      RAISE EXCEPTION ''tournament % COMPLETING claim has format conflict'', NEW.id
        USING ERRCODE = ''check_violation'';
    END IF;
    IF current_setting(''app.tournament_finish_claim'', true)
         IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION ''tournament % COMPLETING claim has no RPC owner'', NEW.id
        USING ERRCODE = ''check_violation'';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;';
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,
  'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'82078938fd926c94a0ab778acd77dd61' OR v_after IS DISTINCT FROM v_before
 THEN RAISE EXCEPTION 'canonical final deal claim guard postcondition differs'; END IF;
END;
$canonical_final_deal_claim_guard$;


-- Preserve the historical contract; v2 consumes a verified real finish claim.
DO $v2_fn_guard_tournament_completed_certificate$
DECLARE v_oid oid:='public.fn_guard_tournament_completed_certificate()'::regprocedure; v_src text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype) INTO v_src,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_src) NOT IN ('da8c67492e012821628468ec119307de','d994347e1b76c936ce13361d73f94fd2') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp']::text[]) OR has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM false OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=v_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner) THEN RAISE EXCEPTION 'v2 fn_guard_tournament_completed_certificate prerequisite differs'; END IF;
 IF md5(v_src)='da8c67492e012821628468ec119307de' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completed_certificate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''public'',''pg_temp''
AS $function$
DECLARE
  v_winner uuid;
  v_kind text;
  v_ready jsonb;
  v_existing public.tournament_finish_receipts%ROWTYPE;
BEGIN
  IF COALESCE(NEW.on_break,false) THEN
    RAISE EXCEPTION ''tournament % cannot complete while on_break remains true'', NEW.id
      USING ERRCODE = ''check_violation'';
  END IF;
  v_kind := public.fn_tournament_finish_kind(NEW.id);

  IF v_kind = ''final_table_deal'' AND NOT EXISTS (
    SELECT 1 FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=NEW.id AND b.contract_version=2
  ) THEN
    -- The final-table-deal domain RPC owns RUNNING -> COMPLETING -> COMPLETED
    -- in one transaction. Its settled immutable batch is the canonical winner
    -- claim and exists only in that same transaction before this trigger runs.
    IF OLD.status IS DISTINCT FROM ''COMPLETING''
       OR current_setting(''app.atomic_final_table_deal_batch'', true)
            IS DISTINCT FROM NEW.id::text THEN
      RAISE EXCEPTION ''final-table-deal tournament % cannot complete from status %'',
        NEW.id, OLD.status USING ERRCODE = ''check_violation'';
    END IF;
    SELECT b.chip_leader INTO v_winner
      FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id = NEW.id AND b.settled_at IS NOT NULL;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION ''final-table-deal tournament % has no settled atomic winner claim'', NEW.id
        USING ERRCODE = ''check_violation'';
    END IF;
    INSERT INTO public.tournament_finish_receipts
      (tournament_id,winner_user_id,finish_kind,claim_source)
    VALUES (NEW.id,v_winner,v_kind,''atomic_final_table_deal'')
    ON CONFLICT (tournament_id) DO NOTHING;
  ELSE
    -- Normal and satellite settlement consume an immutable RUNNING ->
    -- COMPLETING claim made before their domain plan is frozen. The certificate
    -- layer does not invent a missing claim for an out-of-band writer.
    IF OLD.status IS DISTINCT FROM ''COMPLETING'' THEN
      RAISE EXCEPTION ''tournament % cannot complete from status %'', NEW.id, OLD.status
        USING ERRCODE = ''check_violation'';
    END IF;
    SELECT (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = NEW.id
       AND tp.status = ''winner'' AND tp.position = 1;
    IF v_winner IS NULL THEN
      RAISE EXCEPTION ''tournament % has no canonical winner'', NEW.id
        USING ERRCODE = ''check_violation'';
    END IF;
  END IF;

  SELECT * INTO v_existing FROM public.tournament_finish_receipts
   WHERE tournament_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION ''tournament % has no immutable finish claim'', NEW.id
      USING ERRCODE = ''check_violation'';
  END IF;
  IF v_existing.winner_user_id IS DISTINCT FROM v_winner
     OR v_existing.finish_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION ''tournament % completion conflicts with finish claim'', NEW.id
      USING ERRCODE = ''check_violation'';
  END IF;

  v_ready := public.fn_tournament_finish_readiness(NEW.id,v_winner);
  IF COALESCE((v_ready->>''ok'')::boolean,false) IS NOT TRUE THEN
    RAISE EXCEPTION ''tournament % is not financially certified: %'',
      NEW.id, COALESCE(v_ready->''failures'',''[]''::jsonb)
      USING ERRCODE = ''check_violation'';
  END IF;

  UPDATE public.tournament_finish_receipts
     SET certified_at = COALESCE(certified_at,now()),
         completed_at = COALESCE(completed_at,COALESCE(NEW.ended_at,now())),
         evidence = COALESCE(evidence,v_ready),
         updated_at = now()
   WHERE tournament_id = NEW.id;
  RETURN NEW;
END;
$function$;'; END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype) INTO v_src,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_src)<>'d994347e1b76c936ce13361d73f94fd2' OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'v2 fn_guard_tournament_completed_certificate postcondition differs'; END IF;
END;
$v2_fn_guard_tournament_completed_certificate$;


-- Preserve the historical contract; v2 consumes a verified real finish claim.
DO $v2_trg_lock_atomic_final_table_deal_status$
DECLARE v_oid oid:='public.trg_lock_atomic_final_table_deal_status()'::regprocedure; v_src text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype) INTO v_src,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_src) NOT IN ('5f6ced03cd9de156f8b50cf98b96fc49','ddc5e3121ed9cc73d41525e6c1ba6c34') OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=public']::text[]) OR has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=v_oid AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND NOT(a.grantee='service_role'::regrole)) THEN RAISE EXCEPTION 'v2 trg_lock_atomic_final_table_deal_status prerequisite differs'; END IF;
 IF md5(v_src)='5f6ced03cd9de156f8b50cf98b96fc49' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.trg_lock_atomic_final_table_deal_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_settled_at timestamptz;
  v_has_batch boolean := false;
BEGIN
  SELECT b.settled_at INTO v_settled_at
    FROM public.tournament_final_table_deal_batches b
   WHERE b.tournament_id = OLD.id;
  v_has_batch := FOUND;

  IF v_has_batch AND EXISTS (
    SELECT 1 FROM public.tournament_final_table_deal_batches b
     WHERE b.tournament_id=OLD.id AND b.contract_version=2
  ) THEN
    IF v_settled_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tournament_finish_receipts f
      JOIN public.tournament_final_table_deal_batches b ON b.tournament_id=f.tournament_id
      WHERE f.tournament_id=OLD.id AND f.finish_kind=''final_table_deal''
        AND f.winner_user_id=b.chip_leader
    ) THEN
      RAISE EXCEPTION ''canonical final deal status requires its real settled claim''
        USING ERRCODE=''check_violation'';
    END IF;
    IF OLD.status=''RUNNING'' AND NEW.status=''COMPLETING''
      AND current_setting(''app.tournament_finish_claim'',true)=OLD.id::text THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.id,false);
      RETURN NEW;
    ELSIF OLD.status=''COMPLETING'' AND NEW.status=''COMPLETED'' THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(OLD.id,true);
      RETURN NEW;
    END IF;
    RAISE EXCEPTION ''canonical final deal status transition has no verified owner''
      USING ERRCODE=''check_violation'';
  END IF;

  IF v_has_batch
     AND (v_settled_at IS NULL
          OR OLD.status IS DISTINCT FROM ''COMPLETING''
          OR NEW.status IS DISTINCT FROM ''COMPLETED''
          OR current_setting(''app.atomic_final_table_deal_batch'', true)
               IS DISTINCT FROM OLD.id::text) THEN
    RAISE EXCEPTION
      ''tournament % has an atomic final-table-deal batch; only its owning transaction may advance COMPLETING to COMPLETED after full settlement'',
      OLD.id USING ERRCODE = ''check_violation'';
  END IF;

  RETURN NEW;
END;
$function$;'; END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,'defaults',pronargdefaults,'return',prorettype) INTO v_src,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_src)<>'ddc5e3121ed9cc73d41525e6c1ba6c34' OR v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'v2 trg_lock_atomic_final_table_deal_status postcondition differs'; END IF;
END;
$v2_trg_lock_atomic_final_table_deal_status$;


-- The normal-place guard also checks deal events, using their exact version.
DO $canonical_final_deal_place_dispatch$
DECLARE v_oid oid:='public.trg_tournament_atomic_place_completion_guard()'::regprocedure;
 v_source text; v_definition text; v_before jsonb; v_after jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),jsonb_build_object('owner',proowner,'acl',proacl,
  'config',proconfig,'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_definition,v_before FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source) NOT IN ('35aaa6ce83fe80578c85c8e43cf4234b','3e43d26ddd36a55e736a9a304a89ba9a')
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_oid AND proowner='postgres'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=public']::text[])
  OR NOT has_function_privilege('service_role',v_oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
   aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=v_oid AND a.privilege_type='EXECUTE'
    AND a.grantee NOT IN (p.proowner,'service_role'::regrole))
 THEN RAISE EXCEPTION 'canonical final deal place-dispatch prerequisite differs'; END IF;
 IF md5(v_source)='35aaa6ce83fe80578c85c8e43cf4234b' THEN
  IF (length(v_source)-length(replace(v_source,'    IF to_regprocedure(''public.fn_check_atomic_final_table_deal(uuid)'') IS NULL THEN
','')))<>length('    IF to_regprocedure(''public.fn_check_atomic_final_table_deal(uuid)'') IS NULL THEN
')
  THEN RAISE EXCEPTION 'canonical final deal place-dispatch fragment differs'; END IF;
  EXECUTE replace(v_definition,'    IF to_regprocedure(''public.fn_check_atomic_final_table_deal(uuid)'') IS NULL THEN
','    IF EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches b
       WHERE b.tournament_id=NEW.id AND b.contract_version=2) THEN
      PERFORM public.fn_ca_verify_terminal_final_deal_batch(NEW.id,true);
      RETURN NEW;
    END IF;
    IF to_regprocedure(''public.fn_check_atomic_final_table_deal(uuid)'') IS NULL THEN
');
 END IF;
 SELECT prosrc,jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,
  'definer',prosecdef,'language',prolang,'args',proargtypes::text,
  'defaults',pronargdefaults,'return',prorettype)
 INTO v_source,v_after FROM pg_proc WHERE oid=v_oid;
 IF md5(v_source)<>'3e43d26ddd36a55e736a9a304a89ba9a' OR v_before IS DISTINCT FROM v_after
 THEN RAISE EXCEPTION 'canonical final deal place-dispatch postcondition differs'; END IF;
END;
$canonical_final_deal_place_dispatch$;

-- Postconditions are part of the same atomic installation.
DO $final_deal_v2_postflight$
DECLARE v_row record; v_oid oid;
BEGIN
 FOR v_row IN SELECT * FROM (VALUES
  ('public.fn_ca_verify_terminal_final_deal_batch(uuid,boolean)','260c94b41d7f2bb021a88a546a1714ac',ARRAY['search_path=public, pg_temp']::text[],false),
  ('public.fn_guard_tournament_completing_claim()','82078938fd926c94a0ab778acd77dd61',ARRAY['search_path=public, pg_temp']::text[],false),
  ('public.trg_tournament_atomic_place_completion_guard()','3e43d26ddd36a55e736a9a304a89ba9a',ARRAY['search_path=public']::text[],true),
  ('public.trg_lock_atomic_final_table_deal_status()','ddc5e3121ed9cc73d41525e6c1ba6c34',ARRAY['search_path=public']::text[],true),
  ('public.fn_guard_tournament_completed_certificate()','d994347e1b76c936ce13361d73f94fd2',ARRAY['search_path=public, pg_temp']::text[],false),
  ('public.trg_freeze_canonical_final_deal_batch()','80362aed787137219432f6039bf03158',ARRAY['search_path=public, pg_temp']::text[],false),
  ('public.fn_settle_tournament_final_table_deal(uuid)','b1941b2e55dade307ecd74068ab3e500',ARRAY['search_path=public','statement_timeout=30s']::text[],true),
  ('public.trg_atomic_final_table_deal_completion_guard()','9f5f5fefa77ae93bfeffc9f414a63a0d',ARRAY['search_path=public']::text[],true),
  ('public.trg_freeze_atomic_final_table_deal_obligation()','d338c5278ef1247ff0f4a7c4ba774cc5',ARRAY['search_path=public']::text[],true),
  ('public.fn_tournament_finish_readiness(uuid,uuid)','993e6e1de9edba2fe235d86ff6c243c9',ARRAY['search_path=public, pg_temp']::text[],false),
  ('public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)','3585ddbfdb0a197243d5e6eefb6b670f',ARRAY['search_path=public']::text[],false),
  ('public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)','f1fc7a0bf480b1034f0f1d9cba3b4d0b',ARRAY['search_path=public']::text[],false),
  ('public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)','852e35483b67c1fc59b6347b51c79cb8',ARRAY['search_path=public']::text[],false)
 ) expected(identity,body_md5,config,service_execute)
 LOOP
  v_oid:=to_regprocedure(v_row.identity);
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
   AND md5(p.prosrc)=v_row.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef
   AND p.proconfig=v_row.config
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql'))
   OR has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM v_row.service_execute
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
    aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=v_oid
    AND a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
    AND NOT(v_row.service_execute AND a.grantee='service_role'::regrole))
  THEN RAISE EXCEPTION 'canonical final deal exact postflight differs: %',v_row.identity; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE
  conrelid='public.tournament_final_table_deal_batches'::regclass
  AND conname='tournament_final_table_deal_bubble_shape' AND convalidated
  AND md5(pg_get_constraintdef(oid))='e685ad4c6440decb7f57310d455c5bd0')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE
   tgrelid='public.tournament_final_table_deal_batches'::regclass
   AND tgname='zzzz_freeze_canonical_final_deal_batch'
   AND tgfoid='public.trg_freeze_canonical_final_deal_batch()'::regprocedure
   AND tgtype=27 AND tgenabled='O' AND NOT tgisinternal AND tgnargs=0 AND tgqual IS NULL)
 THEN RAISE EXCEPTION 'canonical final deal constraint or immutability postflight differs'; END IF;
END;
$final_deal_v2_postflight$;
-- END CANONICAL TERMINAL FINAL DEAL BATCH CONTRACT
COMMIT;
