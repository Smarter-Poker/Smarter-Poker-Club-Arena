-- Isolated fixture for tests/sql/run-diamond-transfer-door-and-dr16.py, loaded
-- on top of the Phase 3 custody fixture and the Phase 4 wallet transfer chain.
-- Never connects to production. fn_guard_profile_privileged_columns,
-- fn_is_service_context and fn_ca_diamond_unreachable_money are the EXACT
-- production definitions captured read-only on 2026-09-19 (the guard's
-- pg_get_functiondef md5 is 43896e9aebd9df49151a0e92799f9598, which the
-- migration pins), so a fixture that drifts fails the load instead of
-- certifying something the estate does not run. The guard is attached to
-- profiles exactly as production attaches it, which is what the Phase 4
-- transfer fixture never did, and why it passed while every real transfer
-- answered 42501.
\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'poker_diamond_transfer_door_test' OR inet_server_addr() IS NOT NULL
 OR current_setting('port')<>'55472' THEN RAISE EXCEPTION 'isolated transfer door fixture only'; END IF;
END $$;

-- The guard reads every privileged column; the custody fixture's profiles carries only the money ones.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_vip boolean, ADD COLUMN IF NOT EXISTS vip_tier text,
 ADD COLUMN IF NOT EXISTS vip_expires_at timestamptz;
-- The tournament branch of the live reserve reads these; the cash branch under test does not.
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS union_id uuid;

-- Rule modes as a table, so DR16 can be flipped by the runner. Every other rule keeps the
-- custody fixture's answer ('refuse'), which the production wallet fixture's DR6 audit relies on.
CREATE TABLE public.ca_diamond_rule_modes(rule text PRIMARY KEY, mode text NOT NULL DEFAULT 'log',
 flip_after timestamptz, clean_days_required integer, ruling text);
INSERT INTO public.ca_diamond_rule_modes(rule,mode,flip_after,clean_days_required,ruling)
 VALUES('DR16:deposit_inside_settlement_window','log','2026-09-22 00:00:00+00',7,'14');
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_mode(p_rule text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT m.mode FROM public.ca_diamond_rule_modes m WHERE m.rule=p_rule),'refuse') $$;

-- Exact deployed service-context reader (2026-09-19).
CREATE OR REPLACE FUNCTION public.fn_is_service_context()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
    v_raw_claims text;
    v_jwt_role   text;
BEGIN
    v_raw_claims := current_setting('request.jwt.claims', true);

    IF v_raw_claims IS NOT NULL
       AND btrim(v_raw_claims) <> ''
       AND btrim(v_raw_claims) <> 'null'
    THEN
        BEGIN
            v_jwt_role := v_raw_claims::jsonb ->> 'role';
        EXCEPTION WHEN others THEN
            -- Unparseable claims: fail CLOSED. A malformed JWT must never be
            -- mistaken for "no JWT".
            RETURN false;
        END;

        RETURN v_jwt_role = 'service_role';
    END IF;

    -- No JWT context.
    IF current_user IN ('anon', 'authenticated') THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$function$;

-- ---- exact production definitions follow ----
CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed text;
  v_stack text;
