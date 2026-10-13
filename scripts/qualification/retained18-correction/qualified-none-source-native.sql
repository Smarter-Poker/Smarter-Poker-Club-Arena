CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_accept_hand()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_verdict jsonb; v_facts jsonb; v_ids uuid[]; v_expected_ids uuid[];
 v_loser uuid; v_winner uuid; v_pool uuid; v_pay jsonb; v_receipt jsonb;
 v_total bigint; v_table_share bigint; v_each bigint; v_loser_share bigint; v_winner_share bigint;
 v_main bigint; v_paid bigint; v_scope text; v_kind text; v_id uuid:=gen_random_uuid();
 v_variant text; v_bb numeric; v_arena uuid; v_paid_flag boolean:=false; v_leg jsonb; v_name text;
BEGIN
 IF OLD.post_commit_payload IS NOT NULL OR NEW.post_commit_payload IS NULL THEN RETURN NEW; END IF;
 v_verdict:=NEW.post_commit_payload->'accepted_hand_facts'->'diamond_jackpot';
 IF v_verdict IS NULL THEN
   IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=NEW.table_id AND c.asset='diamonds' AND t.tournament_id IS NULL)
      AND public.fn_ca_diamond_economic_on('bbj_enabled') THEN
     RAISE EXCEPTION 'diamond_jackpot_accepted_verdict_required';
   END IF;
   RETURN NEW;
 END IF; -- previous engine remains compatible while switch is no
 IF jsonb_typeof(v_verdict) IS DISTINCT FROM 'object'
    OR v_verdict->>'version' IS DISTINCT FROM '1'
    OR COALESCE(v_verdict->>'kind','') NOT IN ('none','main','mini') THEN
   RAISE EXCEPTION 'diamond_jackpot_invalid_accepted_verdict' USING ERRCODE='22023';
 END IF;
 v_kind:=v_verdict->>'kind';
 -- A validated no-hit verdict carries no cash-jackpot obligation. Tournament
 -- hands retain their original settlement; positive hits still require cash scope.
 IF v_kind='none' THEN RETURN NEW; END IF;
 SELECT t.game_variant,t.big_blind,t.club_id INTO v_variant,v_bb,v_arena FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=NEW.table_id AND t.tournament_id IS NULL AND c.asset='diamonds'
     AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_jackpot_wrong_hand_scope'; END IF;
 SELECT request->'rake_facts' INTO v_facts FROM public.poker_diamond_hand_receipts
   WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF v_facts IS NULL OR jsonb_typeof(v_verdict->'pot') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'dealt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'saw_flop') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v_verdict->'double_board') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v_verdict->'big_blind') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'dealt_user_ids') IS DISTINCT FROM 'array'
    OR v_verdict->'pot' IS DISTINCT FROM v_facts->'pot'
    OR v_verdict->'dealt' IS DISTINCT FROM v_facts->'dealt'
    OR v_verdict->'saw_flop' IS DISTINCT FROM v_facts->'saw_flop'
    OR v_verdict->'double_board' IS DISTINCT FROM v_facts->'double_board'
    OR v_verdict->>'variant' IS DISTINCT FROM v_variant
    OR (v_verdict->>'big_blind')::numeric IS DISTINCT FROM v_bb
    OR (v_verdict->>'saw_flop')::boolean IS NOT TRUE
    OR (v_verdict->>'double_board')::boolean IS NOT FALSE THEN
   RAISE EXCEPTION 'diamond_jackpot_verdict_disagrees_with_accepted_hand';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_verdict->'dealt_user_ids') x
      WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(x#>>'{}','uuid'))
   OR pg_input_is_valid(v_verdict->>'loser_user_id','uuid') IS DISTINCT FROM true
   OR pg_input_is_valid(v_verdict->>'winner_user_id','uuid') IS DISTINCT FROM true
   OR NULLIF(v_verdict->>'loser_hand','') IS NULL OR NULLIF(v_verdict->>'winner_hand','') IS NULL THEN
   RAISE EXCEPTION 'diamond_jackpot_recipient_identity_required';
 END IF;
 SELECT array_agg(DISTINCT (x#>>'{}')::uuid ORDER BY (x#>>'{}')::uuid) INTO v_ids
   FROM jsonb_array_elements(v_verdict->'dealt_user_ids') x;
 SELECT array_agg((x->>'user_id')::uuid ORDER BY (x->>'user_id')::uuid) INTO v_expected_ids
   FROM jsonb_array_elements(v_facts->'contributions') x WHERE (x->>'dealt_in')::boolean;
 v_loser:=(v_verdict->>'loser_user_id')::uuid;
 v_winner:=(v_verdict->>'winner_user_id')::uuid;
 IF v_ids IS DISTINCT FROM v_expected_ids OR cardinality(v_ids)<>(v_verdict->>'dealt')::integer
    OR cardinality(v_ids)<>jsonb_array_length(v_verdict->'dealt_user_ids')
    OR v_loser=v_winner OR NOT(v_loser=ANY(v_ids)) OR NOT(v_winner=ANY(v_ids)) THEN
   RAISE EXCEPTION 'diamond_jackpot_recipients_disagree_with_dealt_roster';
 END IF;
 v_pool:=public.fn_poker_diamond_jackpot_pool_for_table(NEW.table_id);
 IF v_pool IS NULL THEN RAISE EXCEPTION 'diamond_jackpot_pool_absent'; END IF;
 PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id=v_pool FOR UPDATE;
 v_scope:=public.fn_poker_diamond_jackpot_stake_scope(v_bb);
 IF v_kind='main' THEN
   v_main:=public.fn_poker_diamond_jackpot_bank(v_pool,'main');
   v_paid:=floor(v_main*public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares',v_scope),1,'paid')/100)::bigint;
   IF v_paid>0 THEN
     v_pay:=public.fn_poker_diamond_jackpot_pay(NEW.table_id,NEW.hand_number,
       (v_verdict->>'pot')::numeric,(v_verdict->>'dealt')::integer,v_loser,v_winner,v_ids);
     v_paid_flag:=true;
   ELSE
     v_pay:=jsonb_build_object('paid',false,'reason','pool_funding');
   END IF;
 ELSE
   v_pay:=public.fn_poker_diamond_jackpot_pay_mini(NEW.table_id,NEW.hand_number,
     (v_verdict->>'pot')::numeric,(v_verdict->>'dealt')::integer,v_loser,v_winner,v_ids);
   v_paid_flag:=v_pay ? 'legs';
 END IF;
 IF v_paid_flag THEN
   SELECT COALESCE(sum((x->>'amount')::bigint),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='table'),0),
     COALESCE(max((x->>'amount')::bigint) FILTER(WHERE x->>'role'='table'),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='loser'),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='winner'),0)
   INTO v_total,v_table_share,v_each,v_loser_share,v_winner_share
   FROM jsonb_array_elements(v_pay->'legs') x;
   IF v_total<=0 OR v_total IS DISTINCT FROM (v_pay->>'paid_out')::bigint THEN
     RAISE EXCEPTION 'diamond_jackpot_paid_receipt_incomplete';
   END IF;
 ELSE v_total:=0; v_table_share:=0; v_each:=0; v_loser_share:=0; v_winner_share:=0;
 END IF;
 v_receipt:=jsonb_build_object('id',v_id,'paid',v_paid_flag,'kind',v_kind,'asset','diamonds',
   'pool_id',v_pool,'table_id',NEW.table_id,'hand_number',NEW.hand_number,'hand_id',NEW.hand_id,'total',v_total,
   'loser',jsonb_build_object('userId',v_loser,'share',v_loser_share),
   'winner',jsonb_build_object('userId',v_winner,'share',v_winner_share),
   'tableShare',v_table_share,'perPlayerShare',v_each,
   'tablePlayerIds',to_jsonb(array_remove(array_remove(v_ids,v_loser),v_winner)),
   'reason',v_pay->>'reason','payment',v_pay);
 IF v_paid_flag THEN
   v_name:=CASE WHEN v_kind='mini' THEN 'Mini Bad Beat Jackpot' ELSE 'Bad Beat Jackpot' END;
   FOR v_leg IN SELECT value FROM jsonb_array_elements(v_pay->'legs') LOOP
     IF (v_leg->>'amount')::bigint>0 AND COALESCE((SELECT diamond_rewards
       FROM public.user_notification_preferences WHERE user_id=(v_leg->>'user_id')::uuid),true) THEN
       PERFORM public.fn_raise_notification((v_leg->>'user_id')::uuid,'bonus',
         v_name||' - You Got Paid!',
         'Your '||v_name||' Share Of '||to_char((v_leg->>'amount')::numeric,'FM999G999G999G999G999')||
           ' Diamonds Was Credited To Your Diamond Wallet On Hand #'||NEW.hand_number::text||'.',
         '/hub/club-arena/table/'||NEW.table_id::text,
         jsonb_build_object('asset','diamonds','kind',v_kind,'payout_id',v_id,
           'table_id',NEW.table_id,'hand_number',NEW.hand_number,'share',(v_leg->>'amount')::bigint));
     END IF;
   END LOOP;
 END IF;
 INSERT INTO public.poker_diamond_jackpot_hits(id,arena_id,table_id,hand_number,hand_id,kind,paid,verdict,receipt)
 VALUES(v_id,v_arena,NEW.table_id,NEW.hand_number,NEW.hand_id,v_kind,v_paid_flag,v_verdict,v_receipt);
 RETURN NEW;
END $fn$;

-- Exact installed parent security, captured READONLY 03:25 UTC.
ALTER FUNCTION public.fn_poker_diamond_jackpot_accept_hand() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_accept_hand() FROM PUBLIC,anon,authenticated,service_role;
