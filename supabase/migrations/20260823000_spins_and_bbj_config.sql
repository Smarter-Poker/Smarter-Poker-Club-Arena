-- Add spins and bbj rake config to clubs
ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS bbj_rake_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS spins_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS spins_preseed_amount INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spins_wallet_funding TEXT DEFAULT 'PROMO';

-- Update the audit function to watch the new columns
CREATE OR REPLACE FUNCTION public.fn_audit_club_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_key     text;
  v_watched text[] := ARRAY[
    'name','description','is_public','requires_approval',
    'default_rake_percent','rake_cap',
    'allow_straddle','allow_run_it_twice','allow_rabbit_hunt',
    'min_buyin_bb','max_buyin_bb','logo_url',
    'bbj_rake_enabled', 'spins_enabled', 'spins_preseed_amount', 'spins_wallet_funding'];
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_key IN ARRAY v_watched LOOP
    IF (v_old -> v_key) IS DISTINCT FROM (v_new -> v_key) THEN
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    END IF;
  END LOOP;

  IF v_after = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id,
       before_state, after_state)
    VALUES
      (v_actor, public.fn_audit_actor_role(NEW.id, v_actor), 'update_club_settings', 'club', NEW.id, NEW.id,
       v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    -- Silently drop audit failure so we don't break the actual update
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_club_settings ON public.clubs;
CREATE TRIGGER trg_audit_club_settings
  AFTER UPDATE ON public.clubs
  FOR EACH ROW
  WHEN (
    OLD.name                 IS DISTINCT FROM NEW.name OR
    OLD.description          IS DISTINCT FROM NEW.description OR
    OLD.is_public            IS DISTINCT FROM NEW.is_public OR
    OLD.requires_approval    IS DISTINCT FROM NEW.requires_approval OR
    OLD.default_rake_percent IS DISTINCT FROM NEW.default_rake_percent OR
    OLD.rake_cap             IS DISTINCT FROM NEW.rake_cap OR
    OLD.allow_straddle       IS DISTINCT FROM NEW.allow_straddle OR
    OLD.allow_run_it_twice   IS DISTINCT FROM NEW.allow_run_it_twice OR
    OLD.allow_rabbit_hunt    IS DISTINCT FROM NEW.allow_rabbit_hunt OR
    OLD.min_buyin_bb         IS DISTINCT FROM NEW.min_buyin_bb OR
    OLD.max_buyin_bb         IS DISTINCT FROM NEW.max_buyin_bb OR
    OLD.logo_url             IS DISTINCT FROM NEW.logo_url OR
    OLD.bbj_rake_enabled     IS DISTINCT FROM NEW.bbj_rake_enabled OR
    OLD.spins_enabled        IS DISTINCT FROM NEW.spins_enabled OR
    OLD.spins_preseed_amount IS DISTINCT FROM NEW.spins_preseed_amount OR
    OLD.spins_wallet_funding IS DISTINCT FROM NEW.spins_wallet_funding
  )
  EXECUTE FUNCTION public.fn_audit_club_settings_change();
