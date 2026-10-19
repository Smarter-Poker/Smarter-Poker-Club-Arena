-- The hourly retention operation must commit useful cursor progress before its
-- 120s statement deadline. The 200k materialized range took112.5s on Oct19 and
-- timed out at09:17, rolling the cursor back. A250-identity indexed anti-join
-- measured101ms on the same live cold indexes. Scan that bounded unit until
-- the original scan/compaction limit or a10s work budget, then commit normally.
-- No extra job, timeout increase, player-total change, or disposal authority.
-- @live-proof: md5(pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure)) = '3364419775a304ce37eb7ebfc65db6db'
BEGIN;
SET LOCAL lock_timeout = '3s';
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_prune_ca_hand_facts(integer)'::regprocedure)) <> 'a5300a24f3afe4c078d011f0980bf0cd'
 THEN RAISE EXCEPTION 'fact retention preimage changed'; END IF;
END $preimage$;
CREATE OR REPLACE FUNCTION public.fn_prune_ca_hand_facts(p_limit integer DEFAULT 200000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
 ids uuid[]; page_ids uuid[]; n integer:=0; days integer;
 lim integer:=LEAST(GREATEST(COALESCE(p_limit,250),1),250);
 scan_limit integer:=LEAST(GREATEST(COALESCE(p_limit,200000),1),200000);
 after_id uuid; page_count integer; scanned integer:=0; candidates integer:=0; exhausted boolean:=false;
 work_deadline timestamptz:=clock_timestamp()+interval '10 seconds';
BEGIN
 SELECT horse_retention_days INTO days FROM public.hand_history_retention_policy LIMIT 1;
 IF public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('deleted',0,'compacted',0,'more',false,'retention_days',days,'status','frozen');
 END IF;
 INSERT INTO smarter_private.horse_fact_card_prune_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
 SELECT c.last_hand_id INTO after_id FROM smarter_private.horse_fact_card_prune_cursor c WHERE c.singleton FOR UPDATE;
 LOOP
  SELECT array_agg(p.hand_id ORDER BY p.hand_id) INTO page_ids FROM (
   SELECT c.hand_id FROM smarter_private.horse_adaptive_disposal_certificates c
   WHERE c.hand_id>COALESCE(after_id,'00000000-0000-0000-0000-000000000000'::uuid)
   ORDER BY c.hand_id LIMIT LEAST(250,scan_limit-scanned,lim-candidates)
  ) p;
  page_count:=COALESCE(cardinality(page_ids),0);
  IF page_count=0 THEN exhausted:=true;after_id:=NULL;EXIT; END IF;
  SELECT array_agg(p.hand_id ORDER BY p.hand_id) INTO ids
   FROM unnest(page_ids) p(hand_id)
   WHERE NOT EXISTS(SELECT 1 FROM smarter_private.horse_fact_card_disposals f WHERE f.hand_id=p.hand_id);
  candidates:=candidates+COALESCE(cardinality(ids),0);
  n:=n+smarter_private.compact_horse_fact_cards(ids);
  scanned:=scanned+page_count;
  after_id:=page_ids[page_count];
  EXIT WHEN scanned>=scan_limit OR candidates>=lim OR clock_timestamp()>=work_deadline;
 END LOOP;
 -- Cursor and original compactor remain one transaction. A refused hand stays
 -- intact and is revisited after wrap; an error rolls back both and propagates.
 UPDATE smarter_private.horse_fact_card_prune_cursor SET last_hand_id=after_id WHERE singleton;
 RETURN jsonb_build_object('deleted',0,'compacted',n,'cutoff',now()-make_interval(days=>COALESCE(days,8)),
  'retention_days',days,'scanned',scanned,'more',NOT exhausted);
END $function$;
REVOKE ALL ON FUNCTION public.fn_prune_ca_hand_facts(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_ca_hand_facts(integer) TO service_role;
COMMIT;
