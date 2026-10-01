-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420090358 "phase41_seat_reservation_rls"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e214afe5db174bd79da07493c9136186 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part E: RLS on new tables. Mirrors commander_home_games policies.
-- Defense-in-depth — primary auth path is API routes via service-role. RLS
-- catches direct PostgREST access.

-- ============================================================================
-- commander_home_game_tables
-- ============================================================================
ALTER TABLE public.commander_home_game_tables ENABLE ROW LEVEL SECURITY;

-- SELECT: approved members or group owner
DROP POLICY IF EXISTS home_game_tables_select ON public.commander_home_game_tables;
CREATE POLICY home_game_tables_select
  ON public.commander_home_game_tables
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.commander_home_games g
       WHERE g.id = commander_home_game_tables.game_id
         AND (
           g.group_id IN (
             SELECT m.group_id FROM public.commander_home_members m
              WHERE m.user_id = auth.uid() AND m.status = 'approved'
           )
           OR g.group_id IN (
             SELECT gr.id FROM public.commander_home_groups gr
              WHERE gr.owner_id = auth.uid()
           )
         )
    )
  );

-- INSERT: staff only (host / owner / admin)
DROP POLICY IF EXISTS home_game_tables_insert ON public.commander_home_game_tables;
CREATE POLICY home_game_tables_insert
  ON public.commander_home_game_tables
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM public.commander_home_games g
       WHERE g.id = commander_home_game_tables.game_id
         AND (
           g.host_id = auth.uid()
           OR public.fn_home_is_group_staff(auth.uid(), g.group_id)
         )
    )
  );

-- UPDATE: staff only
DROP POLICY IF EXISTS home_game_tables_update ON public.commander_home_game_tables;
CREATE POLICY home_game_tables_update
  ON public.commander_home_game_tables
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
        FROM public.commander_home_games g
       WHERE g.id = commander_home_game_tables.game_id
         AND (
           g.host_id = auth.uid()
           OR public.fn_home_is_group_staff(auth.uid(), g.group_id)
         )
    )
  );

-- DELETE: staff only
DROP POLICY IF EXISTS home_game_tables_delete ON public.commander_home_game_tables;
CREATE POLICY home_game_tables_delete
  ON public.commander_home_game_tables
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
        FROM public.commander_home_games g
       WHERE g.id = commander_home_game_tables.game_id
         AND (
           g.host_id = auth.uid()
           OR public.fn_home_is_group_staff(auth.uid(), g.group_id)
         )
    )
  );

-- ============================================================================
-- commander_home_seat_reservations
-- ============================================================================
ALTER TABLE public.commander_home_seat_reservations ENABLE ROW LEVEL SECURITY;

-- SELECT: approved members + group owner + the claimant themselves
DROP POLICY IF EXISTS home_seat_reservations_select ON public.commander_home_seat_reservations;
CREATE POLICY home_seat_reservations_select
  ON public.commander_home_seat_reservations
  FOR SELECT
  USING (
    auth.uid() = claimed_by_user_id
    OR auth.uid() = user_id
    OR EXISTS (
      SELECT 1
        FROM public.commander_home_game_tables t
        JOIN public.commander_home_games g ON g.id = t.game_id
       WHERE t.id = commander_home_seat_reservations.table_id
         AND (
           g.group_id IN (
             SELECT m.group_id FROM public.commander_home_members m
              WHERE m.user_id = auth.uid() AND m.status = 'approved'
           )
           OR g.group_id IN (
             SELECT gr.id FROM public.commander_home_groups gr
              WHERE gr.owner_id = auth.uid()
           )
         )
    )
  );

-- INSERT:
--   (a) user claiming a seat for themselves (must be approved member of the group),
--   (b) user claiming their own guest seat,
--   (c) group staff claiming on behalf of a member (roster or user).
DROP POLICY IF EXISTS home_seat_reservations_insert ON public.commander_home_seat_reservations;
CREATE POLICY home_seat_reservations_insert
  ON public.commander_home_seat_reservations
  FOR INSERT
  WITH CHECK (
    claimed_by_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
        FROM public.commander_home_game_tables t
        JOIN public.commander_home_games g ON g.id = t.game_id
       WHERE t.id = commander_home_seat_reservations.table_id
         AND (
           -- Staff can claim for anyone (incl. roster-only members)
           public.fn_home_is_group_staff(auth.uid(), g.group_id)
           OR g.host_id = auth.uid()
           OR (
             -- Approved member self-claiming their own seat or their own guest
             EXISTS (
               SELECT 1 FROM public.commander_home_members m
                WHERE m.group_id = g.group_id
                  AND m.user_id = auth.uid()
                  AND m.status = 'approved'
             )
             AND (
               -- Self-claim: user_id must equal caller
               (is_guest = false AND user_id = auth.uid())
               OR
               -- Own guest seat: user_id must be null, is_guest true, guest_name set
               (is_guest = true AND user_id IS NULL AND guest_name IS NOT NULL)
             )
           )
         )
    )
  );

-- UPDATE:
--   (a) claimant releasing/modifying their own row,
--   (b) user whose seat it is,
--   (c) group staff.
DROP POLICY IF EXISTS home_seat_reservations_update ON public.commander_home_seat_reservations;
CREATE POLICY home_seat_reservations_update
  ON public.commander_home_seat_reservations
  FOR UPDATE
  USING (
    auth.uid() = claimed_by_user_id
    OR auth.uid() = user_id
    OR EXISTS (
      SELECT 1
        FROM public.commander_home_game_tables t
        JOIN public.commander_home_games g ON g.id = t.game_id
       WHERE t.id = commander_home_seat_reservations.table_id
         AND (g.host_id = auth.uid() OR public.fn_home_is_group_staff(auth.uid(), g.group_id))
    )
  );

-- DELETE: staff only (prefer soft-release via status change; hard-delete is an admin escape hatch)
DROP POLICY IF EXISTS home_seat_reservations_delete ON public.commander_home_seat_reservations;
CREATE POLICY home_seat_reservations_delete
  ON public.commander_home_seat_reservations
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
        FROM public.commander_home_game_tables t
        JOIN public.commander_home_games g ON g.id = t.game_id
       WHERE t.id = commander_home_seat_reservations.table_id
         AND (g.host_id = auth.uid() OR public.fn_home_is_group_staff(auth.uid(), g.group_id))
    )
  );
