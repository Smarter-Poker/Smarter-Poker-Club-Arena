-- 20261006032934_owner_stats_keeps_mystery_bounty_truth.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The exact-club owner Stats RPC already emits the tournament ledger's mystery
-- bounty flag, knockout count, complete buy-in and prize-plus-bounty total. The
-- all-clubs owner facade rebuilt recent_tournaments without those four fields.
-- The client then normalized the missing values to false/zero and could show a
-- mystery-bounty cash as a loss. This changes only that one projection in the
-- latest installed function; headline and analysis-hand coverage are untouched.
--
-- The preimage is the exact body installed by
-- 20261003132118_stats_preserve_authorized_club_scope. The replacement refuses
-- source drift, requires its anchor exactly once, and proves the postimage while
-- preserving owner, ACL, SECURITY DEFINER, volatility and pinned search_path.
--
-- @live-proof: (SELECT md5(p.prosrc) = '9e5167ac7815b7dcb8469ac51238242e' AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 's' AND p.proconfig::text = '{search_path=public}' AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure)
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $owner_stats_mystery_bounty$
DECLARE
  v_sig regprocedure := 'public.ca_player_stats_overview_v2(uuid,integer,text,text)'::regprocedure;
  v_body text;
  v_definition text;
  v_replaced text;
  v_occurrences integer;
  v_owner oid;
  v_acl text;
  v_security_definer boolean;
  v_volatility "char";
  v_parallel "char";
  v_config text;
  v_old constant text := $old$  WITH tr AS (
    SELECT tp.tournament_id,t.name,t.start_time,t.ended_at,t.variant,tp.position,tp.status,
      coalesce(tp.prize,0) prize,coalesce(tp.bounty_winnings,0) bounty_winnings
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
    ORDER BY t.ended_at DESC LIMIT 25
  ) SELECT coalesce(jsonb_agg(to_jsonb(tr) ORDER BY ended_at DESC),'[]'::jsonb) INTO v_recent FROM tr;$old$;
  v_new constant text := $new$  WITH tr AS (
    SELECT tp.tournament_id,t.name,t.start_time,t.ended_at,t.variant,
      coalesce(t.is_mystery_bounty,false) is_mystery_bounty,tp.position,tp.status,
      coalesce(tp.prize,0) prize,coalesce(tp.bounty_winnings,0) bounty_winnings,
      coalesce(tp.bounties_collected,0) bounties,
      coalesce(tp.prize,0)+coalesce(tp.bounty_winnings,0) total_won,
      coalesce(t.buy_in_amount,0)+coalesce(t.buy_in_fee,0)
        +coalesce(tp.rebuys,0)*coalesce(t.rebuy_cost,0)
        +CASE WHEN tp.add_on THEN coalesce(t.addon_cost,0) ELSE 0 END buyin
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
    JOIN public.clubs c ON c.id=t.club_id
    WHERE tp.user_id=p_user AND coalesce(c.asset,'chips')=p_asset
      AND upper(coalesce(t.status,''))='COMPLETED' AND t.ended_at IS NOT NULL
      AND (v_from IS NULL OR t.ended_at>=v_from) AND (v_to IS NULL OR t.ended_at<v_to)
    ORDER BY t.ended_at DESC LIMIT 25
  ) SELECT coalesce(jsonb_agg(to_jsonb(tr) ORDER BY ended_at DESC),'[]'::jsonb) INTO v_recent FROM tr;$new$;
BEGIN
  SELECT p.prosrc, pg_get_functiondef(p.oid), p.proowner, p.proacl::text,
         p.prosecdef, p.provolatile, p.proparallel, p.proconfig::text
    INTO STRICT v_body, v_definition, v_owner, v_acl,
                v_security_definer, v_volatility, v_parallel, v_config
    FROM pg_proc p
   WHERE p.oid = v_sig;

  IF md5(v_body) <> 'bd728d2f93005ced4b50693985febec2'
     OR md5(v_definition) <> 'e72c0a6a917eb81e79ac5a7043a9db14'
     OR v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'
     OR pg_get_userbyid(v_owner) <> 'postgres'
     OR NOT v_security_definer
     OR v_volatility <> 's'
     OR v_config IS DISTINCT FROM '{search_path=public}'
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'OWNER_STATS_MYSTERY_BOUNTY_PREIMAGE_DRIFT: %', v_sig;
  END IF;

  v_occurrences := (length(v_definition) - length(replace(v_definition, v_old, '')))
                   / length(v_old);
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'OWNER_STATS_MYSTERY_BOUNTY_ANCHOR_COUNT: expected 1, found %',
      v_occurrences;
  END IF;

  v_replaced := replace(v_definition, v_old, v_new);
  EXECUTE v_replaced;

  SELECT p.prosrc
    INTO STRICT v_body
    FROM pg_proc p
   WHERE p.oid = v_sig
     AND p.proowner = v_owner
     AND p.proacl::text IS NOT DISTINCT FROM v_acl
     AND p.prosecdef = v_security_definer
     AND p.provolatile = v_volatility
     AND p.proparallel = v_parallel
     AND p.proconfig::text IS NOT DISTINCT FROM v_config;

  IF md5(v_body) <> '9e5167ac7815b7dcb8469ac51238242e'
     OR position('coalesce(t.is_mystery_bounty,false) is_mystery_bounty' in v_body) = 0
     OR position('coalesce(tp.bounties_collected,0) bounties' in v_body) = 0
     OR position('coalesce(tp.prize,0)+coalesce(tp.bounty_winnings,0) total_won' in v_body) = 0
     OR position('CASE WHEN tp.add_on THEN coalesce(t.addon_cost,0) ELSE 0 END buyin' in v_body) = 0 THEN
    RAISE EXCEPTION 'OWNER_STATS_MYSTERY_BOUNTY_POSTIMAGE_DRIFT: %', v_sig;
  END IF;
END
$owner_stats_mystery_bounty$;

COMMIT;
