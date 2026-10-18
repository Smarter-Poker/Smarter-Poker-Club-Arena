-- The retained retirement core still orders club_members by its removed id.
-- A self-aborting reserved-fixture retirement reproduces SQLSTATE42703 after
-- the welcome unwind; the transaction rolls back. Use the actual compound
-- membership identity (club_id,user_id), preserving the parent-first locks,
-- all balance/obligation refusals, retained history and exact authority.
-- No club, wallet, escrow or financial record changes in this migration.
-- @live-proof: (SELECT prosrc LIKE '%FROM public.club_members WHERE club_id = p_club_id ORDER BY user_id FOR UPDATE%' FROM pg_proc WHERE oid='public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '5s';
DO $patch$
DECLARE
  source text;
  patched text;
  before_owner oid;
  before_acl aclitem[];
  before_config text[];
  before_definer boolean;
BEGIN
  SELECT pg_get_functiondef(oid),proowner,proacl,proconfig,prosecdef
    INTO source,before_owner,before_acl,before_config,before_definer
    FROM pg_proc
   WHERE oid='public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure;
  IF md5(source)<>'a283c2b2e30e3651886004dabf308098' THEN
    RAISE EXCEPTION 'retirement core preimage changed';
  END IF;
  patched:=replace(source,
    'FROM public.club_members WHERE club_id = p_club_id ORDER BY id FOR UPDATE;',
    'FROM public.club_members WHERE club_id = p_club_id ORDER BY user_id FOR UPDATE;');
  IF patched=source THEN RAISE EXCEPTION 'retirement member lock substitution failed'; END IF;
  EXECUTE patched;
  IF EXISTS(SELECT 1 FROM pg_proc
     WHERE oid='public.fn_retire_settled_club_core_20260906(uuid,text,text)'::regprocedure
       AND (proowner IS DISTINCT FROM before_owner OR proacl IS DISTINCT FROM before_acl
         OR proconfig IS DISTINCT FROM before_config OR prosecdef IS DISTINCT FROM before_definer
         OR pg_get_functiondef(oid) IS DISTINCT FROM patched)) THEN
    RAISE EXCEPTION 'retirement core readback changed';
  END IF;
END $patch$;
COMMIT;
