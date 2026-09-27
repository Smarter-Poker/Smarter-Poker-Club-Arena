-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424001538 "20260421098000_bug22_fn_sync_profile_vip_status_schema_drift"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75451301e590fb2ee26edd835dc7ff47 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-22: fn_sync_profile_vip_status trigger has three schema drifts:
--   vip_subscriptions.expires_at → current_period_end
--   vip_subscriptions.is_active  → status = 'active' (+ trialing)
--   profiles.vip_level           → vip_tier
--
-- Impact: every insert/update on vip_subscriptions 500s → VIP status
-- never syncs to profiles.is_vip / vip_tier / vip_expires_at. VIP
-- purchases appear to fail from the UI side (trigger rollback cascades).
--
-- This trigger is the VIP → profile sync. Fixing the column names
-- restores the sync.

CREATE OR REPLACE FUNCTION public.fn_sync_profile_vip_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_is_vip     boolean;
  v_vip_tier   text;
  v_expires_at timestamptz;
BEGIN
  SELECT vs.tier, vs.current_period_end
    INTO v_vip_tier, v_expires_at
    FROM vip_subscriptions vs
   WHERE vs.user_id = NEW.user_id
     AND vs.status IN ('active', 'trialing')
     AND vs.current_period_end > NOW()
   ORDER BY CASE vs.tier
              WHEN 'gold'   THEN 3
              WHEN 'silver' THEN 2
              ELSE 1
            END DESC
   LIMIT 1;

  v_is_vip := v_vip_tier IS NOT NULL;

  UPDATE profiles
     SET is_vip         = v_is_vip,
         vip_tier       = COALESCE(v_vip_tier, 'none'),
         vip_expires_at = v_expires_at
   WHERE id = NEW.user_id;

  RETURN NEW;
END;
$function$;
