-- 20261019020459_horses_spin_diamond_spins_through_the_engine_door
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 02:04:59 UTC.
--
-- OWNER REQUEST (Dan, 2026-10-18): every horse plays the Club Arena and the
-- Diamond Arena; "a horse with no chips left grinds the Diamond Arena and uses
-- its Diamonds on Diamond Spins to convert to chips". Phase 3 of that build:
-- a horse-only Diamond Spins door for the game engine, so a horse spins its
-- Diamonds into chips through the same wheel and bonus games a person uses.
--
-- WHAT WAS MISSING. Every Diamond Spins door - fn_wheel_commit,
-- fn_wheel_spin_v2, fn_wheel_bonus_start, fn_choice_act, fn_crash_cashout,
-- fn_crash_settle, fn_wheel_diamond_cards_pick and the games' own commits -
-- names its player with auth.uid() and nothing else. A horse has no browser
-- and no session, so the wheel sat behind a door only a browser could open.
-- The rule that horses may spin was true; the door made it unreachable
-- (the same shape tests/a-horse-is-not-test-equipment.law.test.ts records for
-- the daily bonus).
--
-- WHAT THIS ADDS, and why it is ONE door rather than ten edited functions.
-- public.fn_horse_diamond_spins(p_horse_id, p_action, p_args) is the horse's
-- input device (CLAUDE.md 10.5, the second permitted use of is_horse). It:
--
--   1. opens only for the engine: fn_caller_is_engine(), and EXECUTE is held
--      by service_role alone. A browser can never reach it;
--   2. acts only for a horse: profiles.is_horse must be TRUE for the player
--      named, so it can never be used to play as a person;
--   3. names that horse as the caller for the length of ONE call, by the same
--      transaction-local request.jwt claims PostgREST sets for a signed-in
--      player, then puts the engine's own claims back before it returns;
--   4. calls the EXACT public function the Diamond Spins page calls, from a
--      fixed allow-list, with the arguments the page sends.
--
-- So there is no second copy of the wheel. The prize table, the seeds, the
-- 25..2500 entry range, membership, fixture and owner-terms checks, the
-- per-day and per-second limits, the bonus-game queue, the pools, the caps,
-- the ledger legs and the platform freeze are every one the person's own code,
-- because the person's own function is what runs. Editing the ten doors to
-- take an engine-named player instead would have put the identity check in
-- ten places, each free to drift; this keeps the wheel byte-for-byte as it is
-- and the identity decision in one body a law test can read.
--
-- WHAT IT DOES NOT DO. It decides nothing: not when a horse is broke, not how
-- much it spins, not which bonus-game moves it makes. That is the engine's
-- (the fleet that drives horses), as it is the browser's for a person. It
-- moves no money itself and writes no balance column (the registry guard
-- fn_ca_money_rpc_registry_guard reads exactly that); every Diamond and chip
-- it causes to move moves inside the person's own registered money function.
-- It creates no table, no cron and no repair path (10.12).
--
-- MEASURED, ROLLED BACK (11.5 rule 1, one self-aborting DO block per call),
-- 2026-10-19 02:00-02:03 UTC, through the person functions under the claims
-- this door sets, before this file existed:
--   horse 93ecbb64-e602-47f1-a314-056504d6b3be at Club JAQK (Midway Union host)
--   fn_wheel_commit -> ok; fn_wheel_spin_v2 100 Diamonds, paid, wheel-v4:
--   Diamonds 113,415 -> 113,315, chips 3,440.35 -> 3,440.60 (0.25x Chips,
--   value 1 chip at 100 Diamonds per chip), receipt identical in shape to a
--   person's (vip, pool, fairness with server seed, segments, balances).
--   Another rolled-back spin landed Diamond Mines, and the spin after it was
--   refused "Finish Your Bonus Game Before Another Spin" - the person's queue
--   rule, applied to the horse unchanged.
--   A suspended horse membership was refused "Join The Club Before You Spin".
--
-- THEN THROUGH THIS DOOR'S EXACT BODY, created in pg_temp inside the same
-- rolled-back call (11.5 rule 4; no public DDL), 02:07-02:09 UTC:
--   a person (not a horse) -> "Only A Horse Spins Through This Door";
--   an unknown action -> "Unknown Diamond Spins Action";
--   a browser caller (claims role authenticated) -> 42501, refused;
--   paid spin, 100 Diamonds -> 1x Chips: Diamonds 113,415 -> 113,315,
--     chips 3,455.35 -> 3,456.35;
--   a second spin in the same second -> "One Moment Between Spins" (the
--     person's three-second rule, unchanged);
--   a spin that landed Donkey Cross -> game commit -> bonus start ok, round
--     sealed with its prize ladder and proof;
--   a spin that landed Diamond Crash -> game commit -> bonus start ok, round
--     open on the server clock, exactly as a person's round is;
--   after every call auth.uid() was NULL again and fn_caller_is_engine() true:
--     the engine's identity was back.
-- Read afterwards: the horse held 113,415 Diamonds and had no spin, award or
-- seed commit in the last two hours. Every probe ended in RAISE EXCEPTION;
-- nothing committed.
--
-- @live-proof: to_regprocedure('public.fn_horse_diamond_spins(uuid,text,jsonb)') IS NOT NULL
-- @live-proof: (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.fn_horse_diamond_spins(uuid,text,jsonb)'))
-- @live-proof: NOT has_function_privilege('authenticated', 'public.fn_horse_diamond_spins(uuid,text,jsonb)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_horse_diamond_spins(uuid,text,jsonb)', 'EXECUTE')
-- @live-proof: has_function_privilege('service_role', 'public.fn_horse_diamond_spins(uuid,text,jsonb)', 'EXECUTE')
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- The door delegates to these exact signatures. If one has been renamed or
-- re-shaped since this was written, refuse to install rather than ship a door
-- that answers "function does not exist" to the engine at play time.
DO $guard$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_caller_is_engine()',
    'public.fn_wheel_state_v2(uuid,integer)',
    'public.fn_wheel_commit()',
    'public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)',
    'public.fn_diamond_game_commit(text)',
    'public.fn_wheel_bonus_state(uuid,text,boolean,text,uuid)',
    'public.fn_wheel_bonus_start(uuid,uuid,text,boolean,text,integer,integer,integer,integer)',
    'public.fn_choice_state(uuid,text,text,integer)',
    'public.fn_choice_act(uuid,text,integer,integer)',
    'public.fn_crash_cashout(uuid,integer)',
    'public.fn_crash_settle(uuid,boolean)',
    'public.fn_wheel_diamond_cards_pick(uuid,smallint)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'The Diamond Spins door % this migration delegates to is not installed', v_sig;
    END IF;
  END LOOP;
END $guard$;

CREATE FUNCTION public.fn_horse_diamond_spins(
  p_horse_id uuid,
  p_action text,
  p_args jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  a jsonb := COALESCE(p_args, '{}'::jsonb);
  v_prior_claims text := current_setting('request.jwt.claims', true);
  v_prior_sub text := current_setting('request.jwt.claim.sub', true);
  v_prior_role text := current_setting('request.jwt.claim.role', true);
  v_result jsonb;
BEGIN
  -- 1. THE ENGINE'S DOOR. service_role (or no request context at all) only.
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'fn_horse_diamond_spins is the engine''s door' USING ERRCODE = '42501';
  END IF;

  -- 2. A HORSE, AND ONLY A HORSE. This door never plays as a person.
  IF p_horse_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = p_horse_id AND p.is_horse IS TRUE) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only A Horse Spins Through This Door');
  END IF;

  IF p_action IS NULL OR p_action NOT IN (
       'wheel_state', 'wheel_commit', 'wheel_spin',
       'game_commit', 'bonus_state', 'bonus_start',
       'choice_state', 'choice_act',
       'crash_cashout', 'crash_settle',
       'cards_pick') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown Diamond Spins Action');
  END IF;

  -- 3. THE HORSE IS THE CALLER FOR THIS ONE CALL, exactly as PostgREST names a
  --    signed-in player. Transaction-local, and restored below.
  PERFORM set_config('request.jwt.claims',
                     jsonb_build_object('sub', p_horse_id, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_horse_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  -- 4. THE PERSON'S OWN FUNCTION, WITH THE ARGUMENTS THE PAGE SENDS.
  CASE p_action
    WHEN 'wheel_state' THEN
      v_result := public.fn_wheel_state_v2(
        (a->>'club_id')::uuid, COALESCE((a->>'entry_diamonds')::integer, 100));
    WHEN 'wheel_commit' THEN
      v_result := public.fn_wheel_commit();
    WHEN 'wheel_spin' THEN
      v_result := public.fn_wheel_spin_v2(
        (a->>'club_id')::uuid, (a->>'commit_id')::uuid, a->>'client_seed',
        (a->>'entry_diamonds')::integer, COALESCE(a->>'mode', 'paid'),
        (a->>'bonus_ticket_id')::uuid);
    WHEN 'game_commit' THEN
      v_result := public.fn_diamond_game_commit(a->>'game');
    WHEN 'bonus_state' THEN
      v_result := public.fn_wheel_bonus_state(
        (a->>'club_id')::uuid, a->>'game', COALESCE((a->>'double')::boolean, false),
        a->>'mode', (a->>'award_id')::uuid);
    WHEN 'bonus_start' THEN
      v_result := public.fn_wheel_bonus_start(
        (a->>'award_id')::uuid, (a->>'commit_id')::uuid, a->>'client_seed',
        COALESCE((a->>'double')::boolean, false), a->>'mode',
        (a->>'denom')::integer, (a->>'table_version')::integer,
        (a->>'auto_cashout_cents')::integer, (a->>'max_steps')::integer);
    WHEN 'choice_state' THEN
      v_result := public.fn_choice_state(
        (a->>'club_id')::uuid, a->>'game', a->>'mode', (a->>'bet')::integer);
    WHEN 'choice_act' THEN
      v_result := public.fn_choice_act(
        (a->>'round_id')::uuid, a->>'action', (a->>'cell')::integer,
        (a->>'expected_step')::integer);
    WHEN 'crash_cashout' THEN
      v_result := public.fn_crash_cashout(
        (a->>'round_id')::uuid, (a->>'multiplier_cents')::integer);
    WHEN 'crash_settle' THEN
      v_result := public.fn_crash_settle(
        (a->>'round_id')::uuid, COALESCE((a->>'cashout')::boolean, false));
    WHEN 'cards_pick' THEN
      v_result := public.fn_wheel_diamond_cards_pick(
        (a->>'award_id')::uuid, (a->>'card')::smallint);
  END CASE;

  -- The engine's own identity comes back before anything else runs in its
  -- transaction. An exception above aborts the call, and the transaction-local
  -- claims go with it.
  PERFORM set_config('request.jwt.claims', COALESCE(v_prior_claims, ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_prior_sub, ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_prior_role, ''), true);

  RETURN v_result;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_horse_diamond_spins(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_diamond_spins(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.fn_horse_diamond_spins(uuid, text, jsonb) IS
  'The horse''s Diamond Spins input device (CLAUDE.md 10.5). Engine only, horse only. Names the horse as caller for one call and runs the exact public Diamond Spins function a person''s page calls. Moves no money itself. 20261019020459.';

-- Read back what was installed, in the same transaction.
DO $readback$
DECLARE
  v_oid oid := to_regprocedure('public.fn_horse_diamond_spins(uuid,text,jsonb)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_horse_diamond_spins was not created';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'fn_horse_diamond_spins must be SECURITY DEFINER';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_horse_diamond_spins must not be reachable from a browser';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_horse_diamond_spins must be reachable by the engine';
  END IF;
END $readback$;

COMMIT;
