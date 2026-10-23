-- Restore welcome reserve reuse for default club opening.
-- The 20261021174448 rake update replaced the function body and removed the
-- 20261001154709 welcome receipt guard. Automatic opening must reuse funded
-- principals rather than debit BBJ/Spins again. Restore exactly that guard,
-- retaining the current rake bounds, Promo-only leaderboard and owner checks.
-- Function-only DDL; no hot-table constraint/lock or data rewrite.
-- @live-proof: (SELECT prosrc LIKE '%v_welcome public.club_welcome_package_receipts%ROWTYPE%' AND prosrc LIKE '%p_spins_enabled AND v_welcome.club_id IS NULL%' AND prosrc LIKE '%v_rake > 100%' FROM pg_proc WHERE oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';

DO $opening_setup_welcome_reuse$
DECLARE
  v_sig regprocedure := 'public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure;
  v_def text := pg_get_functiondef(v_sig);
  v_before text;
  v_owner oid; v_acl aclitem[]; v_config text[]; v_security boolean;
BEGIN
  IF md5(v_def) <> '0f9d094f015b0ab7dab000f217c29bf2' THEN
    RAISE EXCEPTION 'QUICK_START_OPENING_PREIMAGE_DRIFT';
  END IF;
  IF 'fn_complete_club_opening_setup'=ANY(public.fn_ca_guard_watchlist()) THEN
    RAISE EXCEPTION 'QUICK_START_OPENING_GUARD_REQUALIFICATION_REQUIRED';
  END IF;
  SELECT proowner,proacl,proconfig,prosecdef INTO v_owner,v_acl,v_config,v_security
    FROM pg_proc WHERE oid=v_sig;
  v_before:=v_def;
  v_def:=replace(v_def,
    '  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '''')), ''\s+'', '' '', ''g''), 72);'||E'\nBEGIN',
    '  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '''')), ''\s+'', '' '', ''g''), 72);'||E'\n  v_welcome public.club_welcome_package_receipts%ROWTYPE;\nBEGIN');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_DECLARATION_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 100) THEN',
    E'  SELECT * INTO v_welcome FROM public.club_welcome_package_receipts WHERE club_id=p_club_id FOR UPDATE;\n'
    ||E'  IF FOUND AND (p_bbj_enabled IS NOT TRUE OR v_bbj_seed IS DISTINCT FROM (v_welcome.economics->>''bbj_seed'')::numeric\n'
    ||E'    OR p_spins_enabled IS NOT TRUE OR v_spin_seed IS DISTINCT FROM (v_welcome.economics->>''spin_seed'')::numeric\n'
    ||E'    OR p_spin_max_stake IS DISTINCT FROM (v_welcome.economics->>''spin_max_stake'')::numeric) THEN\n'
    ||E'    RAISE EXCEPTION ''Welcome BBJ And Poker Spins Are Already Seeded; Reuse Their Recorded Baseline'';\n'
    ||E'  END IF;\n\n  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 100) THEN');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_RECEIPT_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;',
    E'  IF v_welcome.club_id IS NOT NULL THEN\n    v_bbj_seed := 0;\n    v_spin_seed := 0;\n  END IF;\n\n  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_INCREMENT_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF p_spins_enabled THEN\n    v_spin_result := public.fn_spin_activate(',
    E'  IF p_spins_enabled AND v_welcome.club_id IS NULL THEN\n    v_spin_result := public.fn_spin_activate(');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_SPIN_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,
    E'  IF p_bbj_enabled THEN\n    SELECT pool.id INTO v_pool_id',
    E'  IF p_bbj_enabled AND v_welcome.club_id IS NULL THEN\n    SELECT pool.id INTO v_pool_id');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_BBJ_DRIFT'; END IF;
  v_before:=v_def;
  v_def:=replace(v_def,'      spins_preseed_amount = v_spin_seed,',
    '      spins_preseed_amount = COALESCE((v_welcome.economics->>''spin_seed'')::numeric, v_spin_seed),');
  IF v_def=v_before THEN RAISE EXCEPTION 'WELCOME_SETUP_PATCH_CLUB_DRIFT'; END IF;
  EXECUTE v_def;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=v_sig AND proowner=v_owner
      AND proacl IS NOT DISTINCT FROM v_acl AND proconfig IS NOT DISTINCT FROM v_config
      AND prosecdef=v_security) THEN
    RAISE EXCEPTION 'QUICK_START_OPENING_SECURITY_DRIFT';
  END IF;
END $opening_setup_welcome_reuse$;

-- Client admission is a read. It prevents an early-published client from
-- invoking the older opening function before this migration is installed.
CREATE FUNCTION public.fn_club_opening_defaults_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT position('v_welcome public.club_welcome_package_receipts%ROWTYPE' IN p.prosrc)>0
     AND position('p_spins_enabled AND v_welcome.club_id IS NULL' IN p.prosrc)>0
     AND position('p_bbj_enabled AND v_welcome.club_id IS NULL' IN p.prosrc)>0
  FROM pg_proc p WHERE p.oid='public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)'::regprocedure;
$$;
REVOKE ALL ON FUNCTION public.fn_club_opening_defaults_ready() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_club_opening_defaults_ready() TO authenticated;

COMMIT;
