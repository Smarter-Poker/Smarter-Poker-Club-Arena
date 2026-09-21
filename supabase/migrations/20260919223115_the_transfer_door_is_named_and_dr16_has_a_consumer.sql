-- 20260919223115_the_transfer_door_is_named_and_dr16_has_a_consumer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (fn_ca_diamond_unreachable_money(), the E2 audit item;
-- docs/DIAMOND-RULINGS.md rulings 4 and 14; CLAUDE.md 10.86;
-- docs/changelog/2026-09-19-the-health-watch-resolves-what-it-filed.md):
--
--   fn_ca_diamond_unreachable_money() reports two findings, and fn_ca_diamond_health()
--   has read "attention" on them since the detector was written. Both were read against
--   the live catalog on 2026-09-19 and both are true.
--
--   A. send_wallet_diamond_transfer(uuid,integer,text,text) is client_reachable_but_guard_refuses.
--      Ruling 4 (amended by Dan 2026-09-08) allows player-to-player wallet transfers through
--      one atomic, authenticated, journaled path, and 20260909200327 restored exactly that:
--      the route locks both profiles, requires an accepted friendship and a live session,
--      applies the gift cap, journals both legs, retires recipient debt and writes both
--      wallets itself, all in one transaction, granted to authenticated and to nobody
--      else. It runs under the SENDER'S JWT. fn_guard_profile_privileged_columns refuses
--      any write to profiles.diamonds that is neither service-role nor made from a call
--      stack naming a listed money RPC, and this route is not listed. So every transfer a
--      player has attempted since 09-09 has answered 42501 at the first wallet UPDATE and
--      rolled back. Read 2026-09-19: diamond_wallet_transfers holds 0 rows, ever, and
--      diamond_transactions holds 0 rows under source 'wallet_diamond_transfer'. That is
--      the send_stream_gift shape the detector was written to catch, and the isolated
--      transfer fixture never saw it because the fixture carries no profile guard.
--
--      The guard's own contract ("a call stack naming a whitelisted money RPC", written on
--      it in 20260907234547) says what the fix is: name the route. The route qualifies on
--      exactly the standard the list enforces: SECURITY DEFINER, its amount comes from a
--      request the database re-validates, both legs are journaled before the wallets move,
--      and a browser cannot reach the wallet without it. One line is added to the guard by
--      marker against the live body, the way 20260918230314 admitted fn_wheel_spin_v2, with
--      the route's own md5 pinned so that a route which changed underneath is re-read
--      before the guard admits it.
--
--   B. DR16:deposit_inside_settlement_window is rule_with_no_consumer, and the daily arming
--      sweep will try to arm it on 2026-09-22 and be blocked by "no function consults this
--      rule". Its consumer was fn_arena_deposit (20260908034530), which the custody model
--      replaced: today's deposit door is fn_poker_diamond_reserve, which every buy-in and
--      tournament entry passes through, and it ALREADY enforces ruling 14 under another
--      name. It sums every purchased lot that is frozen or younger than
--      ca_arena_settings.settlement_window_days and raises insufficient_settled_diamonds
--      when the wallet minus those lots cannot cover the amount (20260909065458, live
--      since Phase 3; fn_poker_diamond_top_up carries the same refusal for a seat that is
--      already sitting).
--
--      That refusal is structural, not a policy switch: the lot reservation that follows it
--      draws only on settled lots, so an unsettled lot admitted "in log mode" would sit in
--      custody with no lot reservation behind it and nothing for a chargeback to find.
--      Loosening it to honour 'log' would therefore open a real hole, and ruling 14 says
--      "not depositable". So the rule is consumed the way DR15 is (20260908041432): the
--      door READS its mode so the rule has a consumer and a flip means something, and the
--      refusal stands in both modes. What the mode changes is how the refusal is reported.
--      In 'log' mode the raise is today's, byte for byte. In 'refuse' mode the same
--      refusal is raised under the rule's own code P0416 with a DETAIL naming the rule, the
--      unsettled amount and the window, so the Postgres log counts it under DR16. A
--      refusal cannot file an incident that survives its own raise (20260906102549), so
--      the evidence rides in the error itself. The message keeps its leading token,
--      insufficient_settled_diamonds, which is what the engine and the client match on.
--      The refusal is only attributed to DR16 when it IS the settlement window that
--      refuses: a wallet that could not cover the amount even with every lot settled is
--      plain insufficiency and is raised exactly as before in either mode.
--
--   fn_guard_profile_privileged_columns and fn_poker_diamond_reserve are both on
--   fn_ca_guard_watchlist(); each redefinition is declared through the estate's own door
--   in this transaction so the hourly hash watcher has nothing to report. Grants are not
--   touched: both are re-created from their own pg_get_functiondef, which keeps owner,
--   ACL, security and search_path. The migration then reads the detector and refuses to
--   commit if either finding is still listed.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- A. The guard names the transfer door.
-- ---------------------------------------------------------------------------
DO $name_the_door$
DECLARE
  v_before text; v_after text; v_route text;
  v_old CONSTANT text := $old$     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'$old$;
  v_new CONSTANT text := $new$     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'
     -- RULING 4 (amended 2026-09-08): the player-to-player wallet transfer. It runs under the
     -- sender's JWT, journals both legs and writes both wallets itself, and it is the one
     -- authenticated door for a transfer; unnamed here it answered 42501 to every player.
     OR v_stack ~ 'function (public[.])?send_wallet_diamond_transfer[(]'$new$;
  v_hits integer;
