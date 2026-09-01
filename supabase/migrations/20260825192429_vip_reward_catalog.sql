-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825192429; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- VIP REWARDS: a real catalog, a real price, a real grant. 2026-08-25.
-- See supabase/migrations/20260825_vip_reward_catalog.sql in club-arena for the
-- full rationale and the ROLLBACK section.

CREATE TABLE IF NOT EXISTS public.vip_reward_catalog (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  category     text NOT NULL CHECK (category IN ('tournament','avatar','theme','bonus','merch')),
  points_cost  bigint NOT NULL CHECK (points_cost > 0),
  grant_type   text NOT NULL CHECK (grant_type IN ('theme','avatar','manual')),
  grant_ref    text,
  stock        integer CHECK (stock IS NULL OR stock >= 0),
  featured     boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.vip_reward_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reward_id     text NOT NULL REFERENCES public.vip_reward_catalog(id),
  points_spent  bigint NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','fulfilled','cancelled')),
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  fulfilled_at  timestamptz
);

CREATE INDEX IF NOT EXISTS vip_reward_claims_user_idx ON public.vip_reward_claims (user_id, claimed_at DESC);

ALTER TABLE public.vip_reward_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vip_reward_claims  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vip_reward_catalog_public_select ON public.vip_reward_catalog;
CREATE POLICY vip_reward_catalog_public_select ON public.vip_reward_catalog
  FOR SELECT TO anon, authenticated USING (is_active);

DROP POLICY IF EXISTS vip_reward_claims_select_own ON public.vip_reward_claims;
CREATE POLICY vip_reward_claims_select_own ON public.vip_reward_claims
  FOR SELECT TO authenticated USING (user_id = auth.uid());

GRANT SELECT ON public.vip_reward_catalog TO anon, authenticated;
GRANT SELECT ON public.vip_reward_claims  TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vip_reward_catalog FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.vip_reward_claims  FROM anon, authenticated;

INSERT INTO public.vip_reward_catalog
  (id, name, description, category, points_cost, grant_type, grant_ref, stock, featured, sort_order)
