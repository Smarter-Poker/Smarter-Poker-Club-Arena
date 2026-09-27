-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421050840 "20260421051000_bug8_create_home_game_from_template_broken"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 493acc914730ad7a83dc68a84d01c8da of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-8 (CRITICAL, customer-breaking — function 100% broken since birth)
--
-- create_home_game_from_template throws at runtime on every call because of
-- three distinct bugs in the INSERT clause:
--
--   1) v_group.address  —  commander_home_groups has NO `address` column.
--      Runtime error: record "v_group" has no field "address" (42703).
--      Discovered via plpgsql_check static analysis.
--
--   2) CASE WHEN v_group.is_private THEN 'members' ELSE 'rsvpd' END
--      Both branches produce values that VIOLATE the CHECK constraint on
--      commander_home_games.address_visible_to. The allowed set is
--      {'all', 'rsvp', 'approved'} — 'members' and 'rsvpd' both fail.
--      Even if (1) is bypassed by passing p_address, (2) blows up with
--      CHECK violation (23514) when p_address_visible_to is NULL (the
--      default).
--
-- Impact: users trying to quickly spin up a game from a saved template
-- get a 500 error every time. The code path around Quick-Start / Recurring
-- / Template-based create is entirely unusable. Unnoticed because the
-- feature is likely rarely used and the UI just shows generic "failed."
--
-- Fix:
--   (a) drop the bogus v_group.address fallback — there's no column to
--       source it from. The caller passes p_address explicitly; if NULL,
--       the new game just has no address (column is nullable).
--   (b) map the visibility default to valid enum values:
--         is_private → 'approved'   (private group: only approved members see address)
--         else       → 'rsvp'       (public group: RSVP-yes see address)
--       Matches the intent expressed by the original author's bad labels.
--
-- (Also noted but not fixing: plpgsql_check flagged "unused variable
-- v_week" in fn_generate_recurring_home_games and "unused variable
-- v_completion" in compute_home_group_quality_score — pure style, not
-- bugs, skipping.)

CREATE OR REPLACE FUNCTION public.create_home_game_from_template(
    p_template_id uuid,
    p_scheduled_date date,
    p_caller_user_id uuid,
    p_title text DEFAULT NULL,
    p_address text DEFAULT NULL,
    p_address_visible_to text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_template RECORD;
    v_group    RECORD;
    v_new_id   uuid;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    IF p_scheduled_date <= CURRENT_DATE THEN RAISE EXCEPTION 'DATE_MUST_BE_FUTURE'; END IF;

    SELECT * INTO v_template FROM commander_home_game_templates WHERE id = p_template_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND'; END IF;

    SELECT * INTO v_group FROM commander_home_groups WHERE id = v_template.group_id;
    IF v_group.owner_id <> p_caller_user_id
       AND NOT EXISTS (SELECT 1 FROM commander_home_members
                        WHERE group_id = v_template.group_id AND user_id = p_caller_user_id
                          AND role IN ('admin','owner') AND status='approved')
    THEN RAISE EXCEPTION 'NOT_A_HOST'; END IF;

    IF EXISTS (SELECT 1 FROM commander_home_games
                WHERE group_id = v_template.group_id
                  AND scheduled_date = p_scheduled_date
                  AND status NOT IN ('cancelled'))
    THEN RAISE EXCEPTION 'DATE_ALREADY_SCHEDULED'; END IF;

    INSERT INTO commander_home_games (
        group_id, host_id, title, description,
        game_type, stakes, format, buyin_min, buyin_max,
        scheduled_date, start_time,
        address, address_visible_to,
        max_players, min_players, allow_guests, guest_limit,
        food_drinks, special_rules, status
    ) VALUES (
        v_template.group_id, p_caller_user_id,
        COALESCE(p_title, v_template.name),
        v_template.description,
        v_template.game_type, v_template.stakes, v_template.format,
        v_template.buyin_min, v_template.buyin_max,
        p_scheduled_date, v_template.default_start_time,
        -- BUG-8 fix: no v_group.address column exists; just use p_address (nullable).
        p_address,
        -- BUG-8 fix: 'members' and 'rsvpd' are not in the address_visible_to
        -- enum. Map to the actual allowed values {'all','rsvp','approved'}:
        --   private group → 'approved'  (only approved members see address)
        --   public group  → 'rsvp'      (RSVP-yes see address)
        COALESCE(p_address_visible_to,
                 CASE WHEN v_group.is_private THEN 'approved' ELSE 'rsvp' END),
        v_template.max_players, v_template.min_players,
        v_template.allow_guests, v_template.guest_limit,
        v_template.food_drinks, v_template.special_rules, 'scheduled'
    ) RETURNING id INTO v_new_id;

    INSERT INTO commander_home_audit_log (group_id, actor_id, target_type, target_id, action, metadata)
    VALUES (v_template.group_id, p_caller_user_id, 'game', v_new_id, 'from_template',
            jsonb_build_object('template_id', p_template_id, 'date', p_scheduled_date));

    RETURN jsonb_build_object('success', true, 'game_id', v_new_id);
END;
$function$;
