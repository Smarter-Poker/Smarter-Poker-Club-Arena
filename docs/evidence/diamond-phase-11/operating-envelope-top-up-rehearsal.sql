-- Rolled-back production rehearsal for 20260930130000_a_diamond_top_up_takes_the_table_before_the_wallet.
-- Run with the estate helper (it strips BEGIN;/COMMIT;, runs migration + this fixture as ONE transaction
-- and passes only on REHEARSAL OK):
--   /Volumes/SmarterWork/agent-work/claude-p11/bin/rehearse.sh <migration> <this file> <agent>
-- Single-session door behaviour only. It writes no row: the door is asked about a table and a player that
-- do not exist, so its new early table lock and its wallet lock find nothing, and it must refuse by name.
SET LOCAL lock_timeout = '2s';
DO $f$
DECLARE v_def text; v_err text := '(none)';
BEGIN
  v_def := pg_get_functiondef('public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)'::regprocedure);
  IF md5(v_def) <> 'f7659bddc424e9e4b6785228ee0eec6a' THEN
    RAISE EXCEPTION 'the top-up is not the text the harness measured: %', md5(v_def);
  END IF;
  IF position('PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;' IN v_def)
     >= position('SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;' IN v_def) THEN
    RAISE EXCEPTION 'the table is not taken before the wallet';
  END IF;
  BEGIN
    PERFORM public.fn_poker_diamond_top_up(gen_random_uuid(), gen_random_uuid(), 1, 0, gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  IF v_err <> 'profile_not_found' THEN
    RAISE EXCEPTION 'the door answered a stranger with %, expected profile_not_found', v_err;
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_poker_diamond_top_up(uuid,uuid,numeric,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the door grants changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'an arena switch is open';
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK: fn_poker_diamond_top_up takes the table before the wallet (md5 f7659bddc424e9e4b6785228ee0eec6a), refuses a stranger by name (%), grants unchanged, both switches closed', v_err;
END $f$;
