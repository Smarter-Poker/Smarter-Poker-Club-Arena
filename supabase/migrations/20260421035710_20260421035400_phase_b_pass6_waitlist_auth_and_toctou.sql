-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421035710 "20260421035400_phase_b_pass6_waitlist_auth_and_toctou"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 69df2b5425429b54d9a2c2529026381e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase B Pass 6 — promote_home_game_waitlist hardening
--
-- Three bugs fixed together because they all live in this one RPC:
--
-- F164 (HIGH — authenticated-user sabotage vector):
--   promote_home_game_waitlist had an optional p_caller_user_id parameter
--   with the behavior "if NULL, skip auth". This was intended to support the
--   fn_auto_promote_waitlist TRIGGER calling it internally — but EXECUTE was
--   granted to the 'authenticated' role, which means any logged-in user
--   could call
--       SELECT promote_home_game_waitlist('<any-game-id>', NULL)
--   from PostgREST and trigger the promotion flow on any home game in the
--   entire system, bypassing all auth. Impact: griefer picks any active
--   home game, force-promotes waitlisted players the host hadn't approved
--   yet, overbooks the table, disrupts host workflow. Not data-exfil, but
--   clear sabotage/annoyance vector.
--
--   Fix: distinguish trigger context from direct RPC context via a LOCAL
--   GUC that only the trigger function sets. Direct callers MUST pass
--   p_caller_user_id. service_role bypasses all of this for server-side
--   automation. Pattern matches revive_home_group's gold-standard auth
--   check (auth.role() = 'service_role' OR auth.uid() = p_caller_user_id).
--
-- F162 (HIGH — TOCTOU race on seat count):
--   v_seats_open := max_players - rsvp_yes was computed from a snapshot
--   read of the game row with no lock. Between that read and the subsequent
--   waitlist-promote loop, concurrent RSVPs / other promote calls could
--   push rsvp_yes past max_players and overbook the game. The rsvp_yes
--   counter is maintained by a trigger, so the read-decide-write was
--   completely non-transactional.
--
--   Fix: SELECT ... FOR UPDATE on the game row so concurrent promote calls
--   serialize and only the first one sees the "open seats" state.
--
-- F163 (MEDIUM — double-promotion race):
--   Waitlist rows were selected without FOR UPDATE. Two concurrent promote
--   calls racing on the same game could both pick the same N waitlist
--   entries, both fire UPDATE response='yes' on the same rows, double-
--   incrementing counters via the count trigger.
--
--   Fix: FOR UPDATE SKIP LOCKED on the waitlist selection so concurrent
--   promotes see disjoint row subsets. Paired with F162's game-row lock
--   this is belt-and-suspenders.
--
-- No schema changes — only the RPC body and a small helper set_config in
-- fn_auto_promote_waitlist. Downstream trigger wiring is preserved.

