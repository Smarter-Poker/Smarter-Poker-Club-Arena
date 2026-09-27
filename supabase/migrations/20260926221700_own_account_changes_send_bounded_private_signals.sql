-- 20260926221700_own_account_changes_send_bounded_private_signals.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- profiles is deliberately outside the WAL publication. Notify only the owner
-- when their displayed metadata, profile-owned preferences or canonical diamond
-- balance actually changes. No financial/statistical row is replicated, and no
-- notification is sent for per-hand totals, horse state or presence timestamps.
-- profiles.diamonds is canonical; its existing trigger maintains diamond_wallets.
-- Table controls/artwork keep their own published carriers. The remaining three
-- profile-owned settings are whitelisted; internal/legacy JSON keys are ignored.

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

CREATE POLICY "players receive their own account change signal"
ON realtime.messages FOR SELECT TO authenticated
USING (extension = 'broadcast' AND (SELECT realtime.topic()) =
  'profile-account:' || (SELECT auth.uid())::text);

CREATE FUNCTION public.fn_publish_profile_account_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_domains text[] := ARRAY[]::text[];
BEGIN
  IF ROW(OLD.username, OLD.display_name, OLD.alias, OLD.first_name, OLD.last_name,
         OLD.full_name, OLD.display_name_preference, OLD.use_real_name,
         OLD.bio, OLD.player_tags, OLD.login_streak, OLD.vip_tier)
    IS DISTINCT FROM
     ROW(NEW.username, NEW.display_name, NEW.alias, NEW.first_name, NEW.last_name,
         NEW.full_name, NEW.display_name_preference, NEW.use_real_name,
         NEW.bio, NEW.player_tags, NEW.login_streak, NEW.vip_tier)
  THEN v_domains := array_append(v_domains, 'metadata'); END IF;
  IF ROW(OLD.settings->'theme', OLD.settings->'achievementNotifications',
         OLD.settings->'settlementAlerts') IS DISTINCT FROM
     ROW(NEW.settings->'theme', NEW.settings->'achievementNotifications',
         NEW.settings->'settlementAlerts')
  THEN v_domains := array_append(v_domains, 'settings'); END IF;
  IF OLD.diamonds IS DISTINCT FROM NEW.diamonds
  THEN v_domains := array_append(v_domains, 'diamonds'); END IF;

  IF cardinality(v_domains) = 0 THEN RETURN NEW; END IF;
  BEGIN
    PERFORM realtime.send(jsonb_build_object('user_id', NEW.id, 'domains', v_domains),
      'account_changed', 'profile-account:' || NEW.id::text, true);
  EXCEPTION WHEN OTHERS THEN
    -- Source persistence must never depend on notification availability.
    -- Initial, rejoin and visibility reads recover the authoritative value.
    RAISE WARNING 'Account change signal delivery failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_publish_profile_account_change()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER profile_account_changed
AFTER UPDATE OF username, display_name, alias, first_name, last_name, full_name,
  display_name_preference, use_real_name, bio, player_tags,
  login_streak, vip_tier, settings, diamonds ON public.profiles
FOR EACH ROW WHEN (
  ROW(OLD.username, OLD.display_name, OLD.alias, OLD.first_name, OLD.last_name,
      OLD.full_name, OLD.display_name_preference, OLD.use_real_name,
      OLD.bio, OLD.player_tags, OLD.login_streak, OLD.vip_tier,
      OLD.settings->'theme', OLD.settings->'achievementNotifications',
      OLD.settings->'settlementAlerts', OLD.diamonds)
  IS DISTINCT FROM
  ROW(NEW.username, NEW.display_name, NEW.alias, NEW.first_name, NEW.last_name,
      NEW.full_name, NEW.display_name_preference, NEW.use_real_name,
      NEW.bio, NEW.player_tags, NEW.login_streak, NEW.vip_tier,
      NEW.settings->'theme', NEW.settings->'achievementNotifications',
      NEW.settings->'settlementAlerts', NEW.diamonds)
)
EXECUTE FUNCTION public.fn_publish_profile_account_change();

COMMENT ON FUNCTION public.fn_publish_profile_account_change() IS
'Owner-only account invalidation with identity and domain names; no values, table fan-out, financial mutation or per-hand statistics.';

COMMIT;
