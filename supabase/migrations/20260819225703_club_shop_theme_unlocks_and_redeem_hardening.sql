-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225703 "club_shop_theme_unlocks_and_redeem_hardening"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c2399b95e51b7084030c48a1fd413abf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Audit pass 5 — redemption correctness.
--
-- 1) TABLE SKINS GRANTED NOTHING DISTINCT. fn_redeem_shop_item inserted a
--    generic feature_purchases('theme_unlock') row and threw grant_spec.theme_id
--    away. A club selling "Midnight Felt" and "Royal Gold" sold the same flag
--    twice: the second purchase charged full price and unlocked nothing new.
--    New public.theme_unlocks mirrors avatar_unlocks and records WHICH theme.
--    The generic feature_purchases row is still written so the existing VIP
--    feature gate (VIPService.checkExistingPurchase) keeps working.
--
-- 2) auth.uid() NULL FAILED OPEN. `IF v_row.user_id <> auth.uid()` is NULL when
--    auth.uid() is NULL, so the IF was not taken and the function granted and
--    redeemed SOMEONE ELSE'S inventory row. Unreachable from the browser, but
--    any future service_role caller would have silently bypassed the check.
--
-- 3) A hard-deleted item left v_spec NULL -> silently redeemed for nothing with
--    success:true. Now reported as item_gone.
--
-- 4) fn_release_shop_stock had no ceiling: a release racing an admin lowering
--    stock could inflate it above the intended value. Now clamped by a
--    FOR UPDATE read.
--
-- Rollback: DROP TABLE public.theme_unlocks; restore prior function bodies.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.theme_unlocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme_id      text NOT NULL,
  unlock_method text,
  unlocked_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, theme_id)
);

CREATE INDEX IF NOT EXISTS idx_theme_unlocks_user ON public.theme_unlocks (user_id);

ALTER TABLE public.theme_unlocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS theme_unlocks_select_own ON public.theme_unlocks;
CREATE POLICY theme_unlocks_select_own ON public.theme_unlocks
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS theme_unlocks_svc ON public.theme_unlocks;
CREATE POLICY theme_unlocks_svc ON public.theme_unlocks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.theme_unlocks IS
  'Table themes a player has unlocked. Written by fn_redeem_shop_item; mirrors avatar_unlocks.';

-- ── Redemption ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_redeem_shop_item(p_inventory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row     club_shop_inventory;
  v_spec    jsonb;
  v_type    text;
  v_qty     integer;
  v_ref     text;
  v_uid     uuid := auth.uid();
  v_found   boolean;
  v_granted jsonb := jsonb_build_object('type', 'none');
BEGIN
  -- NULL uid must never satisfy the ownership test below (NULL <> x is NULL,
  -- which does not take the IF and previously fell through to granting).
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT * INTO v_row FROM club_shop_inventory WHERE id = p_inventory_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF v_row.user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_row.status = 'redeemed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_redeemed');
  END IF;

  SELECT grant_spec INTO v_spec FROM club_shop_items WHERE id = v_row.item_id;
  v_found := FOUND;

  IF NOT v_found THEN
    -- The catalogue row is gone; do not consume the inventory copy silently.
    RETURN jsonb_build_object('success', false, 'error', 'item_gone');
  END IF;

  v_type := COALESCE(v_spec->>'type', 'none');
  v_qty  := GREATEST(1, LEAST(1000, COALESCE((v_spec->>'qty')::integer, 1)));

  IF v_type = 'time_bank' THEN
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_row.user_id, 'time_bank_seconds', 0, 'per_use', v_qty, NULL);
    v_granted := jsonb_build_object('type', 'time_bank', 'uses', v_qty, 'seconds', v_qty * 20);

  ELSIF v_type = 'throwable' THEN
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_row.user_id, 'throwable', 0, 'per_use', v_qty, NULL);
    v_granted := jsonb_build_object('type', 'throwable', 'uses', v_qty);

  ELSIF v_type = 'emote_pack' THEN
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_row.user_id, 'emoji_pack', 0, 'permanent', NULL, NULL);
    v_granted := jsonb_build_object('type', 'emote_pack', 'permanent', true);

  ELSIF v_type = 'table_skin' THEN
    -- Per-item id when the admin did not name a theme, so two different skins
    -- can never collapse onto one unlock.
    v_ref := COALESCE(NULLIF(v_spec->>'theme_id', ''), v_row.item_id::text);
    INSERT INTO theme_unlocks (user_id, theme_id, unlock_method)
    VALUES (v_row.user_id, v_ref, 'club_shop')
    ON CONFLICT (user_id, theme_id) DO NOTHING;
    -- Generic flag kept for the existing VIP feature gate.
    INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (v_row.user_id, 'theme_unlock', 0, 'permanent', NULL, NULL);
    v_granted := jsonb_build_object('type', 'table_skin', 'permanent', true, 'theme_id', v_ref);

  ELSIF v_type = 'avatar' THEN
    v_ref := COALESCE(NULLIF(v_spec->>'avatar_id', ''), v_row.item_id::text);
    INSERT INTO avatar_unlocks (user_id, avatar_id, unlock_method)
    VALUES (v_row.user_id, v_ref, 'club_shop')
    ON CONFLICT DO NOTHING;
    v_granted := jsonb_build_object('type', 'avatar', 'avatar_id', v_ref);
  END IF;

  UPDATE club_shop_inventory
     SET status = 'redeemed', redeemed_at = now()
   WHERE id = p_inventory_id;

  RETURN jsonb_build_object('success', true, 'item_name', v_row.item_name, 'granted', v_granted);
END;
$function$;

-- ── Stock release, clamped ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_release_shop_stock(p_club_id uuid, p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_stock integer;
BEGIN
  SELECT stock INTO v_stock
    FROM club_shop_items
   WHERE id = p_item_id AND club_id = p_club_id
   FOR UPDATE;

  IF NOT FOUND OR v_stock IS NULL THEN
    RETURN; -- unlimited or gone: nothing to give back
  END IF;

  UPDATE club_shop_items
     SET stock = v_stock + 1
   WHERE id = p_item_id AND club_id = p_club_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_release_shop_stock(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_release_shop_stock(uuid, uuid) TO service_role;

DO $$
BEGIN
  IF to_regclass('public.theme_unlocks') IS NULL THEN
    RAISE EXCEPTION 'theme_unlocks missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_release_shop_stock(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_release_shop_stock must not be executable by authenticated';
  END IF;
END $$;
