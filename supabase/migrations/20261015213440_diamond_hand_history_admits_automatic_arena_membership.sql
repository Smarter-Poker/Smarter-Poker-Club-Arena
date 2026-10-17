-- Diamond Hand History Uses The Same Membership Authority As Arena Entry.
-- Reproduced on the published Diamond footer, 2026-10-15: the own-history
-- RPC refused every automatic member because it required an active/approved
-- club_members row. Diamond membership is a platform entitlement, not that row.
-- Read the existing arena context authority. Keep auth.uid(), own ca_hand_facts,
-- table scope, ordering, pagination, projection, owner and ACL unchanged.
-- No balances, seats, historical hands or membership rows are modified.
-- @live-proof: position('public.fn_poker_arena_context(p_club_id::text)' in pg_get_functiondef('public.ca_own_hand_history_by_club(uuid,uuid,integer,integer)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $change$
DECLARE
  v_signature regprocedure := 'public.ca_own_hand_history_by_club(uuid,uuid,integer,integer)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_before constant text := $old$IF NOT EXISTS (
    SELECT 1
      FROM public.club_members m
      JOIN public.clubs c ON c.id=m.club_id
     WHERE m.club_id=p_club_id
       AND m.user_id=v_user
       AND m.status IN ('active','approved')
       AND coalesce(c.lifecycle_status,'active')<>'retired'
  ) THEN$old$;
  v_after constant text := $new$IF COALESCE((public.fn_poker_arena_context(p_club_id::text)->>'member')::boolean, false) IS NOT TRUE THEN$new$;
BEGIN
  IF md5(v_definition) <> '64f95bd1cc7d0537c22005f16dbaa9f3' THEN
    RAISE EXCEPTION 'DIAMOND_OWN_HISTORY_PREIMAGE_CHANGED';
  END IF;
  IF position(v_before in v_definition) = 0 THEN
    RAISE EXCEPTION 'DIAMOND_OWN_HISTORY_MEMBERSHIP_BLOCK_MISSING';
  END IF;
  EXECUTE replace(v_definition, v_before, v_after);
  IF pg_get_functiondef(v_signature) IS DISTINCT FROM replace(v_definition, v_before, v_after) THEN
    RAISE EXCEPTION 'DIAMOND_OWN_HISTORY_POSTIMAGE_CHANGED';
  END IF;
END
$change$;
COMMIT;
