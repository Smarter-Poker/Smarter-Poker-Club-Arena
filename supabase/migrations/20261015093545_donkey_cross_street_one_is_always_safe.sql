-- 20261015093545_donkey_cross_street_one_is_always_safe.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-15: "STREET 1 IS ALWAYS SUPPOSED TO BE 100% SAFE, NEVER DIE ON
-- STREET 1 EVER."
--
-- Contract 6 (20261012113806) put the fair coin on EVERY street, "street one
-- included", which undid the earlier ruling that the first step of a bonus
-- game never ruins it (contract 4/5: street one certain at 0.80x). One of the
-- three contract-6 rounds played died on street one.
--
-- CONTRACT 7, DONKEY CROSS ONLY. Mines stays on contract 5.
--   1. THE COIN. Street one is SAFE, always. Street k >= 2 is contract 6's coin
--      for street k, unchanged (fn_choice_road_coin_v6).
--   2. THE LADDER. Street one pays 0.80B, the sure step, worth exactly the 80%
--      Dan set ("Smaller prizes, keep 80%"). Street k+1 pays contract 6's
--      street k, so with the same loss rule (fn_choice_loss_floor_v5) booking
--      after ANY street is still worth exactly 0.80B. At most 20 streets.
--   3. Every reader of the road (result proof, replay) reads contract 6 and 7
--      through fn_choice_road_coins_vn, which flips the right coins for the
--      round's own sealed contract. Sealed contract-6 rounds are untouched.
--
-- Rewritten from the exact production bodies (md5 guarded), only the named
-- lines changed. The client that reads contract 7 ships in the same PR and is
-- published before this is installed.
-- @live-proof: to_regprocedure('public.fn_choice_road_coin_v7(text,text,bigint,integer)') IS NOT NULL AND position('fn_choice_prizes_v7' in pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE pre record;
BEGIN
 FOR pre IN SELECT * FROM (VALUES
  ('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)','4c14dc8ad4666cf07a47bc9a44957e75'),
  ('public.fn_choice_act(uuid,text,integer,integer)','ea185d0371c163f96497ad3e57f8c49f'),
  ('public.fn_choice_result(diamond_choice_rounds)','b6992f97ffd69b3532e5d1409d450193'),
  ('public.fn_choice_state(uuid,text,text,integer)','cf90feb39dcea44efec07e10ef5afda5'),
  ('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)','95f04935f26513de5501b943a0ea61de'),
  ('public.fn_diamond_bonus_replay(uuid)','6bd8e9bb51e3d47ce8f078a7573eed41'),
  ('public.fn_choice_road_coin_v6(text,text,bigint,integer)','cca63c5fec6f593d381a551dc6c99434'),
  ('public.fn_choice_road_prizes_v6(numeric,numeric)','8a8276d07873e558d321166935568fb4')
 ) v(sig,md5) LOOP
  IF to_regprocedure(pre.sig) IS NULL OR md5(pg_get_functiondef(to_regprocedure(pre.sig))) IS DISTINCT FROM pre.md5 THEN
   RAISE EXCEPTION 'Donkey Cross Contract 7 Preimage Changed: %',pre.sig; END IF;
 END LOOP;
 IF to_regprocedure('public.fn_choice_road_coin_v7(text,text,bigint,integer)') IS NOT NULL THEN
  RAISE EXCEPTION 'Contract 7 Is Already Installed'; END IF;
END $guard$;

-- 1. THE COIN: street one is safe; every later street is contract 6's coin.
CREATE FUNCTION public.fn_choice_road_coin_v7(p_server_seed text,p_client_seed text,p_nonce bigint,p_street integer)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $function$
 SELECT p_street=1 OR public.fn_choice_road_coin_v6(p_server_seed,p_client_seed,p_nonce,p_street)
$function$;
-- Every street's coin of a sealed road, under the round's own contract.
CREATE FUNCTION public.fn_choice_road_coins_vn(p_version integer,p_server_seed text,p_client_seed text,p_nonce bigint,p_streets integer)
RETURNS boolean[] LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $function$
 SELECT COALESCE(array_agg(CASE WHEN p_version=7
   THEN public.fn_choice_road_coin_v7(p_server_seed,p_client_seed,p_nonce,k)
   ELSE public.fn_choice_road_coin_v6(p_server_seed,p_client_seed,p_nonce,k) END ORDER BY k),'{}'::boolean[])
 FROM generate_series(1,p_streets) k
$function$;
-- 2. THE LADDER: the sure street at 0.80B, then contract 6's road.
CREATE FUNCTION public.fn_choice_road_prizes_v7(p_bet numeric,p_floor numeric)
RETURNS numeric[] LANGUAGE sql IMMUTABLE SET search_path=public AS $function$
 SELECT (ARRAY[p_bet*0.8]||public.fn_choice_road_prizes_v6(p_bet,p_floor))[1:20]
$function$;
CREATE FUNCTION public.fn_choice_prizes_v7(p_game text,p_mode text,p_bet numeric,p_floor numeric)
RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $function$
BEGIN
 IF p_game='crossing' THEN
  IF p_mode IS DISTINCT FROM 'road' THEN RAISE EXCEPTION 'Choose A Road Difficulty'; END IF;
  RETURN public.fn_choice_road_prizes_v7(p_bet,p_floor);
 END IF;
 RETURN public.fn_choice_prizes_v5(p_game,p_mode,p_bet,p_floor);
END $function$;
REVOKE ALL ON FUNCTION public.fn_choice_road_coin_v7(text,text,bigint,integer),public.fn_choice_road_coins_vn(integer,text,text,bigint,integer),
 public.fn_choice_road_prizes_v7(numeric,numeric),public.fn_choice_prizes_v7(text,text,numeric,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_choice_road_coin_v7(text,text,bigint,integer),public.fn_choice_road_coins_vn(integer,text,text,bigint,integer),
 public.fn_choice_road_prizes_v7(numeric,numeric),public.fn_choice_prizes_v7(text,text,numeric,numeric) TO service_role;

-- 3. The six readers and writers, each with only its named lines changed.
DO $rewrite$
DECLARE d text;
BEGIN
 -- the opener deals contract 7
 d:=pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure);
 d:=replace(d,'public.fn_choice_prizes_v6(p_game,','public.fn_choice_prizes_v7(p_game,');
 d:=replace(d,$f$CASE WHEN p_game='crossing' THEN 6 ELSE 5 END) RETURNING$f$,$f$CASE WHEN p_game='crossing' THEN 7 ELSE 5 END) RETURNING$f$);
 EXECUTE d;
 -- the step settles contract 7 with its own coin and the contract-5 loss rule
 d:=pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure);
 d:=replace(d,'  ELSIF r.payout_version=6 THEN safe:=public.fn_choice_road_coin_v6(r.server_seed,r.client_seed,r.nonce,n+1);',
  E'  ELSIF r.payout_version=7 THEN safe:=public.fn_choice_road_coin_v7(r.server_seed,r.client_seed,r.nonce,n+1);\n  ELSIF r.payout_version=6 THEN safe:=public.fn_choice_road_coin_v6(r.server_seed,r.client_seed,r.nonce,n+1);');
 d:=replace(d,'r.payout_version IN (5,6) THEN','r.payout_version IN (5,6,7) THEN');
 EXECUTE d;
 -- the finished round's proof reveals the round's own coins
 d:=pg_get_functiondef('public.fn_choice_result(diamond_choice_rounds)'::regprocedure);
 d:=replace(d,$f$r.game='crossing' AND r.payout_version=6 THEN$f$,$f$r.game='crossing' AND r.payout_version IN (6,7) THEN$f$);
 d:=replace(d,'public.fn_choice_road_coins_v6(r.server_seed,','public.fn_choice_road_coins_vn(r.payout_version,r.server_seed,');
 EXECUTE d;
 -- the quote a new round is dealt
 d:=pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure);
 d:=replace(d,'public.fn_choice_prizes_v6(p_game,','public.fn_choice_prizes_v7(p_game,');
 d:=replace(d,$f$'payout_version',CASE WHEN p_game='crossing' THEN 6 ELSE 5 END$f$,$f$'payout_version',CASE WHEN p_game='crossing' THEN 7 ELSE 5 END$f$);
 EXECUTE d;
 -- the wheel's bonus quote
 d:=pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure);
 d:=replace(d,$f$'payout_version',CASE WHEN p_game='crossing' THEN 6 WHEN$f$,$f$'payout_version',CASE WHEN p_game='crossing' THEN 7 WHEN$f$);
 d:=replace(d,'public.fn_choice_prizes_v6(p_game,','public.fn_choice_prizes_v7(p_game,');
 EXECUTE d;
 -- the replay names the contract the round was sealed under
 d:=pg_get_functiondef('public.fn_diamond_bonus_replay(uuid)'::regprocedure);
 d:=replace(d,$f$IF e.game='crossing' AND d.payout_version=6 THEN$f$,$f$IF e.game='crossing' AND d.payout_version IN (6,7) THEN$f$);
 d:=replace(d,'public.fn_choice_road_coins_v6(d.server_seed,','public.fn_choice_road_coins_vn(d.payout_version,d.server_seed,');
 d:=replace(d,$f$'payout_version',6,'coins'$f$,$f$'payout_version',d.payout_version,'coins'$f$);
 EXECUTE d;

 -- Every rewrite landed.
 IF position('fn_choice_prizes_v7' in pg_get_functiondef('public.fn_choice_start(uuid,text,text,integer,uuid,text,integer)'::regprocedure))=0
  OR position('fn_choice_road_coin_v7' in pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure))=0
  OR position('(5,6,7)' in pg_get_functiondef('public.fn_choice_act(uuid,text,integer,integer)'::regprocedure))=0
  OR position('fn_choice_road_coins_vn' in pg_get_functiondef('public.fn_choice_result(diamond_choice_rounds)'::regprocedure))=0
  OR position('fn_choice_prizes_v7' in pg_get_functiondef('public.fn_choice_state(uuid,text,text,integer)'::regprocedure))=0
  OR position('fn_choice_prizes_v7' in pg_get_functiondef('public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)'::regprocedure))=0
  OR position('fn_choice_road_coins_vn' in pg_get_functiondef('public.fn_diamond_bonus_replay(uuid)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'A Contract 7 Rewrite Did Not Land';
 END IF;
 -- The rule itself: street one can never be a smash, and the ladder keeps 80%.
 IF EXISTS(SELECT 1 FROM generate_series(1,2000) i
   WHERE NOT public.fn_choice_road_coin_v7(md5(i::text),md5((i*7)::text),i,1)) THEN
  RAISE EXCEPTION 'Street One Is Not Always Safe'; END IF;
 IF (public.fn_choice_road_prizes_v7(20,10))[1:3] IS DISTINCT FROM ARRAY[16.0,22.0,33.0]::numeric[] THEN
  RAISE EXCEPTION 'The Contract 7 Ladder Is Wrong: %',public.fn_choice_road_prizes_v7(20,10); END IF;
END
$rewrite$;

COMMIT;
