-- Exact captured trigger definitions, retained even though union_clubs is read-only in these probes.

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_accounting_agreement_capture()'::regprocedure)) IS DISTINCT FROM '746fab25cd56f6ad761325e7c0d525d5' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_accounting_agreement_capture()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_emit_management_access_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_recipient uuid;
  v_club uuid;
  v_union uuid;
  v_operation text := lower(TG_OP);
BEGIN
  IF TG_TABLE_NAME = 'club_members' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.role IS NOT DISTINCT FROM OLD.role
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active THEN
      RETURN NULL;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', OLD.club_id, NULL, OLD.user_id,
        'club', OLD.club_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP IN ('UPDATE', 'INSERT')
       AND (TG_OP = 'INSERT'
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.club_id IS DISTINCT FROM OLD.club_id
            OR NEW.role IS DISTINCT FROM OLD.role
            OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
      -- When the row identity did not move, one after-event is sufficient.
      IF TG_OP = 'INSERT'
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.club_id IS DISTINCT FROM OLD.club_id THEN
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', NEW.club_id, NULL, NEW.user_id,
          'club', NEW.club_id, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'union_admins' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.union_id IS NOT DISTINCT FROM OLD.union_id
       AND NEW.role IS NOT DISTINCT FROM OLD.role THEN
      RETURN NULL;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, OLD.union_id, OLD.user_id,
        'union', OLD.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'before'));
    END IF;
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND (
         NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.union_id IS DISTINCT FROM OLD.union_id)) THEN
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed', NULL, NEW.union_id, NEW.user_id,
        'union', NEW.union_id, NULL,
        jsonb_build_object('operation', v_operation, 'side', 'after'));
    END IF;

  ELSE
    -- union_clubs. UPDATE was omitted from the original trigger entirely.
    -- Each side gets its own recipient set and its own union scope.
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_club := OLD.club_id;
      v_union := OLD.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'before'));
      END LOOP;
    END IF;

    IF TG_OP IN ('UPDATE', 'INSERT') THEN
      v_club := NEW.club_id;
      v_union := NEW.union_id;
      FOR v_recipient IN
        SELECT c.owner_id FROM public.clubs c WHERE c.id = v_club
        UNION SELECT m.user_id FROM public.club_members m
          WHERE m.club_id = v_club
            AND m.role IN ('owner','co_owner','admin')
            AND m.status IN ('active','approved')
            AND COALESCE(m.is_active, true)
        UNION SELECT u.owner_id FROM public.unions u WHERE u.id = v_union
        UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id = v_union
      LOOP
        PERFORM public.fn_emit_game_management_event(
          'management_access_changed', v_club, v_union, v_recipient,
          'club', v_club, NULL,
          jsonb_build_object('operation', v_operation, 'side', 'after'));
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

ALTER FUNCTION public.fn_emit_management_access_event() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_emit_management_access_event() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_emit_management_access_event() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_emit_management_access_event() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_emit_management_access_event()'::regprocedure)) IS DISTINCT FROM '9963925e6cd6da557b9de6f1749db0fd' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_emit_management_access_event()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_enforce_club_enters_union_empty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  b jsonb;
BEGIN
  IF NEW.club_id = NEW.union_id THEN
    RETURN NEW;
  END IF;

  b := public.fn_club_union_join_blockers(NEW.club_id);

  IF (b->>'is_empty')::boolean THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'This club still holds chips and cannot join a union yet.',
    DETAIL  = format(
      'treasury %s, club promo %s, member wallets %s across %s members, horse bankrolls %s across %s horses, agent wallets %s across %s agents, %s on the felt in %s open seats, BBJ pool %s. Total %s.',
      b->>'club_treasury', b->>'club_promo',
      b->>'member_wallets', b->>'member_count',
      b->>'horse_wallets', b->>'horse_count',
      b->>'agent_wallets', b->>'agent_count',
      b->>'chips_on_felt', b->>'open_seats',
      b->>'bbj_pool', b->>'total'),
    HINT    = 'Cash your players and agents down to zero, close the tables and empty the treasury first. Once the club is in the union, the union funds it.';
