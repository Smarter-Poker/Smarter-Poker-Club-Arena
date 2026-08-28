-- THE UNION LAW CHECK FOLLOWS THE MONEY INSTEAD OF GREPPING ONE FUNCTION.
--
-- fn_union_law_selftest has been filing a nightly critical since 2026-08-22:
-- "UNION LAW self-test failed — the law has been clobbered or breached", naming
-- record_tournament_buyin_rake_law_missing and money_path_not_club_scoped for
-- atomic_cancel_tournament and credit_player_wallet.
--
-- All three are FALSE POSITIVES, and that is worse than it sounds. A law alarm
-- that cries wolf every night is a law alarm nobody reads, and this one sits in
-- the same queue as the real breaches it exists to surface.
--
-- WHY THEY FIRE. fn_union_money_path_check asks whether a function's OWN SOURCE
-- contains 'club_members' or 'fn_pay_player_chips'. It looks exactly one level
-- deep, and both functions were since refactored into delegating wrappers:
--
--   credit_player_wallet      -> fn_credit_player_wallet_once -> club_members
--   atomic_cancel_tournament  -> fn_credit_and_log
--                             -> fn_credit_player_wallet_once -> club_members
--
-- The money is club-scoped. The grep cannot see round the corner. It is blind
-- in the dangerous direction too: a wrapper delegating to something NOT
-- club-scoped would pass silently, because the caller contains neither string.
-- Following the chain is strictly stronger, not a relaxation.
--
-- record_tournament_buyin_rake does not exist at all — retired, and the only
-- two references left in the database are this self-test and a name list in
-- fn_union_overload_check. The live tournament buy-in rake path is
-- fn_register_for_tournament and fn_register_horse_for_tournament, both of
-- which split through fn_tournament_entry_split and write club-scoped
-- rake_records. The check names a ghost while the thing it protects is enforced
-- elsewhere.
--
-- The replacement asserts the REAL path for BOTH register functions, which
-- makes HORSES ARE PLAYERS a law-level invariant: if the horse registration
-- path ever stops raking the way the human one does, the union law fails.
--
-- KNOWN LIMIT, INHERITED NOT ADDED: "reaches club scope" is still a source
-- match, so a function that merely MENTIONS club_members in a comment counts.
-- fn_union_money_path_check's own detail text did exactly that, which is how
-- this migration's first negative control tripped. The check being replaced had
-- the identical weakness one level up. Closing it properly needs real
-- call-graph parsing — separate work.
--
-- HOW THIS EDITS THE LAW. fn_union_law_selftest carries seventeen checks.
-- Retyping it to change one risks silently dropping another, so this reads the
-- live definition, does a literal replace of the single stale block, and
-- refuses to proceed if that block is not found or if any other check name goes
-- missing.
--
-- ROLLBACK
--   Re-apply the previous fn_union_money_path_check body, and swap the
--   'tournament_buyin_rake_not_club_scoped' block back for the old
--   'record_tournament_buyin_rake_law_missing' one.

CREATE OR REPLACE FUNCTION public.fn_money_path_reaches_club_scope(
  p_fn text, p_max_depth integer DEFAULT 4)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE walk(fn, depth) AS (
    SELECT p_fn::text COLLATE "C", 0
    UNION
    SELECT callee.proname::text COLLATE "C", w.depth + 1
      FROM walk w
      JOIN pg_proc caller
        ON caller.proname::text COLLATE "C" = w.fn
       AND caller.pronamespace = 'public'::regnamespace
      JOIN pg_proc callee
        ON callee.pronamespace = 'public'::regnamespace
       -- A call, not a coincidental substring: the name must be followed by an
       -- open paren. The length floor keeps very short names from matching
       -- half the schema.
       AND length(callee.proname) > 6
       AND callee.proname::text COLLATE "C" <> w.fn
       AND caller.prosrc LIKE '%' || callee.proname || '(%'
     WHERE w.depth < GREATEST(p_max_depth, 1)
  )
  SELECT EXISTS (
    SELECT 1 FROM walk w
      JOIN pg_proc p ON p.proname::text COLLATE "C" = w.fn
                    AND p.pronamespace = 'public'::regnamespace
     WHERE p.prosrc LIKE '%club_members%'
        OR p.prosrc LIKE '%fn_pay_player_chips%');
$function$;

