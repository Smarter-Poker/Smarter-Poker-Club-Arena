-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820191802 "spendable_balance_self_or_upline_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b04b8fe565c26f46fd50e444066d92e3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ANY LOGGED-IN PLAYER COULD READ ANY OTHER PLAYER'S CLUB WALLET.
--
-- fn_player_spendable_balance is SECURITY DEFINER, granted to `authenticated`,
-- takes p_user_id, and had no check that the caller is that user. Verified: an
-- unrelated player in the same club read a stranger's balance (23,147.50)
-- straight from the RPC. Every wallet in the platform was enumerable by user id.
--
-- The UI only ever asks for the signed-in user's own balance, so gating to self
-- costs the product nothing. An upline agent and a union overseer are allowed
-- through because they legitimately see their players' chips elsewhere in the
-- product (the roster report and the risk report already show exactly this).
--
-- The guard is inserted after the opening BEGIN, leaving the balance logic
-- untouched, so no authorised caller changes behaviour.

DO $mig$
DECLARE
  v_def text;
  v_pos int;
  v_guard text;
  v_marker text := 'AS $function$';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE proname = 'fn_player_spendable_balance'
     AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_player_spendable_balance not found';
  END IF;

  IF v_def LIKE '%not_authorised%' THEN
    RAISE NOTICE 'already guarded';
    RETURN;
  END IF;

  v_guard :=
    '  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid()'
    || ' AND NOT EXISTS (SELECT 1 FROM club_members cm'
    || '                   WHERE cm.user_id = p_user_id'
    || '                     AND cm.agent_id = auth.uid())'
    || ' AND NOT EXISTS (SELECT 1 FROM club_members cm2'
    || '                   JOIN union_clubs uc ON uc.club_id = cm2.club_id'
    || '                   WHERE cm2.user_id = p_user_id'
    || '                     AND public.fn_is_union_overseer(uc.union_id, auth.uid()))'
    || ' THEN RAISE EXCEPTION ''not_authorised''; END IF;';

  v_pos := position(v_marker in v_def);
  IF v_pos = 0 THEN RAISE EXCEPTION 'body marker not found'; END IF;
  v_pos := v_pos + length(v_marker);
  v_pos := v_pos + position(E'\nBEGIN\n' in substring(v_def from v_pos)) - 1
           + length(E'\nBEGIN\n');

  v_def := substring(v_def from 1 for v_pos - 1)
           || v_guard || E'\n'
           || substring(v_def from v_pos);

  EXECUTE v_def;
  RAISE NOTICE 'fn_player_spendable_balance guarded';
END $mig$;
