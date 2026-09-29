-- 20260929213851_the_arena_stats_door_reads_its_own_hands
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-29. Diamond
-- Arena Phase 10, line 1. Applied once to kuklfnapbkmacvwxktbh.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- The Diamond Arena's footer has a Stats door (/stats?club=diamond-arena). The
-- stats page read chips whatever door it was opened from, so a player in the
-- arena was shown their chip figures under the Diamond footer. The readers
-- behind it learned the asset in 20260920065728 (a Diamond hand keeps its own
-- statistics), and the page now asks for Diamonds when it is opened from the
-- arena. One reader was left: the page's Hands tab calls ca_player_hands_v2,
-- which wraps ca_player_hands, and both still took only the player, so the
-- tab would list every hand of both assets under a Diamond heading.
--
-- ═══ WHAT THIS DOES ═══════════════════════════════════════════════════════
--
-- Both learn p_asset text DEFAULT 'chips' as their last parameter, the same
-- contract as the eight readers: an existing caller keeps its answer, an
-- asset that is neither chips nor diamonds is refused, and ca_player_hands
-- reads only the stat rows of that asset (ca_hand_player_stat.asset, set from
-- the hand by fn_ca_hand_player_row_takes_its_hands_asset). Each edit is an
-- asserted substitution with the live md5 pinned and the reverse proved; the
-- old signatures are dropped first (an extra defaulted parameter would add an
-- overload and make every existing call ambiguous) and the grants restated as
-- they were: ca_player_hands to the service role only, ca_player_hands_v2 to
-- authenticated and the service role. The owner gate (ca_assert_self) and the
-- own-cards-only rule for hole cards are untouched.
--
-- Nothing is priced, no switch is touched, no Diamond moves, and neither
-- function is on fn_ca_guard_watchlist().
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-09-29:
--   ca_player_hands                9f93e2b8ace2ee6eb2ebc5d0d6a81d02
--   ca_player_hands_v2             21843b8f7f595e236f5693c4ffb1895d
--
-- The two proofs below were added to this file after the apply, for
-- tests/a-merged-migration-must-be-live.law.test.ts (the file creates its
-- functions through EXECUTE, which that check cannot see). The text recorded
-- in schema_migrations is this file without this note and the two proofs.
-- @live-proof: (SELECT position('AND s.asset = p_asset' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'ca_player_hands')
-- @live-proof: (SELECT position('ca_player_hands(p_user, p_mode, p_limit, p_asset)' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'ca_player_hands_v2')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. PREFLIGHT: THE STAT ROWS CARRY THEIR ASSET
-- ---------------------------------------------------------------------------
DO $m$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_hand_player_stat'
                    AND column_name = 'asset') THEN
    RAISE EXCEPTION 'ca_hand_player_stat has no asset column; 20260920065728 must be applied first';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2a. THE HANDS LIST READS ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_hands(uuid,text,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hands(p_user uuid, p_mode text DEFAULT 'recent'::text, p_limit integer DEFAULT 25)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hands(p_user uuid, p_mode text DEFAULT 'recent'::text, p_limit integer DEFAULT 25, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$BEGIN
  IF v_mode NOT IN ('recent', 'biggest_won', 'biggest_lost') THEN
$f$;
  v_new2 text := $f$BEGIN
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
  IF v_mode NOT IN ('recent', 'biggest_won', 'biggest_lost') THEN
$f$;
  v_old3 text := $f$  WHERE s.user_id = p_user
$f$;
  v_new3 text := $f$  WHERE s.user_id = p_user
    AND s.asset = p_asset
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hands(uuid,text,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '9f93e2b8ace2ee6eb2ebc5d0d6a81d02' THEN
    RAISE EXCEPTION 'ca_player_hands is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_hands(uuid, text, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_hands(uuid,text,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hands(uuid,text,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '9f93e2b8ace2ee6eb2ebc5d0d6a81d02' THEN
    RAISE EXCEPTION 'ca_player_hands: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_hands(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, integer, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2b. THE HANDS LIST DOOR ASKS FOR ONE ASSET
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid := to_regprocedure('public.ca_player_hands_v2(uuid,text,integer)');
  v_new_oid oid;
  v_def text;
  v_n integer;
  v_old1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hands_v2(p_user uuid, p_mode text DEFAULT 'recent'::text, p_limit integer DEFAULT 25)
$f$;
  v_new1 text := $f$CREATE OR REPLACE FUNCTION public.ca_player_hands_v2(p_user uuid, p_mode text DEFAULT 'recent'::text, p_limit integer DEFAULT 25, p_asset text DEFAULT 'chips'::text)
$f$;
  v_old2 text := $f$  PERFORM public.ca_assert_self(p_user);
$f$;
  v_new2 text := $f$  PERFORM public.ca_assert_self(p_user);
  IF p_asset IS NULL OR p_asset NOT IN ('chips', 'diamonds') THEN
    RAISE EXCEPTION 'unknown stats asset: %', p_asset USING ERRCODE = '22023';
  END IF;
$f$;
  v_old3 text := $f$  RETURN public.ca_player_hands(p_user, p_mode, p_limit);
$f$;
  v_new3 text := $f$  RETURN public.ca_player_hands(p_user, p_mode, p_limit, p_asset);
$f$;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hands_v2(uuid,text,integer) is missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '21843b8f7f595e236f5693c4ffb1895d' THEN
    RAISE EXCEPTION 'ca_player_hands_v2 is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands_v2: clause 1 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands_v2: clause 2 occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_player_hands_v2: clause 3 occurs % times, expected 1', v_n; END IF;
  DROP FUNCTION public.ca_player_hands_v2(uuid, text, integer);
  EXECUTE replace(replace(replace(v_def, v_old1, v_new1), v_old2, v_new2), v_old3, v_new3);
  v_new_oid := to_regprocedure('public.ca_player_hands_v2(uuid,text,integer,text)');
  IF v_new_oid IS NULL THEN RAISE EXCEPTION 'ca_player_hands_v2(uuid,text,integer,text) was not created'; END IF;
  IF md5(replace(replace(replace(pg_get_functiondef(v_new_oid), v_new1, v_old1), v_new2, v_old2), v_new3, v_old3)) <> '21843b8f7f595e236f5693c4ffb1895d' THEN
    RAISE EXCEPTION 'ca_player_hands_v2: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
REVOKE ALL ON FUNCTION public.ca_player_hands_v2(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_hands_v2(uuid, text, integer, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_player_hands_v2(uuid, text, integer, text) IS
  'The stats page''s Hands tab: the owner''s own hands (recent, biggest won, biggest lost) in one asset (p_asset, chips by default, or diamonds). Asserts auth.uid() = p_user and wraps ca_player_hands. Hole cards are the owner''s own only.';

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record;
  v_oid oid;
  v_bad text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('ca_player_hands',    'ca_player_hands(uuid,text,integer)',    'ca_player_hands(uuid,text,integer,text)',    false),
      ('ca_player_hands_v2', 'ca_player_hands_v2(uuid,text,integer)', 'ca_player_hands_v2(uuid,text,integer,text)', true)
    ) v(proname, old_sig, new_sig, browser)
  LOOP
    IF to_regprocedure('public.' || r.old_sig) IS NOT NULL THEN
      RAISE EXCEPTION '% survived; every existing call would be ambiguous', r.old_sig;
    END IF;
    v_oid := to_regprocedure('public.' || r.new_sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION '% is missing', r.new_sig; END IF;
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = r.proname) <> 1 THEN
      RAISE EXCEPTION '% has more than one overload', r.proname;
    END IF;
    IF position('p_asset text DEFAULT ''chips''::text' IN pg_get_functiondef(v_oid)) = 0
       OR position('unknown stats asset' IN pg_get_functiondef(v_oid)) = 0 THEN
      RAISE EXCEPTION '% does not take and check its asset', r.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION '% lost SECURITY DEFINER', r.proname;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') IS DISTINCT FROM r.browser THEN
      RAISE EXCEPTION '% does not have the browser grant it had', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost its service-role grant', r.proname;
    END IF;
  END LOOP;
  IF position('AND s.asset = p_asset' IN pg_get_functiondef('public.ca_player_hands(uuid,text,integer,text)'::regprocedure)) = 0
     OR position('ca_player_hands(p_user, p_mode, p_limit, p_asset)' IN pg_get_functiondef('public.ca_player_hands_v2(uuid,text,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'the hands list does not read one asset';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'the arena stats door reads its own hands: ca_player_hands and ca_player_hands_v2 read one asset, nothing opened';
END $m$;

COMMIT;
