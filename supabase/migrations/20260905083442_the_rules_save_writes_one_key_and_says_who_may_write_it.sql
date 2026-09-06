-- ═══════════════════════════════════════════════════════════════════════════
--  THE RULES SAVE WRITES ONE KEY, AND SAYS WHO MAY WRITE IT
--  Club Operations upgrade, phase 8 of 8. Club control.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ClubRulesPage` saves the club's rules like this:
--
--     const { data: cur } = await supabase.from('clubs').select('settings')...
--     const newSettings = { ...(cur?.settings || {}), rules_text: ... };
--     const { error } = await supabase.from('clubs')
--       .update({ settings: newSettings }).eq(saveCol, saveVal);
--     if (error) throw error;
--     toast.success('Club rules updated!');
--
-- Three defects in six lines, and they compound.
--
-- 1. THE UPDATE HAS NO `.select()`, and the `clubs` UPDATE policy is
--    `owner_id = auth.uid()` - verified against `pg_policy`, it is the only
--    one. A co-owner or admin saving rules matches zero rows: PostgREST
--    returns 204, `error` is null, the page paints the new text and toasts
--    "Club rules updated!". Nothing was written. This is the same shape phase 7
--    found on the settlement page's auto-settlement toggle, on a page that
--    OFFERS the button to every staff role.
--
-- 2. IT IS A READ-MODIFY-WRITE OF THE WHOLE `settings` JSONB, which on this
--    club carries seven other keys: `rake_cap`, `min_buy_in_bb`,
--    `max_buy_in_bb`, `allow_straddle`, `allow_run_it_twice`,
--    `time_bank_seconds`, `default_rake_percent`. Two operators saving in the
--    same minute - one editing rules, one editing buy-ins on the settings page
--    - and the later write carries the earlier one's stale copy of everything
--    else. A lost update on the club's rake cap, caused by editing prose.
--
-- 3. A RULES REWRITE LEAVES NO TRACE. `fn_audit_club_settings_change` watches
--    sixteen columns and `settings` is not among them (nor are `tagline` and
--    `lobby_message`). The rules a member is held to could change with nothing
--    recording who changed them or from what.
--
-- ─── THE FIX ───────────────────────────────────────────────────────────────
--
-- `fn_set_club_rules` writes ONE KEY with `jsonb_set`, so no other key is read
-- or rewritten and there is nothing to lose in a race. It gates on owner,
-- co-owner or admin - the same three roles `fn_promo_vault_can_manage` uses
-- and the same three the page already shows the button to - which resolves the
-- mismatch in the direction the page always implied. And it RETURNS what it
-- stored, so a client that gets a row back knows the write happened and a
-- client that gets none knows it did not.
--
-- The audit trigger's watched set gains `settings`, `tagline` and
-- `lobby_message` in the same migration, because a rule with no record of who
-- set it is not much better than no rule.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_set_club_rules(p_club_id uuid, p_rules text)
RETURNS TABLE(club_id uuid, rules_text text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_role  text;
  v_text  text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'no club was named' USING ERRCODE = '22004';
  END IF;

  -- Owner, co-owner or admin. The owner is checked separately because a club's
  -- owner is not required to hold a `club_members` row.
  SELECT lower(cm.role) INTO v_role
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
     AND coalesce(cm.status, 'approved') NOT IN ('banned', 'rejected', 'left');

  IF NOT (EXISTS (SELECT 1 FROM public.clubs c
                   WHERE c.id = p_club_id AND c.owner_id = v_uid)
          OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RAISE EXCEPTION 'only an owner, co-owner or admin can change the club rules'
      USING ERRCODE = '42501';
  END IF;

  -- 60,000 characters is the page's own cap. Enforced here as well, because a
  -- limit that lives only in a text area is not a limit.
  v_text := left(coalesce(p_rules, ''), 60000);

  -- ONE KEY. Never a read-modify-write of the whole document: everything else
  -- in `settings` is left exactly as the row holds it at the moment of the
  -- write, so a concurrent buy-in change cannot be rolled back by a rules save.
  UPDATE public.clubs c
     SET settings = jsonb_set(
           coalesce(c.settings, '{}'::jsonb), '{rules_text}', to_jsonb(v_text), true)
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no club with that id' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT c.id, c.settings ->> 'rules_text', c.updated_at
    FROM public.clubs c WHERE c.id = p_club_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_set_club_rules(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_set_club_rules(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_set_club_rules(uuid, text) IS
  'Writes clubs.settings->>rules_text and nothing else, for an owner, co-owner or admin, and returns what it stored. The page used to read the whole settings document, merge one key into it and write it back with no .select(), so an RLS refusal toasted success and a concurrent buy-in edit was silently reverted.';

-- ───────────────────────────────────────────────────────────────────────────
--  The audit trigger learns about the three columns it was missing
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_audit_club_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor   uuid := auth.uid();
  v_before  jsonb := '{}'::jsonb;
  v_after   jsonb := '{}'::jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_key     text;
  -- `settings`, `tagline` and `lobby_message` are new here. The rules a member
  -- is held to live inside `settings`, and a rewrite used to leave no trace at
  -- all: no row, no actor, no before.
  v_watched text[] := ARRAY[
    'name','description','is_public','requires_approval',
    'default_rake_percent','rake_cap',
    'allow_straddle','allow_run_it_twice','allow_rabbit_hunt',
    'min_buyin_bb','max_buyin_bb','logo_url',
    'bbj_rake_enabled','spins_enabled','spins_preseed_amount','spins_wallet_funding',
    'settings','tagline','lobby_message'];
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

  -- The same target and the same swallow the original used. An audit row must
  -- never be the reason a club cannot be saved, and this migration is here to
  -- widen what is watched, not to change where it is written.
  BEGIN
    INSERT INTO public.audit_trail
      (actor_id, actor_role, action, target_type, target_id, club_id,
       before_state, after_state)
    VALUES
      (v_actor, public.fn_audit_actor_role(NEW.id, v_actor), 'update_club_settings',
       'club', NEW.id, NEW.id, v_before, v_after);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_set_club_rules'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%jsonb_set(%' THEN
    RAISE EXCEPTION 'the rules save still rewrites the whole settings document';
  END IF;
  IF v_src NOT LIKE '%RETURN QUERY%' THEN
    RAISE EXCEPTION 'the rules save does not return what it stored, so a refusal reads as a success';
  END IF;
  IF v_src NOT LIKE '%42501%' THEN
    RAISE EXCEPTION 'the rules save does not refuse anybody';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_audit_club_settings_change'
       AND pronamespace = 'public'::regnamespace) NOT LIKE '%''settings'',''tagline'',''lobby_message''%' THEN
    RAISE EXCEPTION 'the audit trigger still cannot see a rules rewrite';
  END IF;
END $$;

COMMIT;