END;
$function$;

ALTER FUNCTION public.fn_enforce_club_enters_union_empty() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_enforce_club_enters_union_empty() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_enforce_club_enters_union_empty() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_enforce_club_enters_union_empty() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_enforce_club_enters_union_empty()'::regprocedure)) IS DISTINCT FROM '23c5f3b77830234a6c0181474fe8caee' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_enforce_club_enters_union_empty()'; END IF; END $fixture$;

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_guard_retired_club_mutation()'::regprocedure)) IS DISTINCT FROM 'b82be212e7ccf2a15637c231861ff993' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_guard_retired_club_mutation()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_poker_guard_arena_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_asset text;
BEGIN
  IF TG_TABLE_NAME='clubs' THEN
    IF TG_OP='UPDATE' AND (NEW.asset,NEW.is_platform) IS DISTINCT FROM (OLD.asset,OLD.is_platform) THEN
      RAISE EXCEPTION 'Arena Asset Is Immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.asset='diamonds' AND auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false) THEN
      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT asset INTO v_asset FROM public.clubs WHERE id=NEW.club_id;
  IF TG_TABLE_NAME='club_members' AND TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
     AND EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset='diamonds') THEN
    RAISE EXCEPTION 'Diamond Participation Cannot Become A Chip Membership' USING ERRCODE='23514';
  END IF;
  -- Branch before resolving fields: membership rows do not have union_id.
  IF TG_TABLE_NAME IN ('tables','tournaments') THEN
    IF TG_OP='UPDATE' AND NEW.club_id IS DISTINCT FROM OLD.club_id
       AND (EXISTS (SELECT 1 FROM public.clubs WHERE id=OLD.club_id AND asset IS DISTINCT FROM v_asset)
         OR (OLD.club_id IS NULL AND OLD.union_id IS NOT NULL AND v_asset='diamonds')) THEN
      RAISE EXCEPTION 'Game Asset Is Immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF v_asset='diamonds' THEN
    IF TG_TABLE_NAME='club_members' THEN
      IF TG_OP='INSERT' OR NEW.role IS DISTINCT FROM 'player' OR NEW.status IS DISTINCT FROM 'automatic'
         OR NEW.agent_id IS NOT NULL OR NEW.parent_agent_id IS NOT NULL
         OR coalesce(NEW.chip_balance,0)<>0 OR coalesce(NEW.credit_limit,0)<>0
         OR coalesce(NEW.credit_used,0)<>0 OR coalesce(NEW.promo_balance,0)<>0
         OR coalesce(NEW.held_chips,0)<>0 THEN
        RAISE EXCEPTION 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='union_clubs' THEN
      RAISE EXCEPTION 'Diamond Arena Cannot Join A Union' USING ERRCODE='23514';
    ELSIF auth.uid() IS NOT NULL AND coalesce(auth.jwt()->>'role','') <> 'service_role'
       AND NOT coalesce(public.fn_is_platform_admin(),false)
       -- DIAMOND PHASE 8: a player's entry, add-on and withdrawal move the
       -- play-state counters through the estate's doors; the structure is
       -- still platform operations only.
       AND NOT (TG_OP='UPDATE' AND TG_TABLE_NAME IN ('tournaments','tables')
                AND (to_jsonb(NEW) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))
                  = (to_jsonb(OLD) - public.fn_poker_diamond_play_state_columns(TG_TABLE_NAME))) THEN
      RAISE EXCEPTION 'Diamond Games Require Platform Operations' USING ERRCODE='42501';
    ELSIF NEW.union_id IS NOT NULL THEN
      RAISE EXCEPTION 'Diamond Games Cannot Belong To A Union' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

