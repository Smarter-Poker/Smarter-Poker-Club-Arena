-- ═══════════════════════════════════════════════════════════════════════════
--  THE DELIVERY LOOKUP READS A CATALOGUE ANYONE MAY READ
--  Club Operations upgrade, phase 8 of 8. Correction to 20260905083005.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `scripts/ci/check-telemetry-exposure.mjs` failed the branch on
-- `fn_promo_vault_delivery_for`, and it was right to:
--
--   "SECURITY DEFINER, takes no identity argument, never looks at who is
--    calling, and a logged-in account can execute them."
--
-- All three are true. What the guard cannot know is whether the function needs
-- to be a definer at all, and this one does not. It reads exactly one table,
-- `promo_vault_catalog`, which carries RLS with a read policy and is granted
-- to `authenticated` - the vault page renders it directly, and a PostgREST
-- select on it answers 200 for a signed-in caller today.
--
-- So the fix is not an allowlist entry explaining why a definer is acceptable.
-- It is to stop being a definer: as SECURITY INVOKER the function can see
-- precisely what its caller can see, which for this catalogue is the same
-- thing, and the exposure the guard is describing stops existing rather than
-- being excused.
--
-- `ca_promo_vault_grant` still calls it, and still works: that function IS a
-- definer owned by `postgres`, so the nested call runs with the owner's rights
-- either way.
--
-- The lesson is worth keeping. SECURITY DEFINER was reached for out of habit
-- while writing a migration full of definers; the question "what does this
-- need to see that its caller cannot" was never asked. The guard asked it.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';

CREATE OR REPLACE FUNCTION public.fn_promo_vault_delivery_for(p_item_key text)
RETURNS TABLE(feature text, uses_per_unit integer, duration_days integer, why_not text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cat record;
BEGIN
  SELECT c.item_key, c.category, c.pack_size, c.duration_days, c.label
    INTO v_cat
    FROM public.promo_vault_catalog c
   WHERE c.item_key = p_item_key;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
      'That Item Is Not In The Catalogue.'::text;
    RETURN;
  END IF;

  IF v_cat.item_key LIKE 'time_bank%' THEN
    RETURN QUERY SELECT 'time_bank_seconds'::text,
                        COALESCE(v_cat.pack_size, 1)::int,
                        v_cat.duration_days::int, NULL::text;
    RETURN;
  END IF;

  IF v_cat.item_key LIKE 'rabbit_hunt%' THEN
    RETURN QUERY SELECT 'rabbit_hunt'::text,
                        COALESCE(v_cat.pack_size, 1)::int,
                        v_cat.duration_days::int, NULL::text;
    RETURN;
  END IF;

  IF v_cat.category = 'vip_card' THEN
    RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
      ('A ' || v_cat.label || ' Cannot Be Sent Yet. This Platform Has No Tier Ladder To Put A Player On, So Nothing Would Reach Them. Your Stock Has Not Been Touched.')::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
    (v_cat.label || ' Cannot Be Sent Yet. Nothing On The Platform Reads It, So The Player Would Receive Nothing. Your Stock Has Not Been Touched.')::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_vault_delivery_for(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_vault_delivery_for(text) TO authenticated, service_role;

DO $$
BEGIN
  IF (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_promo_vault_delivery_for') THEN
    RAISE EXCEPTION 'the delivery lookup is still a definer a browser can reach';
  END IF;

  -- And the grant, which is a definer, must still be able to use it.
  IF (SELECT why_not FROM public.fn_promo_vault_delivery_for('mystery_card_30d')) IS NULL THEN
    RAISE EXCEPTION 'the lookup stopped refusing the undeliverable items';
  END IF;
  IF (SELECT feature FROM public.fn_promo_vault_delivery_for('time_bank_50'))
       IS DISTINCT FROM 'time_bank_seconds' THEN
    RAISE EXCEPTION 'the lookup stopped resolving the deliverable ones';
  END IF;
END $$;

COMMIT;
