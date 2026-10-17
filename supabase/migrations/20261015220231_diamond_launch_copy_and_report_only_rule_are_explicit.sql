-- Reserved through scripts/new-migration.mjs. Diamond audit DA-02, DA-04 and DA-05.
-- No balances, prices, guarantees, payouts, switches or schedules are enabled/disabled.
-- DA-02: only the phrase Chip Guarantee denotes the wrong payout asset. Starting
-- Chips remain tournament chips. Normalize it at both schedule and event creation,
-- and correct existing active copy. The registered-event guard allows exactly this
-- deterministic old-to-new copy transform for a Diamond club; all other keys stay protected.
-- DA-05: ruling 13 already says concentration/velocity stays report-only. Make the
-- due reader say that, and refuse a direct attempt to arm it. No forecast is weakened.
-- DA-04: October mint plan omitted the authorized 100,000,000 seeded bankroll;
-- add that one-time seed to its existing 2,400,000 recurring plan (102,400,000).
-- Catalog plan: measured complete UTC daily peak October 1-14 = 4,895; 31 days
-- at that peak = 151,745, rounded up to 152,000. This is a finite measured plan,
-- never a player cap. Historical issuance and frozen spent baselines are untouched.
-- Qualified on isolated PostgreSQL with the exact captured guard and rule functions.
-- @live-proof: (SELECT to_regprocedure('public.fn_ca_diamond_guarantee_copy(text)') IS NOT NULL AND position('report-only' IN pg_get_functiondef('public.fn_ca_diamond_rule_flip_due(boolean)'::regprocedure)) > 0 AND EXISTS (SELECT 1 FROM public.ca_declared_money_triggers WHERE table_name='tournaments' AND trigger_name='aa_diamond_guarantee_copy'))
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_guarantee_copy(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $f$ SELECT replace(p_text, 'Chip Guarantee', 'Diamond Guarantee') $f$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_guarantee_copy(text) TO authenticated, service_role;
CREATE FUNCTION pg_temp.da_substitute(p_sig text,p_before text,p_after text,p_old text,p_new text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d text; a text; o oid; acl aclitem[]; owner_id oid; definer boolean; config text[];
BEGIN
 o:=p_sig::regprocedure;
 SELECT pg_get_functiondef(o),proacl,proowner,prosecdef,proconfig INTO d,acl,owner_id,definer,config FROM pg_proc WHERE oid=o;
 IF md5(d)<>p_before OR (length(d)-length(replace(d,p_old,'')))/length(p_old)<>1 THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PREIMAGE_CHANGED: %',p_sig; END IF;
 a:=replace(d,p_old,p_new);
 IF md5(a)<>p_after THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_DERIVATION_CHANGED'; END IF;
 EXECUTE a;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=o AND md5(pg_get_functiondef(o))=p_after AND proacl IS NOT DISTINCT FROM acl AND proowner=owner_id AND prosecdef=definer AND proconfig IS NOT DISTINCT FROM config) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_METADATA_CHANGED'; END IF;
END $f$;
SELECT pg_temp.da_substitute('public.fn_guard_managed_game_lifecycle()', '8cfc08644affe56e2e48639f93691483', 'd223c76125333604fde0fc88afb372ad', $old$              public.fn_ca_text_without_dollar(v_old_document ->> v_key);$old$, $new$              public.fn_ca_text_without_dollar(v_old_document ->> v_key);
        -- Only the canonical Diamond denomination correction may alter a registered event.
        CONTINUE WHEN v_key IN ('name', 'short_description', 'description')
          AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
          AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds')
          AND jsonb_typeof(v_old_document -> v_key) = 'string'
          AND (v_new_document ->> v_key) IS NOT DISTINCT FROM
              public.fn_ca_diamond_guarantee_copy(v_old_document ->> v_key);$new$);
SELECT pg_temp.da_substitute('public.fn_ca_diamond_rule_flip(text,text)', '4415c68909645e3147ff1c3720eec152', '9ea640b1fc6180bc65cf536f8e0cfc31', $old$  SELECT * INTO v_row FROM public.ca_diamond_rule_modes WHERE rule = p_rule FOR UPDATE;$old$, $new$  IF p_rule = 'DR13:concentration_or_velocity' THEN
    RAISE EXCEPTION 'DR13 is report-only by ruling 13; there is no movement to refuse';
  END IF;
  SELECT * INTO v_row FROM public.ca_diamond_rule_modes WHERE rule = p_rule FOR UPDATE;$new$);
SELECT pg_temp.da_substitute('public.fn_ca_diamond_rule_flip_due(boolean)', '5225575bf9aa1140e13319d1054e7372', '2e76a998f50ebee84af441c816e3949c', $old$    v_window := GREATEST(24, r.clean_days_required * 24);$old$, $new$    IF r.rl = 'DR13:concentration_or_velocity' THEN
      RETURN QUERY SELECT r.rl, 'report-only'::text,
        'Ruling 13 keeps concentration and velocity reporting only; no movement is refused.'::text;
      CONTINUE;
    END IF;
    v_window := GREATEST(24, r.clean_days_required * 24);$new$);
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_guarantee_copy_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $f$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND c.asset='diamonds') THEN RETURN NEW; END IF;
 NEW.name:=public.fn_ca_diamond_guarantee_copy(NEW.name);
 NEW.description:=public.fn_ca_diamond_guarantee_copy(NEW.description);
 IF TG_TABLE_NAME='tournaments' THEN
  NEW.short_description:=public.fn_ca_diamond_guarantee_copy(NEW.short_description);
 ELSE
  NEW.config:=NEW.config
   || CASE WHEN jsonb_typeof(NEW.config->'name')='string' THEN jsonb_build_object('name',public.fn_ca_diamond_guarantee_copy(NEW.config->>'name')) ELSE '{}'::jsonb END
   || CASE WHEN jsonb_typeof(NEW.config->'shortDescription')='string' THEN jsonb_build_object('shortDescription',public.fn_ca_diamond_guarantee_copy(NEW.config->>'shortDescription')) ELSE '{}'::jsonb END
   || CASE WHEN jsonb_typeof(NEW.config->'satelliteTargetName')='string' THEN jsonb_build_object('satelliteTargetName',public.fn_ca_diamond_guarantee_copy(NEW.config->>'satelliteTargetName')) ELSE '{}'::jsonb END;
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_guarantee_copy_trigger() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER aa_diamond_guarantee_copy BEFORE INSERT OR UPDATE OF name,description,config ON public.tournament_schedules FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_guarantee_copy_trigger();
CREATE TRIGGER aa_diamond_guarantee_copy BEFORE INSERT OR UPDATE OF name,description,short_description ON public.tournaments FOR EACH ROW WHEN (NEW.status NOT IN ('COMPLETED','CANCELLED','CANCELED')) EXECUTE FUNCTION public.fn_ca_diamond_guarantee_copy_trigger();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES ('tournaments','aa_diamond_guarantee_copy','Diamond denomination copy only; numeric and lifecycle fields unchanged.');
UPDATE public.tournament_schedules s SET name=s.name WHERE EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=s.club_id AND c.asset='diamonds') AND (s.name LIKE '%Chip Guarantee%' OR s.description LIKE '%Chip Guarantee%' OR s.config::text LIKE '%Chip Guarantee%');
UPDATE public.tournaments t SET name=t.name WHERE t.status NOT IN ('COMPLETED','CANCELLED','CANCELED') AND EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=t.club_id AND c.asset='diamonds') AND (t.name LIKE '%Chip Guarantee%' OR t.description LIKE '%Chip Guarantee%' OR t.short_description LIKE '%Chip Guarantee%');
DO $f$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.diamond_reward_budgets WHERE period='2026-10' AND engine='mint' AND budget_diamonds=2400000) OR NOT EXISTS(SELECT 1 FROM public.diamond_reward_budgets WHERE period='2026-10' AND engine='catalog_v2' AND budget_diamonds=50000) THEN RAISE EXCEPTION 'DIAMOND_CLOSURE_PLAN_PREIMAGE_CHANGED'; END IF;
 UPDATE public.diamond_reward_budgets SET budget_diamonds=102400000 WHERE period='2026-10' AND engine='mint' AND budget_diamonds=2400000;
 UPDATE public.diamond_reward_budgets SET budget_diamonds=152000 WHERE period='2026-10' AND engine='catalog_v2' AND budget_diamonds=50000;
 PERFORM public.fn_ca_diamond_incident('DR0:launch_plan_derivation','info',NULL,NULL,'20261015220231',jsonb_build_object('mint_plan',102400000,'seeded_bankroll',100000000,'recurring_plan',2400000,'catalog_plan',152000,'catalog_measured_daily_peak',4895,'days',31,'note','Finite reporting plans only. No player cap, balance or spent baseline changed.'));
END $f$;
COMMIT;