ALTER FUNCTION public.fn_poker_guard_arena_structure() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_poker_guard_arena_structure() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_poker_guard_arena_structure() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure)) IS DISTINCT FROM 'f17675dd0b647abda7b0b9d8772c9c0e' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_poker_guard_arena_structure()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_recompute_union_level_on_club_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_union_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_union_id := OLD.union_id;
  ELSE                     v_union_id := NEW.union_id;
  END IF;
  BEGIN
    PERFORM public.recompute_union_levels(v_union_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_recompute_union_level_on_club_change failed for union=%: % (%)',
      v_union_id, SQLERRM, SQLSTATE;
  END;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.fn_recompute_union_level_on_club_change() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_recompute_union_level_on_club_change() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_recompute_union_level_on_club_change() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_recompute_union_level_on_club_change() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_recompute_union_level_on_club_change()'::regprocedure)) IS DISTINCT FROM '102d867367cdc4e88cba99ecc53763c9' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_recompute_union_level_on_club_change()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_sync_club_union_mirror()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE clubs
       SET union_id = NEW.union_id,
           club_commission_rate = COALESCE(NEW.club_commission_rate, club_commission_rate)
     WHERE id = NEW.club_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE clubs SET union_id = NULL
     WHERE id = OLD.club_id AND union_id = OLD.union_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_sync_club_union_mirror() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_sync_club_union_mirror() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_sync_club_union_mirror() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_sync_club_union_mirror() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_sync_club_union_mirror()'::regprocedure)) IS DISTINCT FROM '119b0030a566ae5701cdecfa81aee13e' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_sync_club_union_mirror()'; END IF; END $fixture$;

CREATE OR REPLACE FUNCTION public.fn_sync_union_membership_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_unions uuid[]; v_clubs uuid[];
BEGIN
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);

  UPDATE clubs SET table_count = fn_live_table_count(id)
   WHERE id = ANY(v_clubs)
      OR id = ANY(v_unions)
      OR id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions));
  RETURN NULL;
END $function$;

ALTER FUNCTION public.fn_sync_union_membership_table_counts() OWNER TO "postgres";

REVOKE ALL ON FUNCTION public.fn_sync_union_membership_table_counts() FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_sync_union_membership_table_counts() TO "postgres";

GRANT EXECUTE ON FUNCTION public.fn_sync_union_membership_table_counts() TO "service_role";

DO $fixture$ BEGIN IF md5(pg_get_functiondef('public.fn_sync_union_membership_table_counts()'::regprocedure)) IS DISTINCT FROM 'd0f49fa15340884a978759cfaf54ab88' THEN RAISE EXCEPTION 'Diamond union_clubs function witness failed: %','public.fn_sync_union_membership_table_counts()'; END IF; END $fixture$;

CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, union_id, club_commission_rate, rate_cash, rate_mtt, rate_sng, rate_spin, rate_satellite ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture();

CREATE TRIGGER poker_arena_union_guard BEFORE INSERT OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_poker_guard_arena_structure();

CREATE TRIGGER trg_club_enters_a_union_empty BEFORE INSERT ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_enforce_club_enters_union_empty();

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

CREATE TRIGGER trg_recompute_union_level_on_club_change AFTER INSERT OR DELETE OR UPDATE OF union_id, club_id ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_recompute_union_level_on_club_change();

CREATE TRIGGER trg_union_clubs_emit_management_access AFTER INSERT OR DELETE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event();

CREATE TRIGGER trg_union_clubs_reassignment_management_access AFTER UPDATE OF union_id, club_id ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_emit_management_access_event();

CREATE TRIGGER trg_union_clubs_sync_mirror AFTER INSERT OR DELETE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_club_union_mirror();

CREATE TRIGGER trg_union_clubs_sync_table_counts AFTER INSERT OR DELETE OR UPDATE ON union_clubs FOR EACH ROW EXECUTE FUNCTION fn_sync_union_membership_table_counts();

DO $fixture$ BEGIN IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.union_clubs'::regclass AND NOT tgisinternal AND tgenabled='O')<>9 THEN RAISE EXCEPTION 'Diamond union_clubs trigger witness failed'; END IF; END $fixture$;
