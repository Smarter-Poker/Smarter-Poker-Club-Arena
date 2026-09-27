-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821034937 "align_club_activity_counts_to_membership_definition"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 36638454872b40e99cca7a26f2006e13 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_refresh_club_activity_counts was written against the ORIGINAL meaning of
-- "active": players seated at tables BELONGING TO the club. Between writing it
-- and verifying it, fn_batch_active_player_counts — the function the club
-- cards actually call — was rewritten to a different meaning: MEMBERS OF the
-- club seated at ANY live table, wherever that table belongs.
--
-- The two disagreed in production and both were right about different things.
-- Shark Club reads 9 under the new definition and 0 under the old, because it
-- has no live tables of its own and nine of its members are playing on the
-- union's. In a union model where clubs share a table pool, "how many of MY
-- players are playing" is the question a club owner is asking, so the new
-- definition is the better one — and, decisively, it is the one already on
-- screen. A stored column that contradicts the card is worse than no column.
--
-- Aligned here rather than argued with. active_tables keeps its literal
-- meaning (tables this club owns and is running) because that one is not
-- ambiguous.

CREATE OR REPLACE FUNCTION public.fn_refresh_club_activity_counts(p_club_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
    UPDATE public.clubs c
       SET active_players = coalesce(p.n, 0),
           active_tables  = coalesce(t.n, 0)
      FROM public.clubs base
      LEFT JOIN LATERAL (
        -- Mirrors fn_batch_active_player_counts exactly: members of this club
        -- who are seated, not away, at a table that is not in a terminal state.
        SELECT count(DISTINCT ts.user_id) AS n
          FROM public.club_members cm
          JOIN public.table_seats ts
            ON ts.user_id = cm.user_id
           AND ts.left_at IS NULL
           AND coalesce(ts.is_away, false) = false
          JOIN public.tables tb
            ON tb.id = ts.table_id
           AND lower(coalesce(tb.status,'')) NOT IN ('closed','completed','cancelled','finished')
         WHERE cm.club_id = base.id
           AND cm.status = 'active'
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS n
          FROM public.tables tb2
         WHERE tb2.club_id = base.id
           AND lower(coalesce(tb2.status,'')) NOT IN ('closed','completed','cancelled','finished')
      ) t ON true
     WHERE c.id = base.id
       AND (p_club_id IS NULL OR base.id = p_club_id);
$function$;

COMMENT ON FUNCTION public.fn_refresh_club_activity_counts(uuid) IS
    'Recomputes clubs.active_players (members of the club seated at any live table, matching fn_batch_active_player_counts) and clubs.active_tables (live tables the club owns). Refreshed when a table opens or closes; fn_batch_active_player_counts remains the authority for a to-the-second number.';

SELECT public.fn_refresh_club_activity_counts(NULL);

DO $$
DECLARE
    mismatched integer;
BEGIN
    -- The stored column must now agree with the function the cards call.
    SELECT count(*) INTO mismatched
      FROM public.clubs c
      LEFT JOIN LATERAL (
        SELECT active_count FROM public.fn_batch_active_player_counts(ARRAY[c.id])
      ) r ON true
     WHERE c.active_players <> coalesce(r.active_count, 0);
    IF mismatched > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % club(s) still disagree with fn_batch_active_player_counts', mismatched;
    END IF;
END $$;