CREATE OR REPLACE FUNCTION public.promote_home_game_waitlist(
    p_game_id uuid,
    p_caller_user_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_game            RECORD;
    v_group           RECORD;
    v_seats_open      int;
    v_promoted_ids    uuid[] := ARRAY[]::uuid[];
    v_rsvp            RECORD;
    v_is_trigger_call boolean;
    v_is_service_role boolean;
BEGIN
    -- ──────────────────────────────────────────────────────────────────
    -- F164: require p_caller_user_id UNLESS the call came from
    -- fn_auto_promote_waitlist (which sets a LOCAL GUC before invoking)
    -- or from the service_role. Direct PostgREST callers with NULL are
    -- now rejected.
    -- ──────────────────────────────────────────────────────────────────
    v_is_trigger_call :=
      (current_setting('app.hg_waitlist_auto_promote', true) = '1');
    v_is_service_role := (auth.role() = 'service_role');

    IF v_is_trigger_call OR v_is_service_role THEN
        -- Trusted context: skip auth.uid() match.
        NULL;
    ELSE
        IF p_caller_user_id IS NULL THEN
            RAISE EXCEPTION 'UNAUTHORIZED'
                  USING HINT = 'promote_home_game_waitlist requires p_caller_user_id';
        END IF;
        IF auth.uid() IS NULL OR auth.uid() <> p_caller_user_id THEN
            RAISE EXCEPTION 'UNAUTHORIZED'
                  USING HINT = 'auth.uid() must match p_caller_user_id';
        END IF;
    END IF;

    -- ──────────────────────────────────────────────────────────────────
    -- F162: FOR UPDATE so concurrent promote/RSVP transactions serialize
    -- on the game row. Only the holder of this lock gets to compute
    -- v_seats_open and run the promote loop; any parallel call blocks
    -- until we COMMIT and re-reads the fresh rsvp_yes value.
    -- ──────────────────────────────────────────────────────────────────
    SELECT * INTO v_game
      FROM commander_home_games
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
    IF v_game.status NOT IN ('scheduled','confirmed') THEN
        RAISE EXCEPTION 'GAME_NOT_OPEN';
    END IF;

    -- Authorization: host / owner / approved admin.
    -- Skipped for trigger/service_role contexts (already trusted above).
    IF NOT v_is_trigger_call AND NOT v_is_service_role THEN
        SELECT * INTO v_group FROM commander_home_groups WHERE id = v_game.group_id;
        IF v_game.host_id <> p_caller_user_id
           AND v_group.owner_id <> p_caller_user_id
           AND NOT EXISTS (SELECT 1 FROM commander_home_members
                            WHERE group_id = v_game.group_id AND user_id = p_caller_user_id
                              AND role = 'admin' AND status = 'approved')
        THEN
            RAISE EXCEPTION 'NOT_AUTHORIZED';
        END IF;
    END IF;

    -- Compute open seats against the LOCKED snapshot.
    v_seats_open := GREATEST(0,
        COALESCE(v_game.max_players, 9) - COALESCE(v_game.rsvp_yes, 0));
    IF v_seats_open = 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'promoted_count', 0,
            'seats_full', true
        );
    END IF;

    -- ──────────────────────────────────────────────────────────────────
    -- F163: FOR UPDATE SKIP LOCKED on waitlist rows so concurrent
    -- promote calls (should they occur despite the game-row lock above)
    -- see disjoint waitlist subsets. SKIP LOCKED means rows already
    -- claimed by another tx are ignored rather than waited on.
    -- ──────────────────────────────────────────────────────────────────
    FOR v_rsvp IN
        SELECT id, user_id FROM commander_home_rsvps
         WHERE game_id = p_game_id
           AND response = 'waitlist'
         ORDER BY responded_at
         LIMIT v_seats_open
         FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE commander_home_rsvps
           SET response   = 'yes',
               updated_at = NOW()
         WHERE id = v_rsvp.id;
        v_promoted_ids := array_append(v_promoted_ids, v_rsvp.user_id);
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'promoted_count', COALESCE(array_length(v_promoted_ids, 1), 0),
        'promoted_user_ids', v_promoted_ids
    );
END;
$function$;

-- Update the trigger helper to set the LOCAL GUC that the RPC now checks.
CREATE OR REPLACE FUNCTION public.fn_auto_promote_waitlist()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_target_game_id uuid;
    v_game_exists    boolean;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.response = 'yes' AND NEW.response <> 'yes' THEN
        v_target_game_id := NEW.game_id;
    ELSIF TG_OP = 'DELETE' AND OLD.response = 'yes' THEN
        v_target_game_id := OLD.game_id;
    ELSE
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT EXISTS(SELECT 1 FROM commander_home_games WHERE id = v_target_game_id)
      INTO v_game_exists;
    IF NOT v_game_exists THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    -- Mark this tx as a legitimate auto-promote context so the RPC's
    -- hardened auth gate permits the NULL p_caller_user_id call path.
    -- LOCAL scope: rolls back at tx end, cannot leak to other sessions.
    PERFORM set_config('app.hg_waitlist_auto_promote', '1', true);

    BEGIN
      PERFORM public.promote_home_game_waitlist(v_target_game_id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'fn_auto_promote_waitlist swallowed promote error for game %: % (%)',
        v_target_game_id, SQLERRM, SQLSTATE;
    END;

    -- Clear the GUC before returning so subsequent work in the same tx
    -- (e.g. other triggers firing on cascading mutations) can't reuse it.
    PERFORM set_config('app.hg_waitlist_auto_promote', '', true);

    RETURN COALESCE(NEW, OLD);
END;
$function$;
