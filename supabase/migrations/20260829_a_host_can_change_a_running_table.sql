-- ═══════════════════════════════════════════════════════════════════════════
-- A HOST CAN CHANGE A RUNNING TABLE (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every bomb-pot setting on this platform has been WRITE-ONCE. TableConfigPage
-- takes a `gameType` and never a table id, has no hydration path, and ends in
-- an INSERT. So a host who shipped a table with the wrong frequency, or wanted
-- to raise the ante, or wanted to turn bomb pots OFF on a table that was
-- annoying their players, had exactly one option: kill the table and build a
-- new one — losing every seated player to fix a number.
--
-- There is also no route by which a browser COULD change it. `public.tables`
-- has no UPDATE policy at all (checked: zero UPDATE/ALL policies), which is
-- correct — a table row is engine state and a client has no business writing
-- it directly. So the fix is a role-gated function, not a policy.
--
-- WHY ONLY THESE COLUMNS. The engine re-reads exactly this set on its own
-- throttled refresh (ServerTableEngineBase.refreshRakeConfig), which is what
-- makes them safe to change under a live table: the next hand plays by the new
-- rules, with no restart and nothing to reconcile. Everything else about a
-- table — its variant, its blinds, its seat count, its buy-in range — is
-- either baked into seated players' stacks or read once at engine start, and
-- changing it mid-session would mean something quite different from "the host
-- edited a setting". Those stay create-time on purpose, and this function
-- refuses them by simply not having them.
--
-- Authorization is the same owner / co_owner / admin test
-- fn_request_manual_bomb_pot uses, and every accepted change is written to
-- bomb_pot_manual_requests' sibling audit table so a rule that changed under a
-- player has a name and a timestamp attached to it.
--
-- Tier 2: one new audit table, one new SECURITY DEFINER function. No existing
-- object is altered.

CREATE TABLE IF NOT EXISTS public.table_settings_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id uuid NOT NULL,
  club_id uuid NOT NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  before jsonb NOT NULL,
  after jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_table_settings_changes_table
  ON public.table_settings_changes (table_id, changed_at DESC);
ALTER TABLE public.table_settings_changes ENABLE ROW LEVEL SECURITY;
-- No policies, deliberately: a definer-only audit trail, same posture as
-- bomb_pot_manual_requests.
REVOKE ALL ON public.table_settings_changes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_update_table_bomb_settings(
  p_table_id uuid,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_club  uuid;
  v_role  text;
  v_owner boolean := false;
  v_before jsonb;
  v_after  jsonb;
  -- Validated locals
  v_enabled   boolean;
  v_mode      text;
  v_freq      int;
  v_interval  int;
  v_boards    int;
  v_minp      int;
  v_anteBB    numeric;
  v_anteFix   numeric;
  v_variant   text;
  v_button    text;
  v_announce  int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT club_id INTO v_club FROM public.tables WHERE id = p_table_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_club AND c.owner_id = v_uid)
    INTO v_owner;
  SELECT lower(cm.role) INTO v_role
  FROM public.club_members cm
  WHERE cm.club_id = v_club AND cm.user_id = v_uid
  LIMIT 1;

  IF NOT (v_owner OR v_role IN ('owner', 'co_owner', 'admin')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- ── Validate every field. A rule the engine would clamp anyway is clamped
  -- HERE too, so the row never holds a value the felt would misreport.
  v_enabled := COALESCE((p_settings ->> 'bomb_pot_enabled')::boolean, false);

  v_mode := lower(COALESCE(p_settings ->> 'bomb_pot_trigger_mode', 'every_n_hands'));
  IF v_mode NOT IN ('every_n_hands', 'once_per_orbit', 'timed', 'bomb_pot_only') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_trigger_mode');
  END IF;

  v_freq := GREATEST(COALESCE((p_settings ->> 'bomb_pot_frequency')::int, 0), 0);
  -- every_n_hands with frequency 0 can never fire; the scheduler treats that
  -- as bomb-pots-off, so refuse it rather than silently disabling the feature
  -- the host just switched on.
  IF v_enabled AND v_mode = 'every_n_hands' AND v_freq < 1 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frequency_must_be_at_least_1');
  END IF;

  v_interval := COALESCE((p_settings ->> 'bomb_pot_interval_seconds')::int, 0);
  IF v_enabled AND v_mode = 'timed' AND v_interval < 60 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'interval_must_be_at_least_60s');
  END IF;

  v_boards := LEAST(GREATEST(COALESCE((p_settings ->> 'bomb_pot_board_count')::int, 1), 1), 3);
  v_minp   := LEAST(GREATEST(COALESCE((p_settings ->> 'bomb_pot_min_players')::int, 3), 2), 10);
  v_anteBB := GREATEST(COALESCE((p_settings ->> 'bomb_pot_ante_multiplier')::numeric, 0), 0);
  v_anteFix := NULLIF(GREATEST(COALESCE((p_settings ->> 'bomb_pot_ante_fixed')::numeric, 0), 0), 0);

  v_variant := NULLIF(lower(COALESCE(p_settings ->> 'bomb_pot_variant', '')), '');
  IF v_variant IS NOT NULL AND v_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_variant');
  END IF;

  v_button := lower(COALESCE(p_settings ->> 'bomb_pot_button_policy', 'regular'));
  IF v_button NOT IN ('regular', 'separate') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_button_policy');
  END IF;

  v_announce := GREATEST(COALESCE((p_settings ->> 'bomb_pot_announce_seconds')::int, 0), 0);

  SELECT to_jsonb(t) - 'settings' INTO v_before
  FROM (
    SELECT bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_frequency,
           bomb_pot_interval_seconds, bomb_pot_board_count, bomb_pot_min_players,
           bomb_pot_ante_multiplier, bomb_pot_ante_fixed, bomb_pot_variant,
           bomb_pot_button_policy, bomb_pot_announce_seconds, bomb_pot_double_board
    FROM public.tables WHERE id = p_table_id
  ) t;

  UPDATE public.tables SET
    bomb_pot_enabled           = v_enabled,
    bomb_pot_trigger_mode      = CASE WHEN v_enabled THEN v_mode ELSE 'every_n_hands' END,
    bomb_pot_frequency         = CASE WHEN v_enabled THEN v_freq ELSE 0 END,
    bomb_pot_interval_seconds  = CASE WHEN v_enabled AND v_mode = 'timed' THEN v_interval ELSE NULL END,
    bomb_pot_board_count       = CASE WHEN v_enabled THEN v_boards ELSE 1 END,
    bomb_pot_min_players       = CASE WHEN v_enabled THEN v_minp ELSE 3 END,
    bomb_pot_ante_multiplier   = CASE WHEN v_enabled THEN v_anteBB ELSE 0 END,
    bomb_pot_ante_fixed        = CASE WHEN v_enabled THEN v_anteFix ELSE NULL END,
    bomb_pot_variant           = CASE WHEN v_enabled THEN v_variant ELSE NULL END,
    bomb_pot_button_policy     = CASE WHEN v_enabled THEN v_button ELSE 'regular' END,
    bomb_pot_announce_seconds  = CASE WHEN v_enabled AND v_mode = 'timed' AND v_announce > 0
                                      THEN v_announce ELSE NULL END,
    -- The legacy pair the lobby and older engine builds still read.
    bomb_pot_double_board      = v_enabled AND v_boards >= 2,
    -- LIVE STATE IS NOT CONFIG. Turning bomb pots off, or changing the mode,
    -- must not leave a token or a clock from the old schedule to detonate
    -- later — the same rule fn_clone_table_row enforces for a cloned table and
    -- the engine enforces in memory. Cleared on EVERY edit: a host who moves
    -- from every-10-hands to timed is starting a new schedule, not resuming.
    bomb_pot_sched_state       = NULL,
    bomb_pot_next_due_at       = NULL,
    bomb_pot_manual_pending    = false
  WHERE id = p_table_id;

  SELECT to_jsonb(t) INTO v_after
  FROM (
    SELECT bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_frequency,
           bomb_pot_interval_seconds, bomb_pot_board_count, bomb_pot_min_players,
           bomb_pot_ante_multiplier, bomb_pot_ante_fixed, bomb_pot_variant,
           bomb_pot_button_policy, bomb_pot_announce_seconds, bomb_pot_double_board
    FROM public.tables WHERE id = p_table_id
  ) t;

  -- Only record a row when something actually moved. A host opening the form
  -- and pressing save should not manufacture an audit entry.
  IF v_before IS DISTINCT FROM v_after THEN
    INSERT INTO public.table_settings_changes (table_id, club_id, changed_by, before, after)
    VALUES (p_table_id, v_club, v_uid, v_before, v_after);
  END IF;

  RETURN jsonb_build_object('ok', true, 'changed', v_before IS DISTINCT FROM v_after,
                            'settings', v_after);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_update_table_bomb_settings(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_update_table_bomb_settings(uuid, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_update_table_bomb_settings(uuid, jsonb) IS
  'Role-gated edit of the bomb-pot settings on a LIVE table. Only the columns '
  'the engine re-reads on its throttled refresh, so the next hand plays by the '
  'new rules with no restart. Clears bomb live state on every edit. Audited to '
  'table_settings_changes.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_update_table_bomb_settings'
  ) THEN
    RAISE EXCEPTION 'assertion failed: fn_update_table_bomb_settings missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'fn_update_table_bomb_settings'
      AND grantee = 'anon'
  ) THEN
    RAISE EXCEPTION 'assertion failed: anon can execute fn_update_table_bomb_settings';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'table_settings_changes'
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
  ) THEN
    RAISE EXCEPTION 'assertion failed: the settings audit trail is not definer-only';
  END IF;
END $$;

-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.fn_update_table_bomb_settings(uuid, jsonb);
--   DROP TABLE IF EXISTS public.table_settings_changes;
--   (Dropping these restores write-once behaviour: a host wanting to change a
--    bomb setting is back to killing the table and losing its players.)
