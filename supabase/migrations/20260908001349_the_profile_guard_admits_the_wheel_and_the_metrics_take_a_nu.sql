-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260908001349; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260908001349   (the stamp IS the apply time, UTC: 2026-09-08 00:13:49)
--   name        the_profile_guard_admits_the_wheel_and_the_metrics_take_a_nu
--   created_by  (not recorded)
--   statements  1 statement(s), 10185 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260908001349 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_guard_profile_privileged_columns, public.fn_wheel_metrics
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260908001349_the_profile_guard_admits_the_wheel_and_the_metrics_take_a_nu.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Two things the rolled-back probe of the Diamond Wheel (20260907233833) found
-- on its first diamond prize and its first metrics read.
--
-- 1. THE PROFILE GUARD. fn_guard_profile_privileged_columns refuses any write to
--    profiles.diamonds outside a service context or a named call stack. The
--    wheel pays a diamond prize through add_diamonds_to_balance from a PLAYER's
--    call (auth.role() = authenticated), and the guard refused it with 42501:
--    "profiles.diamonds is server-managed and cannot be modified by role
--    postgres". The spin rolled back whole - nothing moved, the player saw an
--    error - which is the right failure, and the wrong outcome for a prize the
--    wheel had drawn. fn_wheel_spin joins the allowlist the way
--    fn_ca_daily_bonus_claim did an hour earlier (20260907234547): it is a
--    SECURITY DEFINER money RPC on the register, it reads auth.uid(), and every
--    diamond it credits carries a reference, a class and a counterparty. The
--    body below is the live body with ONE line added and the eight patterns
--    rewritten with bracket expressions ([.] and [(]) instead of backslash
--    escapes, so the same text means the same thing whatever a client does to
--    backslashes; the guard-definition watch (fn_ca_guard_defs_watch) will
--    notice and re-baseline, and this header is the reason it should read.
--
-- 2. THE METRICS. fn_wheel_metrics computed a z-score with sqrt(n) on a bigint
--    count, which is double precision, and round(double precision, integer)
--    does not exist: the first read raised 42883. sqrt(n::numeric) keeps the
--    whole expression numeric. Nothing else in the body changes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── 1. the guard admits the wheel ─────────────────────────────────────────────
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
     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_mint[(]'
     OR v_stack ~ 'function (public[.])?fn_ca_burn[(]'
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
$function$;
REVOKE ALL ON FUNCTION public.fn_guard_profile_privileged_columns() FROM PUBLIC, anon, authenticated;

-- ── 2. the metrics take a numeric root ────────────────────────────────────────
-- ── the house side: realised return, exposure, the invariant, as a z-score ───
CREATE OR REPLACE FUNCTION public.fn_wheel_metrics(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_sd numeric; v_windows jsonb; v_bank numeric;
  v_invariant_ok boolean;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read The Wheel Metrics');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT v.sd_chips INTO v_sd FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF v_kind = 'union' THEN
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host;
  END IF;

  -- Realised return against the 80 percent spec, per window, as a z-score on
  -- the table's own standard deviation: the spin fairness view's method.
  SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
    FROM (
      SELECT jsonb_build_object(
               'window', lbl,
               'spins', n,
               'intake_chips', round(intake, 2),
               'paid_chips', round(paid, 4),
               'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
               'z', CASE WHEN n >= 30 AND v_sd > 0
                         THEN round((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n::numeric)), 2) END,
               'constrained', constrained,
               'drift', CASE WHEN n >= 2000 AND v_sd > 0
                             THEN abs((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n::numeric))) >= 4 ELSE false END)
             AS w
        FROM (
          SELECT lbl,
                 count(s.id) AS n,
                 COALESCE(SUM(s.spin_price_diamonds::numeric / s.diamonds_per_chip), 0) AS intake,
                 COALESCE(SUM(s.prize_value_chips), 0) AS paid,
                 COALESCE(SUM(CASE WHEN jsonb_array_length(s.locked) > 0 THEN 1 ELSE 0 END), 0) AS constrained
            FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
            LEFT JOIN public.wheel_spins s
              ON s.host_id = v_host AND NOT s.is_fixture AND s.created_at >= now() - win.span
           GROUP BY lbl
        ) x
    ) y;

  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid <= pool.chips_minted + cfg.exposure_allowance_chips AND pool.diamond_float >= 0);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => 'wheel_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => 'wheel:invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid - pool.chips_minted - cfg.exposure_allowance_chips,
        p_expected => pool.chips_minted + cfg.exposure_allowance_chips, p_actual => pool.chips_paid,
        p_layer => 'settlement', p_entity_type => 'wheel_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond Wheel paid more than it minted plus the allowance; the per-spin gate was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'configured', true, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'bank_chips', COALESCE(v_bank, 0),
    'exposure_chips', COALESCE(pool.chips_paid, 0) - COALESCE(pool.chips_minted, 0),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) - COALESCE(pool.chips_minted, 0)),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round((pool.chips_paid + pool.diamonds_paid::numeric / v_rate) / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_minted - pool.diamond_float / v_rate - pool.diamonds_paid::numeric / v_rate, 4) END,
    'lock_rate', CASE WHEN COALESCE(pool.spins, 0) > 0 THEN round(pool.constrained_spins::numeric / pool.spins, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'audit', (SELECT to_jsonb(x) FROM public.fn_wheel_segments_audit(cfg.segment_version) x));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;


DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_guard_profile_privileged_columns' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_wheel_spin%' OR v_src NOT LIKE '%fn_ca_daily_bonus_claim%' OR v_src NOT LIKE '%deduct_diamonds%' THEN
    RAISE EXCEPTION 'POST-APPLY: the profile guard lost a name from its allowlist';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_wheel_metrics' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%sqrt(n))%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_metrics still takes a double precision root';
  END IF;
END $$;

COMMIT;
