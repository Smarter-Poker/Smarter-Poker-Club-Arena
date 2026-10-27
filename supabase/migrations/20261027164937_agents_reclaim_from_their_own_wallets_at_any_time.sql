-- Owner 2026-10-27: agents may reclaim their own personal chips at any time.
-- No new authority over another member, club wallet or promo conversion.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE d text; before_text text := $old$IF p_transaction_id IS NULL AND actor_role NOT IN ('owner','co_owner','admin') THEN$old$;
BEGIN
 SELECT pg_get_functiondef('public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)'::regprocedure) INTO d;
 IF md5(d) <> '85b41fe75ee3a9d5c5617dc671c120f6' OR position(before_text IN d)=0 THEN
  RAISE EXCEPTION 'Claim Authority Source Changed';
 END IF;
 EXECUTE replace(d,before_text,$new$IF p_transaction_id IS NULL AND actor IS DISTINCT FROM p_from_user_id AND actor_role NOT IN ('owner','co_owner','admin') THEN$new$);
END $patch$;
COMMIT;

-- @live-proof: md5(pg_get_functiondef('public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)'::regprocedure)) = '54450c4c6f5e6ca4d3b7804a669bf0cc'
-- @live-proof: NOT has_function_privilege('anon','public.fn_club_wallet_claim_back(uuid,uuid,numeric,text,text,text,uuid,uuid)','EXECUTE')
