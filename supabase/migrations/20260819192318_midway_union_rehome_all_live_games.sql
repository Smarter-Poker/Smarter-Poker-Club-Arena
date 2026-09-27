-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819192318 "midway_union_rehome_all_live_games"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9a637314b88bfb36b63620fe0204ff15 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- MIDWAY UNION REHOME (2026-08-19)
-- Law clarification from ownership: union games do not merely carry a union
-- stamp — they RUN FROM the union. All live cash games in member club lobbies
-- are shut down (players auto-cashed-out) and reopened inside the Midway
-- Union house club (fade0000-0000-0000-0000-000000000001), where players
-- from every member club mix together.
-- ============================================================================

-- 1. Stamping triggers: also stamp games hosted by the union's own house club
--    (it has no union_clubs row; fall back to clubs.union_id).
CREATE OR REPLACE FUNCTION public.fn_stamp_table_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  -- Private club games are never union-visible.
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      -- The union's own house club (and legacy member clubs) carry the union
      -- on the clubs row itself.
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_union_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_union uuid;
BEGIN
  IF COALESCE(NEW.is_private, false) THEN
    NEW.union_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.union_id IS NULL AND NEW.club_id IS NOT NULL THEN
    SELECT uc.union_id INTO v_union FROM union_clubs uc WHERE uc.club_id = NEW.club_id LIMIT 1;
    IF v_union IS NULL THEN
      SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = NEW.club_id;
    END IF;
    IF v_union IS NOT NULL THEN
      NEW.union_id := v_union;
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 2. Shut down every live cash game in member club lobbies and reopen it
--    inside the Midway Union house club.
DO $$
DECLARE
  v_midway  uuid := 'fade0000-0000-0000-0000-000000000001';
  v_closed  integer;
  v_opened  integer;
BEGIN
  CREATE TEMP TABLE _rehome ON COMMIT DROP AS
  SELECT t.*
    FROM public.tables t
    JOIN public.union_clubs uc ON uc.club_id = t.club_id
   WHERE uc.union_id = v_midway
     AND t.status IN ('running', 'waiting', 'active', 'open')
     AND COALESCE(t.is_deleted, false) = false
     AND t.tournament_id IS NULL
     AND COALESCE(t.is_private, false) = false;

  -- Close (auto-cashout trigger returns every seated player's stack).
  UPDATE public.tables
     SET status = 'closed', updated_at = now()
   WHERE id IN (SELECT id FROM _rehome);
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- Reopen identical games under the Midway Union house club.
  INSERT INTO public.tables
  SELECT (jsonb_populate_record(
            NULL::public.tables,
            to_jsonb(m) || jsonb_build_object(
              'id',              gen_random_uuid(),
              'club_id',         v_midway,
              'union_id',        v_midway,
              'status',          'waiting',
              'current_players', 0,
              'live_state',      NULL,
              'hands_dealt',     0,
              'avg_pot',         0,
              'is_featured',     m.is_featured,
              'created_at',      now(),
              'updated_at',      now()
            ))).*
    FROM _rehome m;
  GET DIAGNOSTICS v_opened = ROW_COUNT;

  INSERT INTO public.admin_audit_log (action, details)
  VALUES ('midway_union_rehome',
          jsonb_build_object('closed_club_tables', v_closed,
                             'opened_union_tables', v_opened,
                             'executed_at', now()))
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Rehomed % club tables into Midway Union (% closed, % opened)',
    v_opened, v_closed, v_opened;
END $$;

-- 3. Codify the clarified law.
UPDATE public.platform_policies
   SET description = 'LAW: when a club belongs to a union, every non-private cash game and tournament runs FROM the union — hosted inside the union''s own house club (Midway Union), where players from all member clubs mix. Club lobbies host no union-visible games. Enforced by fn_stamp_table_union_ownership / fn_stamp_tournament_union_ownership and fn_can_create_games.',
       updated_at = now()
 WHERE key = 'union.game_hosting';

