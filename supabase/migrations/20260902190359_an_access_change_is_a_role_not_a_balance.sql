-- An access change is a role, not a balance. (Part 2 of 2.)
--
-- trg_club_members_emit_management_access fires on EVERY club_members update,
-- so every buy-in, cash-out and payout wrote a `management_access_changed`
-- event addressed to the member whose chips had moved - 687 of them in one
-- hour for Deep Stack Society alone. Each reaches that member's open session
-- through PostgresSyncHooks and, on Table Management, triggers a full reload.
-- Nobody's access had changed. Their balance had.
--
-- The guard lives in the FUNCTION rather than in an `UPDATE OF` column list on
-- the trigger, which is where it belongs on shape alone but cannot go here:
-- DROP TRIGGER fires Supabase's sql_drop event trigger, which wants
-- AccessExclusive on realtime.subscription while holding AccessExclusive on
-- club_members - and a realtime worker holding realtime.subscription is
-- perpetually reading club_members. That is a deadlock, reproduced twice
-- against production before this was rewritten. CREATE OR REPLACE FUNCTION
-- takes no lock on club_members at all.
--
-- This is an invalidation hint only: every management RPC still authorizes
-- server-side on each call, so narrowing it cannot widen anyone's authority.
-- It applies to every member equally - a horse is a member and is announced on
-- exactly the same terms.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_emit_management_access_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_recipient uuid; v_club uuid; v_union uuid;
BEGIN
  IF TG_TABLE_NAME='club_members' THEN
    -- Only the columns that can grant or revoke access count as a change.
    IF TG_OP = 'UPDATE'
       AND NEW.role      IS NOT DISTINCT FROM OLD.role
       AND NEW.user_id   IS NOT DISTINCT FROM OLD.user_id
       AND NEW.club_id   IS NOT DISTINCT FROM OLD.club_id
       AND NEW.status    IS NOT DISTINCT FROM OLD.status
       AND NEW.is_active IS NOT DISTINCT FROM OLD.is_active
    THEN
      RETURN NULL;
    END IF;
    v_recipient:=COALESCE(NEW.user_id,OLD.user_id); v_club:=COALESCE(NEW.club_id,OLD.club_id);
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',v_club,NULL,v_recipient,'club',v_club,NULL,
      jsonb_build_object('operation',lower(TG_OP))
    );
  ELSIF TG_TABLE_NAME='union_admins' THEN
    v_recipient:=COALESCE(NEW.user_id,OLD.user_id); v_union:=COALESCE(NEW.union_id,OLD.union_id);
    PERFORM public.fn_emit_game_management_event(
      'management_access_changed',NULL,v_union,v_recipient,'union',v_union,NULL,
      jsonb_build_object('operation',lower(TG_OP))
    );
  ELSE
    v_club:=COALESCE(NEW.club_id,OLD.club_id); v_union:=COALESCE(NEW.union_id,OLD.union_id);
    FOR v_recipient IN
      SELECT c.owner_id FROM public.clubs c WHERE c.id=v_club
      UNION SELECT m.user_id FROM public.club_members m
        WHERE m.club_id=v_club AND m.role IN ('owner','co_owner','admin','host')
      UNION SELECT u.owner_id FROM public.unions u WHERE u.id=v_union
      UNION SELECT a.user_id FROM public.union_admins a WHERE a.union_id=v_union
    LOOP
      PERFORM public.fn_emit_game_management_event(
        'management_access_changed',v_club,v_union,v_recipient,'club',v_club,NULL,
        jsonb_build_object('operation',lower(TG_OP))
      );
    END LOOP;
  END IF;
  RETURN NULL;
END;
$fn$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='fn_emit_management_access_event'
      AND p.prosecdef
      AND p.prosrc LIKE '%NEW.role      IS NOT DISTINCT FROM OLD.role%'
  ) THEN
    RAISE EXCEPTION 'fn_emit_management_access_event lost its role-change guard or its security-definer flag';
  END IF;

  -- All three access emitters must still route through this one function.
  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND p.proname='fn_emit_management_access_event') <> 3 THEN
    RAISE EXCEPTION 'the club_members, union_admins and union_clubs access emitters no longer share one function';
  END IF;
END;
$assert$;

COMMIT;