REVOKE ALL ON FUNCTION public.fn_money_path_reaches_club_scope(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_money_path_reaches_club_scope(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_money_path_check()
RETURNS TABLE(fn text, detail text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT x.fn,
         'money path no longer reaches club scope (directly or through any '
         || 'function it calls, to 4 levels) — club wallets would be commingled'
    FROM (VALUES
            ('atomic_table_buyin'),('atomic_table_cashout'),
            ('atomic_table_rebuy'),('atomic_table_addon'),
            ('atomic_tournament_register'),('atomic_tournament_unregister'),
            ('process_tournament_rebuy'),
            ('credit_player_wallet'),('atomic_cancel_tournament'),
            ('fn_pay_player_chips'),
            ('atomic_pay_player_rakeback'),('credit_player_rakeback'),
            ('atomic_pay_agent_settlement'),
            ('transfer_chips_agent_to_player')
         ) AS x(fn)
   -- A function deleted outright is still a breach; one that exists but cannot
   -- reach club scope is the breach this was written for.
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = x.fn)
      OR NOT public.fn_money_path_reaches_club_scope(x.fn, 4);
$function$;

DO $mig$
DECLARE
  v_src text; v_new text; v_old_block text; v_new_block text; v_check text;
BEGIN
  v_src := pg_get_functiondef('public.fn_union_law_selftest()'::regprocedure);

  v_old_block :=
'  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname=''public'' AND p.proname=''record_tournament_buyin_rake''
                    AND p.prosrc LIKE ''%UNION LAW%'' AND p.prosrc LIKE ''%v_is_private%'') THEN
    v_breaches := v_breaches || jsonb_build_object(''check'',''record_tournament_buyin_rake_law_missing'');
  END IF;';

  v_new_block :=
'  IF EXISTS (SELECT 1 FROM (VALUES (''fn_register_for_tournament''),(''fn_register_horse_for_tournament'')) AS r(fn)
              WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                 WHERE n.nspname=''public'' AND p.proname=r.fn
                                   AND p.prosrc LIKE ''%rake_records%''
                                   AND p.prosrc LIKE ''%fn_tournament_entry_split%'')) THEN
    v_breaches := v_breaches || jsonb_build_object(''check'',''tournament_buyin_rake_not_club_scoped'');
  END IF;';

  IF position(v_old_block IN v_src) = 0 THEN
    RAISE EXCEPTION 'the record_tournament_buyin_rake block was not found verbatim; refusing to edit the law blind';
  END IF;

  v_new := replace(v_src, v_old_block, v_new_block);

  FOREACH v_check IN ARRAY ARRAY[
    'atomic_distribute_rake_law_missing','fn_resolve_bbj_pool_law_missing',
    'record_rake_delegation_missing','table_stamp_house_club_fallback_missing',
    'tournament_stamp_house_club_fallback_missing','house_club_games_unstamped',
    'money_path_not_club_scoped','chip_supply_monitor_blind_to_club_wallets',
    'required_trigger_missing','required_cron_missing','oversight_policy_missing',
    'club_table_rls_disabled','club_view_not_security_invoker',
    'live_games_in_member_club_lobby','private_rows_union_stamped',
    'seats_without_provenance']
  LOOP
    IF position(v_check IN v_new) = 0 THEN
      RAISE EXCEPTION 'check % was lost by the edit', v_check;
    END IF;
  END LOOP;

  EXECUTE v_new;
END
$mig$;

DO $post$
DECLARE v_res jsonb;
BEGIN
  IF NOT public.fn_money_path_reaches_club_scope('credit_player_wallet', 4) THEN
    RAISE EXCEPTION 'credit_player_wallet still reads as not club-scoped';
  END IF;
  IF NOT public.fn_money_path_reaches_club_scope('atomic_cancel_tournament', 4) THEN
    RAISE EXCEPTION 'atomic_cancel_tournament still reads as not club-scoped';
  END IF;
  -- ...and must still say NO. fn_place_entitlement is pure jsonb arithmetic:
  -- it calls nothing and names no wallet, so a walk that returns true for it is
  -- returning true for anything.
  IF public.fn_money_path_reaches_club_scope('fn_place_entitlement', 4) THEN
    RAISE EXCEPTION 'the walk returns true for a pure function; it is not discriminating';
  END IF;

  v_res := public.fn_union_law_selftest();
  IF (v_res->>'healthy')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'UNION LAW self-test still failing after the fix: %', v_res->'breaches';
  END IF;
END
$post$;
