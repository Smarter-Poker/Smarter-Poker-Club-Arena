-- First-day legacy budget import planned a scan of2.82M tournament_players
-- before its first-paid-day HAVING filter. Its actual caller error was not
-- recovered; this fixes the demonstrated unbounded query shape. Current
-- eligible empty boards remained unseeded and sng_horse_days remained empty.
-- Keep the complete first-horse MIN before the Chicago-day decision, including
-- null-date fallback and completed/withdrawn history. Materialize structural
-- fixed boards first, then use the existing per-tournament roster index.
-- Read-only production candidate SELECT completed in2.117s under8s timeout;
-- no production planner call, claim, registration, index or DDL probe was used.
-- This replaces only the installed private planner SELECT; guard/financial
-- writers/permissions and daily random admission policy are unchanged.
-- @live-proof: position('WITH fixed AS MATERIALIZED' IN pg_get_functiondef('smarter_private.sng_horse_plan(uuid,boolean)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE body text; before_acl aclitem[];
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='smarter_private.sng_horse_plan(uuid,boolean)'::regprocedure)
    IS DISTINCT FROM 'c6706392b7ab2f109e044dfc0947e30e' THEN
  RAISE EXCEPTION 'SNG horse legacy import preimage changed; qualify current source'; END IF;
 SELECT pg_get_functiondef(oid),proacl INTO body,before_acl FROM pg_proc
  WHERE oid='smarter_private.sng_horse_plan(uuid,boolean)'::regprocedure;
 IF length(body)-length(replace(body,$old$       SELECT old.id,t.union_id,d,min(coalesce(tp.registered_at,now_at)),0,true
       FROM public.tournaments old JOIN public.tournament_players tp ON tp.tournament_id=old.id
       JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
       WHERE old.union_id=t.union_id AND old.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(old))
       GROUP BY old.id HAVING (min(coalesce(tp.registered_at,now_at)) AT TIME ZONE 'America/Chicago')::date=d
$old$,''))<>length($old$       SELECT old.id,t.union_id,d,min(coalesce(tp.registered_at,now_at)),0,true
       FROM public.tournaments old JOIN public.tournament_players tp ON tp.tournament_id=old.id
       JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
       WHERE old.union_id=t.union_id AND old.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(old))
       GROUP BY old.id HAVING (min(coalesce(tp.registered_at,now_at)) AT TIME ZONE 'America/Chicago')::date=d
$old$) THEN
  RAISE EXCEPTION 'SNG horse legacy import owner text changed'; END IF;
 body:=replace(body,$old$       SELECT old.id,t.union_id,d,min(coalesce(tp.registered_at,now_at)),0,true
       FROM public.tournaments old JOIN public.tournament_players tp ON tp.tournament_id=old.id
       JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
       WHERE old.union_id=t.union_id AND old.format_contract='sng-v1'
         AND public.fn_ca_is_fixed_sng_satellite(to_jsonb(old))
       GROUP BY old.id HAVING (min(coalesce(tp.registered_at,now_at)) AT TIME ZONE 'America/Chicago')::date=d
$old$,$new$       WITH fixed AS MATERIALIZED (
         SELECT old.* FROM public.tournaments old
         WHERE old.union_id=t.union_id AND old.format_contract='sng-v1'
           AND upper(old.tournament_type)='SNG' AND lower(old.variant)='sng'
           AND old.max_players IN(6,9) AND old.min_players=old.max_players
           AND old.table_size=old.max_players AND old.satellite_seats=2
           AND coalesce(old.satellite_target_id,old.satellite_target) IS NOT NULL
       )
       SELECT old.id,t.union_id,d,paid.first_at,0,true
       FROM fixed old CROSS JOIN LATERAL (
         SELECT min(coalesce(tp.registered_at,now_at)) first_at
         FROM public.tournament_players tp
         JOIN public.profiles h ON h.id=tp.user_id AND h.is_horse IS TRUE
         WHERE tp.tournament_id=old.id
       ) paid
       WHERE public.fn_ca_is_fixed_sng_satellite(to_jsonb(old))
         AND (paid.first_at AT TIME ZONE 'America/Chicago')::date=d
$new$);
 EXECUTE body;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='smarter_private.sng_horse_plan(uuid,boolean)'::regprocedure)
    IS DISTINCT FROM 'e4b57b00b0a07252b779e4bc6826a1fc' THEN
  RAISE EXCEPTION 'SNG horse legacy import postimage differs'; END IF;
 IF (SELECT proacl FROM pg_proc WHERE oid='smarter_private.sng_horse_plan(uuid,boolean)'::regprocedure)
    IS DISTINCT FROM before_acl THEN RAISE EXCEPTION 'SNG horse planner permissions changed'; END IF;
END $patch$;
COMMIT;