BEGIN
  IF public.fn_is_service_context() THEN RETURN NEW; END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  IF v_stack ~ 'function (public[.])?deduct_diamonds[(]'
     OR v_stack ~ 'function (public[.])?fn_union_send_to_member[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenge[(]'
     OR v_stack ~ 'function (public[.])?claim_daily_challenges[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_claim[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_daily_bonus_boost_extra[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_plinko_drop[(]'
     OR v_stack ~ 'function (public[.])?fn_crash_start[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_game_take_bet[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_core[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_spin_v2[(]'
     OR v_stack ~ 'function (public[.])?fn_diamond_bonus_share_to_feed[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_mint[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
     OR v_stack ~ 'function (public[.])?send_stream_gift[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_deposit[(]'
     OR v_stack ~ 'function (public[.])?fn_arena_withdraw[(]'
     -- DIAMOND PHASE 8: a tournament entry is custody; its charge and refund
     -- move the wallet from client doors.
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_charge[(]'
     OR v_stack ~ 'function (public[.])?fn_poker_diamond_tournament_refund[(]'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.diamonds IS DISTINCT FROM OLD.diamonds THEN v_changed := 'diamonds';
  ELSIF NEW.diamond_balance IS DISTINCT FROM OLD.diamond_balance THEN v_changed := 'diamond_balance';
  ELSIF NEW.diamond_multiplier IS DISTINCT FROM OLD.diamond_multiplier THEN v_changed := 'diamond_multiplier';
  ELSIF NEW.is_vip IS DISTINCT FROM OLD.is_vip THEN v_changed := 'is_vip';
  ELSIF NEW.vip_tier IS DISTINCT FROM OLD.vip_tier THEN v_changed := 'vip_tier';
  ELSIF NEW.vip_expires_at IS DISTINCT FROM OLD.vip_expires_at THEN v_changed := 'vip_expires_at';
  END IF;

  IF v_changed IS NOT NULL THEN
    RAISE EXCEPTION
      'profiles.% is server-managed and cannot be modified by role %',
      v_changed, current_user
      USING ERRCODE = '42501',
            HINT = 'Use a server-authoritative, ledgered money RPC.';
  END IF;

  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_unreachable_money()
 RETURNS TABLE(finding text, object text, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A money function nothing calls, and nothing grants to a client either: it can only ever run
  -- if a human types its name. That is how send_stream_gift sat unreachable for months.
  SELECT 'no_caller_and_no_client_grant'::text,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'writes profiles.diamonds but no other function calls it and neither anon nor authenticated may execute it'::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?profiles[^;]*diamonds\s*='
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc q JOIN pg_namespace m ON m.oid = q.pronamespace
        WHERE m.nspname = 'public' AND q.oid <> p.oid AND q.prosrc LIKE '%' || p.proname || '%')
     AND NOT EXISTS (
       SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee IN ('anon'::regrole, 'authenticated'::regrole))

  UNION ALL

  -- A money function a browser CAN call, that the privileged-column guard would refuse. That is
  -- exactly what made send_stream_gift answer 42501 to every real player.
  SELECT 'client_reachable_but_guard_refuses'::text,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'granted to authenticated and writes profiles.diamonds, but fn_guard_profile_privileged_columns does not name it'::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.prosrc ~* 'update\s+(public\.)?profiles[^;]*diamonds\s*='
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 'authenticated'::regrole)
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc g JOIN pg_namespace gn ON gn.oid = g.pronamespace
        WHERE gn.nspname = 'public' AND g.proname = 'fn_guard_profile_privileged_columns'
          AND g.prosrc LIKE '%' || p.proname || '[(]%')

  UNION ALL

  -- A rule row that reads as armed while nothing consults it (the DR15 shape).
  SELECT 'rule_with_no_consumer'::text, r.rule,
         'ca_diamond_rule_modes carries it, but no function calls fn_ca_diamond_rule_mode with this name'::text
    FROM public.ca_diamond_rule_modes r
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        -- THE LITERAL CALL, not a body that merely mentions the two strings somewhere. The first
        -- version passed the rule its own migration had just inserted (D3, 2026-09-08).
        AND p.prosrc LIKE '%fn_ca_diamond_rule_mode(''' || r.rule || ''')%');
$function$
;
REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_unreachable_money() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_unreachable_money() TO service_role;
CREATE TRIGGER trg_guard_profile_privileged_columns BEFORE UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_profile_privileged_columns();

SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure))='43896e9aebd9df49151a0e92799f9598','fixture profile guard is the production text');
SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_ca_diamond_unreachable_money()'::regprocedure))='08f60b61b3b5f2a6e30e7dd44faedc31','fixture detector is the production text');
SELECT public.fixture_assert(md5(pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure))='a1ccc4bc9a5c6d8d17308e93943a9413','fixture reserve is the production text');
SELECT public.fixture_assert(md5(pg_get_functiondef('public.send_wallet_diamond_transfer(uuid,integer,text,text)'::regprocedure))='8d5b95d8ad2a74c1ba85339168349606','fixture transfer door is the production text');
