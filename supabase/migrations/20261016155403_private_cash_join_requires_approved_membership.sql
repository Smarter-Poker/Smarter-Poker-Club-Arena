-- Private join authorization precedes every seat, wallet and hold branch.
-- Actual outsider access witness reached a hold using an unrelated club wallet.
-- Public games retain their existing wallet/admission semantics. No money is moved.
-- Exact predecessor includes Diamond session/custody safeguards; refuse drift atomically.
-- @live-proof: (SELECT position('PRIVATE_MEMBERSHIP_REQUIRED' in pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)) > 0 AND position('PRIVATE_MEMBERSHIP_REQUIRED' in pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)) < position('fn_ca_cash_wallet_covers' in pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)))
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';
DO $migration$
DECLARE old_definition text; new_definition text;
 marker constant text := '  IF NOT g.enabled THEN';
 guard_sql constant text := $guard$
  -- A private game is a club boundary, not permission to use another club wallet.
  IF (coalesce((g.ruleset_snapshot #>> '{options,is_private}')::boolean, false)
      OR EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.is_public=false))
     AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.owner_id=v_uid)
     AND NOT EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=g.club_id
                    AND cm.user_id=v_uid AND cm.status IN ('active','approved')) THEN
    RAISE EXCEPTION 'PRIVATE_MEMBERSHIP_REQUIRED: approved club membership required'
      USING ERRCODE='42501';
  END IF;
$guard$;
BEGIN
 old_definition:=pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure);
 IF md5(old_definition)<>'21778e534332e0caffce932b05faee93' THEN
   RAISE EXCEPTION 'private cash join predecessor mismatch; no changes installed';
 END IF;
 IF (length(old_definition)-length(replace(old_definition,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION 'private cash join insertion anchor mismatch';
 END IF;
 new_definition:=replace(old_definition,marker,guard_sql||marker);
 EXECUTE new_definition;
END
$migration$;
COMMIT;
