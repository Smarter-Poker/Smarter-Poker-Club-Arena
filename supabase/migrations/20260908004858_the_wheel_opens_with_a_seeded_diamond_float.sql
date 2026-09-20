-- 20260908004858_the_wheel_opens_with_a_seeded_diamond_float.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-09-08, on the three items the wheel changelog had filed as his:
-- "NOTHING IS MINE, THESE ARE ALL 100% YOURS." So this migration takes them.
--
-- 1. THE COLD FLOAT. The diamond tiers of the prize table are paid from a
--    float that accrues 5.7 diamonds a spin (the table's diamond share). A
--    brand-new host therefore opened with the 250-diamond tier locked for the
--    first ~43 spins and re-locked after every hit: the gate being honest, but
--    a wheel whose top diamond tier is dark most of the time. The chip side
--    never had that problem because the host accepts a 500-chip exposure
--    allowance up front. The diamond side now gets the same shape: a
--    DIAMOND SEED (default 2,500 diamonds, 25 chips of value) that the pool's
--    float starts at. The invariant is unchanged in form - diamond_float >= 0 -
--    and the value bound becomes
--        value paid <= 0.80 x intake + exposure_allowance + diamond_seed / rate
--    which is the plan's "seed float" applied to both currencies. The seed is
--    a memo cap: diamond prizes are promotional issuance under the engine
--    budget either way (Diamond Standard D2), the seed only decides how far
--    prizes may lead intake. Changing it later moves the float by the delta
--    and refuses to drive the float negative.
--
-- 2. THE HOSTS ARE OPEN. Two hosts exist (read 2026-09-08 00:45 UTC): the
--    Midway Union (3 clubs, 1,508 members, bank 44,725.74) and Deep Stack
--    Society (standalone, 418 members, treasury 1,718,871.42). Both get a
--    wheel_configs row at the plan's settings - 100 diamonds a spin, prize
--    table 1, 500-chip allowance, purchased diamonds only, 200 spins a day,
--    3 seconds between spins - and enabled = true. purchased_only stays true:
--    2 purchased lots exist against 1,023,512 diamonds of supply, and Dan's
--    2026-09-05 ruling that nothing ever earns chips means promotional
--    diamonds do not become chips here. The operator can widen it from the
--    console; the default is the closed one.
--
-- 3. The closed-loop exception (DR16) is written into
--    docs/DIAMOND-ACCOUNTING-STANDARD.md in the same pull request.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── 1. the seed ──────────────────────────────────────────────────────────────
ALTER TABLE public.wheel_configs
  ADD COLUMN IF NOT EXISTS diamond_seed integer NOT NULL DEFAULT 2500 CHECK (diamond_seed >= 0);
COMMENT ON COLUMN public.wheel_configs.diamond_seed IS
  'Diamonds the pool''s float starts at, so diamond tiers are live from the first spin. The diamond-side twin of exposure_allowance_chips: diamond prizes may lead the accrued diamond share by at most this much.';

ALTER TABLE public.wheel_pools
  ADD COLUMN IF NOT EXISTS diamond_seed numeric(16,4) NOT NULL DEFAULT 0 CHECK (diamond_seed >= 0);
COMMENT ON COLUMN public.wheel_pools.diamond_seed IS
  'The seed included in diamond_float. Accrued diamond share = diamond_float - diamond_seed + diamonds_paid.';

CREATE OR REPLACE FUNCTION public.fn_wheel_pool_seed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_seed integer;
BEGIN
  SELECT c.diamond_seed INTO v_seed FROM public.wheel_configs c WHERE c.host_id = NEW.host_id;
  NEW.diamond_seed := COALESCE(v_seed, 0);
  NEW.diamond_float := COALESCE(NEW.diamond_float, 0) + COALESCE(v_seed, 0);
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_pool_seed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_wheel_pool_seed ON public.wheel_pools;
CREATE TRIGGER trg_wheel_pool_seed
  BEFORE INSERT ON public.wheel_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_pool_seed();

-- ── 2. the operator's controls learn the seed ────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_set_config(p_club_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  v_version integer; v_vprice integer;
  v_seed_delta integer := 0;
  v_float numeric;
  a record;
BEGIN
  IF v_user IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Change The Wheel');
  END IF;

  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL THEN
    SELECT max(v.version) INTO v_version FROM public.wheel_segment_versions v WHERE v.activated_at IS NOT NULL;
    IF v_version IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'No Prize Table Has Been Activated Yet');
    END IF;
    INSERT INTO public.wheel_configs (host_id, host_kind, segment_version, updated_by)
    VALUES (v_host, v_kind, v_version, v_user) RETURNING * INTO cfg;
    INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  END IF;

  IF p_patch ? 'segment_version' THEN
    v_version := (p_patch->>'segment_version')::integer;
    IF NOT EXISTS (SELECT 1 FROM public.wheel_segment_versions v WHERE v.version = v_version AND v.activated_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Prize Table Is Not Activated');
    END IF;
    cfg.segment_version := v_version;
  END IF;
  IF p_patch ? 'spin_price_diamonds' THEN cfg.spin_price_diamonds := (p_patch->>'spin_price_diamonds')::integer; END IF;
  IF p_patch ? 'exposure_allowance_chips' THEN cfg.exposure_allowance_chips := round((p_patch->>'exposure_allowance_chips')::numeric, 2); END IF;
  IF p_patch ? 'diamond_seed' THEN
    v_seed_delta := (p_patch->>'diamond_seed')::integer - cfg.diamond_seed;
    cfg.diamond_seed := (p_patch->>'diamond_seed')::integer;
  END IF;
  IF p_patch ? 'purchased_only' THEN cfg.purchased_only := (p_patch->>'purchased_only')::boolean; END IF;
  IF p_patch ? 'allow_fixture_accounts' THEN cfg.allow_fixture_accounts := (p_patch->>'allow_fixture_accounts')::boolean; END IF;
  IF p_patch ? 'max_spins_per_player_per_day' THEN cfg.max_spins_per_player_per_day := (p_patch->>'max_spins_per_player_per_day')::integer; END IF;
  IF p_patch ? 'min_seconds_between_spins' THEN cfg.min_seconds_between_spins := (p_patch->>'min_seconds_between_spins')::integer; END IF;
  IF p_patch ? 'enabled' THEN cfg.enabled := (p_patch->>'enabled')::boolean; END IF;

  IF cfg.diamond_seed < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Seed Cannot Be Negative');
  END IF;

  -- The spin price must be a whole multiple of the table's price so every prize
  -- scales by an integer and stays on whole cents; the table must still audit.
  SELECT v.spin_price_diamonds INTO v_vprice FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF cfg.spin_price_diamonds % v_vprice <> 0 THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('The Spin Price Must Be A Multiple Of %s Diamonds For This Prize Table', v_vprice));
  END IF;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF cfg.enabled AND (a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Fails Its Audit And Cannot Be Enabled');
  END IF;

  -- A seed change moves the float by the delta. It never drives the float
  -- below zero: diamonds already paid against the old seed are paid.
  IF v_seed_delta <> 0 THEN
    SELECT p.diamond_float INTO v_float FROM public.wheel_pools p WHERE p.host_id = v_host FOR UPDATE;
    IF v_float + v_seed_delta < 0 THEN
      RETURN jsonb_build_object('ok', false,
        'error', format('The Seed Can Be Lowered By At Most %s Diamonds Right Now', floor(v_float)));
    END IF;
    UPDATE public.wheel_pools
       SET diamond_float = diamond_float + v_seed_delta,
           diamond_seed = diamond_seed + v_seed_delta,
           updated_at = now()
     WHERE host_id = v_host;
  END IF;

  UPDATE public.wheel_configs
     SET enabled = cfg.enabled, spin_price_diamonds = cfg.spin_price_diamonds, segment_version = cfg.segment_version,
         exposure_allowance_chips = cfg.exposure_allowance_chips, diamond_seed = cfg.diamond_seed,
         purchased_only = cfg.purchased_only,
         allow_fixture_accounts = cfg.allow_fixture_accounts,
         max_spins_per_player_per_day = cfg.max_spins_per_player_per_day,
         min_seconds_between_spins = cfg.min_seconds_between_spins,
         updated_at = now(), updated_by = v_user
   WHERE host_id = v_host
   RETURNING * INTO cfg;
  RETURN jsonb_build_object('ok', true, 'config', to_jsonb(cfg), 'audit', to_jsonb(a));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_config(uuid, jsonb) TO authenticated, service_role;

-- ── 3. the metrics net the seed out of the house take ────────────────────────
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

  -- The invariant, in value: chips paid within minted + allowance, and diamonds
  -- paid within the accrued diamond share + the seed (diamond_float >= 0).
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
    'diamond_headroom', COALESCE(pool.diamond_float, 0),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round((pool.chips_paid + pool.diamonds_paid::numeric / v_rate) / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_minted
                   - (pool.diamond_float - pool.diamond_seed) / v_rate - pool.diamonds_paid::numeric / v_rate, 4) END,
    'lock_rate', CASE WHEN COALESCE(pool.spins, 0) > 0 THEN round(pool.constrained_spins::numeric / pool.spins, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'audit', (SELECT to_jsonb(x) FROM public.fn_wheel_segments_audit(cfg.segment_version) x));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;

-- ── 4. the hosts open ────────────────────────────────────────────────────────
-- Every host that exists today, at the plan's settings, enabled. The config
-- history trigger records the row; the pool trigger seeds the float.
INSERT INTO public.wheel_configs (host_id, host_kind, enabled, segment_version, updated_by)
SELECT h.host_id, h.host_kind, true, 1, NULL
  FROM (SELECT DISTINCT COALESCE(c.union_id, c.id) AS host_id,
               CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END AS host_kind
          FROM public.clubs c
         WHERE COALESCE(c.status, 'active') NOT IN ('deleted', 'archived', 'disbanded')) h
 WHERE NOT EXISTS (SELECT 1 FROM public.wheel_configs w WHERE w.host_id = h.host_id);

INSERT INTO public.wheel_pools (host_id)
SELECT w.host_id FROM public.wheel_configs w
 WHERE NOT EXISTS (SELECT 1 FROM public.wheel_pools p WHERE p.host_id = w.host_id);

-- ── post-apply assertions ────────────────────────────────────────────────────
DO $$
DECLARE v_n integer; v_bad integer; v_src text;
BEGIN
  SELECT count(*) INTO v_n FROM public.wheel_configs WHERE enabled;
  IF v_n < 2 THEN
    RAISE EXCEPTION 'POST-APPLY: expected both hosts enabled, found %', v_n;
  END IF;
  SELECT count(*) INTO v_bad
    FROM public.wheel_pools p JOIN public.wheel_configs c USING (host_id)
   WHERE p.diamond_seed <> c.diamond_seed OR p.diamond_float <> c.diamond_seed OR p.spins <> 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'POST-APPLY: % pool(s) not seeded to the configured float', v_bad;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_wheel_metrics' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%pool.diamond_float - pool.diamond_seed%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_metrics does not net the seed out of the house take';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_wheel_set_config' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%diamond_seed%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_set_config does not accept the seed';
  END IF;
END $$;

COMMIT;