VALUES
  ('tournament-elite',   'Elite Tournament Pass',    'Entry to premium tournament series with higher payouts', 'tournament', 5000, 'manual', NULL,              25,   true,  1),
  ('avatar-gold-frame',  'Gold Frame Badge',         'Exclusive gold avatar frame',                            'avatar',     1500, 'avatar', 'gold_frame',      NULL, true,  2),
  ('theme-neon',         'Neon Table Theme',         'Vibrant neon-style table theme',                         'theme',      2000, 'theme',  'neon',            NULL, false, 3),
  ('bonus-50k',          '50K Bonus Package',        'Bonus chips to use in games',                            'bonus',      3500, 'manual', NULL,              NULL, false, 4),
  ('tournament-vip',     'VIP Tournament Seat',      'Reserved seat in exclusive weekly tournament',           'tournament', 4000, 'manual', NULL,              NULL, false, 5),
  ('avatar-royal-crown', 'Royal Crown Badge',        'Premium royal crown avatar badge',                       'avatar',     2500, 'avatar', 'royal_crown',     NULL, false, 6),
  ('theme-midnight',     'Midnight Casino Theme',    'Dark elegant casino-inspired theme',                     'theme',      1800, 'theme',  'midnight_casino', NULL, false, 7),
  ('bonus-25k',          '25K Bonus Package',        'Bonus chips to use in games',                            'bonus',      1500, 'manual', NULL,              NULL, false, 8),
  ('tournament-weekly',  'Weekly Tournament Bundle', 'Entry to 4 weekly tournaments',                          'tournament', 2000, 'manual', NULL,              NULL, false, 9),
  ('avatar-diamond-halo','Diamond Halo Effect',      'Animated diamond halo around avatar',                    'avatar',     3000, 'avatar', 'diamond_halo',    NULL, false, 10),
  ('theme-cosmic',       'Cosmic Space Theme',       'Futuristic space-themed table',                          'theme',      2200, 'theme',  'cosmic',          NULL, false, 11),
  ('merch-hoodie',       'Premium Hoodie',           'Limited edition branded hoodie',                         'merch',      8000, 'manual', NULL,              50,   false, 12)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_redeem_vip_points(
  p_cost bigint,
  p_reason text DEFAULT 'Reward redemption'::text,
  p_reward_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_bal    bigint;
  v_reward record;
  v_cost   bigint;
  v_status text := 'pending';
  v_granted jsonb := jsonb_build_object('type', 'none');
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_authenticated'); END IF;

  IF p_reward_id IS NOT NULL THEN
    SELECT * INTO v_reward FROM vip_reward_catalog WHERE id = p_reward_id AND is_active;
    IF v_reward.id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_reward');
    END IF;
    -- THE CATALOG PRICES THE REWARD. p_cost used to BE the charge, so the
    -- buyer set it: fn_redeem_vip_points(1, '...') bought a 5000-point reward.
    v_cost := v_reward.points_cost;
  ELSE
    v_cost := p_cost;
  END IF;

  IF v_cost IS NULL OR v_cost <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_cost'); END IF;

  IF p_reward_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_redeem_vip_points:' || v_uid::text || ':' || p_reward_id, 0)
    );

    IF v_reward.stock IS NOT NULL AND v_reward.stock <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'sold_out');
    END IF;

    IF v_reward.grant_type = 'theme' AND EXISTS (
      SELECT 1 FROM theme_unlocks WHERE user_id = v_uid AND theme_id = v_reward.grant_ref
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
    IF v_reward.grant_type = 'avatar' AND EXISTS (
      SELECT 1 FROM avatar_unlocks WHERE user_id = v_uid AND avatar_id = v_reward.grant_ref
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_owned', 'already_owned', true);
    END IF;
  END IF;

  SELECT current_points INTO v_bal FROM vip_points WHERE user_id = v_uid FOR UPDATE;
  IF COALESCE(v_bal, 0) < v_cost THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_points', 'balance', COALESCE(v_bal,0));
  END IF;

  UPDATE vip_points SET current_points = current_points - v_cost, updated_at = now() WHERE user_id = v_uid;
  INSERT INTO vip_points_ledger (user_id, points, reason, source_type, source_id)
  VALUES (v_uid, -v_cost, p_reason, 'redeem', gen_random_uuid());

  IF p_reward_id IS NOT NULL THEN
    IF v_reward.grant_type = 'theme' THEN
      INSERT INTO theme_unlocks (user_id, theme_id, unlock_method)
      VALUES (v_uid, v_reward.grant_ref, 'vip_points')
      ON CONFLICT (user_id, theme_id) DO NOTHING;
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'theme', 'theme_id', v_reward.grant_ref);
    ELSIF v_reward.grant_type = 'avatar' THEN
      INSERT INTO avatar_unlocks (user_id, avatar_id, unlock_method)
      VALUES (v_uid, v_reward.grant_ref, 'vip_points')
      ON CONFLICT DO NOTHING;
      v_status := 'granted';
      v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_reward.grant_ref);
    END IF;

    IF v_reward.stock IS NOT NULL THEN
      UPDATE vip_reward_catalog SET stock = stock - 1 WHERE id = p_reward_id;
    END IF;

    INSERT INTO vip_reward_claims (user_id, reward_id, points_spent, status)
    VALUES (v_uid, p_reward_id, v_cost, v_status);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'balance', COALESCE(v_bal,0) - v_cost,
    'charged', v_cost,
    'status', CASE WHEN p_reward_id IS NULL THEN NULL ELSE v_status END,
    'granted', v_granted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_redeem_vip_points(bigint, text, text) TO authenticated;

DO $$
DECLARE v_src text; v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.vip_reward_catalog;
  IF v_n <> 12 THEN RAISE EXCEPTION 'vip_reward_catalog has % rows, expected 12', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.vip_reward_catalog
   WHERE grant_type IN ('theme','avatar') AND (grant_ref IS NULL OR grant_ref = '');
  IF v_n > 0 THEN RAISE EXCEPTION '% cosmetic rewards have no grant_ref', v_n; END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_redeem_vip_points'
     AND pg_get_function_identity_arguments(p.oid) = 'p_cost bigint, p_reason text, p_reward_id text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'three-arg fn_redeem_vip_points was not created'; END IF;
  IF position('vip_reward_catalog' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_redeem_vip_points still does not price from the catalog';
  END IF;
  IF position('theme_unlocks' in v_src) = 0 OR position('avatar_unlocks' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_redeem_vip_points still grants no cosmetic';
  END IF;

  IF has_table_privilege('authenticated', 'public.vip_reward_catalog', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can rewrite the VIP reward prices';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.vip_reward_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot read the VIP reward catalog';
  END IF;
END $$;
