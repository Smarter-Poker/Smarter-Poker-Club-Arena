-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721185310 "agent_player_counts_trigger_clean_body_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dec5dfec2b0729093a499eb3a40786d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Replace fn_sync_agent_player_counts with the clean equivalent body (recompute OLD
-- bucket on UPDATE/DELETE, recompute NEW bucket on INSERT/UPDATE). Matches the
-- committed .sql exactly. Trigger already references this function by name.
CREATE OR REPLACE FUNCTION public.fn_sync_agent_player_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') AND OLD.agent_id IS NOT NULL THEN
    UPDATE agents a SET
      total_players = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = OLD.agent_id AND cm.club_id = OLD.club_id),
      active_player_count = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = OLD.agent_id AND cm.club_id = OLD.club_id AND cm.is_active IS TRUE)
    WHERE a.user_id = OLD.agent_id AND a.club_id = OLD.club_id;
  END IF;

  IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') AND NEW.agent_id IS NOT NULL THEN
    UPDATE agents a SET
      total_players = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id),
      active_player_count = (SELECT count(*) FROM club_members cm
                       WHERE cm.agent_id = NEW.agent_id AND cm.club_id = NEW.club_id AND cm.is_active IS TRUE)
    WHERE a.user_id = NEW.agent_id AND a.club_id = NEW.club_id;
  END IF;

  RETURN NULL;
END;
$function$;
