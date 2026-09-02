-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827163012; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.sp_theme_asset_is_owned(p_user_id uuid, p_category text, p_asset_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_tier text; v_is_vip boolean;
BEGIN
  IF p_asset_id IS NULL OR btrim(p_asset_id) = '' THEN RETURN true; END IF;
  SELECT tier INTO v_tier FROM public.cosmetic_catalog WHERE category=p_category AND asset_id=p_asset_id;
  IF v_tier IS NULL THEN RETURN false; END IF;
  IF v_tier = 'free' THEN RETURN true; END IF;
  SELECT COALESCE(p.is_vip,false)
         AND (p.vip_tier='lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip FROM public.profiles p WHERE p.id = p_user_id;
  IF COALESCE(v_is_vip,false) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM public.theme_asset_unlocks u
                  WHERE u.user_id=p_user_id AND u.category=p_category AND u.asset_id=p_asset_id);
END; $$;

REVOKE EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid,text,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.sp_theme_asset_is_owned(uuid,text,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_user_theme_settings_entitlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.theme_id IS DISTINCT FROM OLD.theme_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id,'theme_id',NEW.theme_id) THEN
      RAISE EXCEPTION 'Theme "%" is VIP only', NEW.theme_id USING ERRCODE='42501'; END IF; END IF;
  IF TG_OP='INSERT' OR NEW.table_id IS DISTINCT FROM OLD.table_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id,'table_id',NEW.table_id) THEN
      RAISE EXCEPTION 'Table felt "%" is VIP only', NEW.table_id USING ERRCODE='42501'; END IF; END IF;
  IF TG_OP='INSERT' OR NEW.button_id IS DISTINCT FROM OLD.button_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id,'button_id',NEW.button_id) THEN
      RAISE EXCEPTION 'Dealer button "%" is VIP only', NEW.button_id USING ERRCODE='42501'; END IF; END IF;
  IF TG_OP='INSERT' OR NEW.background_id IS DISTINCT FROM OLD.background_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id,'background_id',NEW.background_id) THEN
      RAISE EXCEPTION 'Background "%" is VIP only', NEW.background_id USING ERRCODE='42501'; END IF; END IF;
  IF TG_OP='INSERT' OR NEW.cards_id IS DISTINCT FROM OLD.cards_id THEN
    IF NOT public.sp_theme_asset_is_owned(NEW.user_id,'cards_id',NEW.cards_id) THEN
      RAISE EXCEPTION 'Card back "%" is VIP only', NEW.cards_id USING ERRCODE='42501'; END IF; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_user_theme_settings_entitlement ON public.user_theme_settings;
CREATE TRIGGER trg_user_theme_settings_entitlement
  BEFORE INSERT OR UPDATE ON public.user_theme_settings
  FOR EACH ROW EXECUTE FUNCTION public.trg_user_theme_settings_entitlement();

DROP POLICY IF EXISTS "Users can update own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can update own theme settings" ON public.user_theme_settings
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DO $$
DECLARE v_orphan integer;
BEGIN
  SELECT count(*) INTO v_orphan FROM public.user_theme_settings s
   WHERE NOT public.sp_theme_asset_is_owned(s.user_id,'theme_id',s.theme_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id,'table_id',s.table_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id,'button_id',s.button_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id,'background_id',s.background_id)
      OR NOT public.sp_theme_asset_is_owned(s.user_id,'cards_id',s.cards_id);
  IF v_orphan > 0 THEN
    RAISE EXCEPTION '% player(s) equip an asset they do not own - grandfathering missed them', v_orphan;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.user_theme_settings'::regclass
                  AND tgname='trg_user_theme_settings_entitlement') THEN
    RAISE EXCEPTION 'entitlement trigger missing';
  END IF;
END $$;