BEGIN
  IF to_regprocedure('public.send_wallet_diamond_transfer(uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'send_wallet_diamond_transfer(uuid,integer,text,text) does not exist';
  END IF;
  v_route := pg_get_functiondef('public.send_wallet_diamond_transfer(uuid,integer,text,text)'::regprocedure);
  -- The route the guard is about to admit is the one that was reviewed: journaled both legs,
  -- live session required, granted to authenticated and not to anon.
  IF md5(v_route) <> '8d5b95d8ad2a74c1ba85339168349606'
     OR position('fn_caller_session_is_live()' in v_route) = 0
     OR position('''diamond_gift_sent''' in v_route) = 0
     OR position('''diamond_gift_received''' in v_route) = 0
     OR NOT has_function_privilege('authenticated', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.send_wallet_diamond_transfer(uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'send_wallet_diamond_transfer changed or its grants moved; review it before the guard admits it';
  END IF;

  SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_before;
  IF md5(v_before) <> '43896e9aebd9df49151a0e92799f9598' THEN
    RAISE EXCEPTION 'fn_guard_profile_privileged_columns changed (md5 %); re-read it before extending it', md5(v_before);
  END IF;
  IF position('send_wallet_diamond_transfer' in v_before) > 0 THEN
    RAISE EXCEPTION 'the guard already names send_wallet_diamond_transfer';
  END IF;
  v_hits := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'guard marker found % time(s), expected 1', v_hits;
  END IF;

  EXECUTE replace(v_before, v_old, v_new);

  SELECT pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure) INTO v_after;
  IF replace(v_after, v_new, v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'unrelated profile guard text changed';
  END IF;
  IF position('send_wallet_diamond_transfer[(]' in v_after) = 0 THEN
    RAISE EXCEPTION 'the guard does not name the transfer door the way the detector reads it';
  END IF;
  -- Still a trigger function nobody can call directly.
  IF has_function_privilege('anon', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_guard_profile_privileged_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the profile guard became executable by anon or authenticated';
  END IF;
  -- Nested rather than one AND: plpgsql prepares a whole IF expression before it evaluates
  -- it, so a database with no watchlist would fail at the parse, not at the check.
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NOT NULL THEN
    IF 'fn_guard_profile_privileged_columns' = ANY (public.fn_ca_guard_watchlist()) THEN
      PERFORM public.fn_ca_declare_guard_redefinition('fn_guard_profile_privileged_columns',
        'migration 20260919223115_the_transfer_door_is_named_and_dr16_has_a_consumer');
    END IF;
  END IF;
END $name_the_door$;

-- ---------------------------------------------------------------------------
-- B. The deposit door reads DR16. The refusal stands; the mode decides its report.
-- ---------------------------------------------------------------------------
DO $dr16_has_a_consumer$
DECLARE
  v_before text; v_after text;
  v_old CONSTANT text := $old$ IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN RAISE EXCEPTION 'insufficient_settled_diamonds'; END IF;$old$;
  v_new CONSTANT text := $new$ IF v_wallet IS NULL OR v_wallet-v_locked<p_amount THEN
   -- RULING 14 / DR16. A lot frozen or younger than the settlement window is not depositable,
   -- and this door has refused it by this name since Phase 3. The rule mode is READ here so
   -- DR16 has a consumer and a flip means something (the DR15 shape, 20260908041432). The
   -- refusal stands in both modes: the lot reservation below draws only on settled lots, so
   -- an unsettled lot admitted here would sit in custody with nothing for a chargeback to
   -- find. Armed, the same refusal is raised under the rule's own code with the numbers in
   -- its DETAIL; a raise cannot file an incident that survives it (20260906102549), so the
   -- evidence rides in the error, where the Postgres log counts it. The leading token is
   -- what the engine and the client match on and does not change.
   IF v_locked>0 AND v_wallet IS NOT NULL AND v_wallet>=p_amount
      AND public.fn_ca_diamond_rule_mode('DR16:deposit_inside_settlement_window')='refuse' THEN
     RAISE EXCEPTION 'insufficient_settled_diamonds' USING ERRCODE='P0416',
       DETAIL=format('DR16:deposit_inside_settlement_window refused %s: %s purchased diamond(s) frozen or inside the %s-day settlement window; %s settled',
                     p_amount, v_locked, v_days, v_wallet-v_locked);
   END IF;
   RAISE EXCEPTION 'insufficient_settled_diamonds';
 END IF;$new$;
  v_hits integer;
BEGIN
  IF to_regprocedure('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid) does not exist';
  END IF;
  IF to_regprocedure('public.fn_ca_diamond_rule_mode(text)') IS NULL THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_mode(text) does not exist; there is nothing to consult';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR16:deposit_inside_settlement_window') THEN
    RAISE EXCEPTION 'ca_diamond_rule_modes has no DR16:deposit_inside_settlement_window row';
  END IF;

  SELECT pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure) INTO v_before;
  IF md5(v_before) <> 'a1ccc4bc9a5c6d8d17308e93943a9413' THEN
    RAISE EXCEPTION 'fn_poker_diamond_reserve changed (md5 %); re-read it before wiring DR16 into it', md5(v_before);
  END IF;
  IF position('DR16' in v_before) > 0 THEN
    RAISE EXCEPTION 'fn_poker_diamond_reserve already consults DR16';
  END IF;
  v_hits := (length(v_before) - length(replace(v_before, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'reserve marker found % time(s), expected 1', v_hits;
  END IF;

  EXECUTE replace(v_before, v_old, v_new);

  SELECT pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure) INTO v_after;
  IF replace(v_after, v_new, v_old) IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'unrelated reserve text changed';
  END IF;
  -- The literal call the detector and the flip door look for.
  IF position('fn_ca_diamond_rule_mode(''DR16:deposit_inside_settlement_window'')' in v_after) = 0 THEN
    RAISE EXCEPTION 'the reserve does not consult DR16 by its literal name';
  END IF;
  -- The refusal is still raised in every branch: twice now, once coded and once plain.
  IF (length(v_after) - length(replace(v_after, 'RAISE EXCEPTION ''insufficient_settled_diamonds''', '')))
       / length('RAISE EXCEPTION ''insufficient_settled_diamonds''') <> 2 THEN
    RAISE EXCEPTION 'the settlement refusal is not raised in both branches';
  END IF;
  -- Everything else the door refuses is still there.
  IF position('diamond_debt_requires_settlement' in v_after) = 0
     OR position('diamond_tournaments_not_open' in v_after) = 0
     OR position('invalid_diamond_table_buy_in' in v_after) = 0
     OR position('diamond_asset_required' in v_after) = 0
     OR position('created_at<=now()-make_interval(days=>v_days)' in v_after) = 0 THEN
    RAISE EXCEPTION 'the reserve lost a refusal or its settled-lot reservation';
  END IF;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_poker_diamond_reserve became executable by anon or authenticated';
  END IF;
  -- Nested rather than one AND: plpgsql prepares a whole IF expression before it evaluates
  -- it, so a database with no watchlist would fail at the parse, not at the check.
  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NOT NULL THEN
    IF 'fn_poker_diamond_reserve' = ANY (public.fn_ca_guard_watchlist()) THEN
      PERFORM public.fn_ca_declare_guard_redefinition('fn_poker_diamond_reserve',
        'migration 20260919223115_the_transfer_door_is_named_and_dr16_has_a_consumer');
    END IF;
  END IF;
END $dr16_has_a_consumer$;

-- ---------------------------------------------------------------------------
-- C. THE DETECTOR NO LONGER LISTS EITHER, read from the catalog rather than assumed,
--    and the guard baselines sit exactly on the installed text.
-- ---------------------------------------------------------------------------
DO $read_the_detector$
DECLARE v_row record; v_name text; v_hash text;
BEGIN
  IF to_regprocedure('public.fn_ca_diamond_unreachable_money()') IS NOT NULL THEN
    FOR v_row IN SELECT * FROM public.fn_ca_diamond_unreachable_money() LOOP
      IF v_row.object LIKE 'send_wallet_diamond_transfer(%' THEN
        RAISE EXCEPTION 'the detector still lists send_wallet_diamond_transfer: %', v_row.finding;
      END IF;
      IF v_row.object = 'DR16:deposit_inside_settlement_window' THEN
        RAISE EXCEPTION 'the detector still lists DR16 as %', v_row.finding;
      END IF;
    END LOOP;
  ELSE
    RAISE NOTICE 'no fn_ca_diamond_unreachable_money in this database; the detector read is skipped';
  END IF;

  IF to_regprocedure('public.fn_ca_guard_watchlist()') IS NOT NULL AND to_regclass('public.ca_guard_defs') IS NOT NULL THEN
    FOREACH v_name IN ARRAY ARRAY['fn_guard_profile_privileged_columns', 'fn_poker_diamond_reserve'] LOOP
      IF v_name = ANY (public.fn_ca_guard_watchlist()) THEN
        SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) INTO v_hash
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname = v_name) IS DISTINCT FROM v_hash THEN
          RAISE EXCEPTION '% is off its guard baseline after this migration', v_name;
        END IF;
      END IF;
    END LOOP;
  END IF;
END $read_the_detector$;

COMMIT;
