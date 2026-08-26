-- ═══════════════════════════════════════════════════════════════════════════════
-- clubs.member_count IS DERIVED NOW, AND THE CLUB CODE DEFAULT MATCHES THE CODE
--
-- Two small things, both found in the lobby audit.
--
-- ── 1. THE TRIGGER THE COMMENTS PROMISED DID NOT EXIST ──────────────────────
--
-- `ClubsService.ts` says, in two places: "clubs.member_count is auto-synced by
-- the trg_sync_club_member_count trigger". There is no such trigger, and there
-- never was --
--
--     select count(*) from pg_trigger where tgname = 'trg_sync_club_member_count';
--     0
--
-- `fn_join_club` does not touch the column either. The only writer in the whole
-- join path was one hand-rolled `increment_member_count` call on InvitePage, so
-- joining through the lobby modal or the Discover tab never moved it, and
-- NOTHING anywhere decremented it when a member left.
--
-- The drift that produced, live:
--
--     SHARK CLUB    stored 591   actual 590
--     Club JAQK     stored 585   actual 584
--     Midway Union  stored 328   actual 328
--
-- Monotonically upward, which is the exact signature of a counter incremented
-- by one of three join paths and decremented by none.
--
-- It is DERIVED from here on: recomputed from the rows rather than adjusted by
-- whoever remembers to. A counter that is added to drifts; a counter that is
-- recomputed cannot. `increment_member_count` is left in place so the existing
-- call site keeps working -- it is now redundant rather than load-bearing.
--
-- Membership means `status IN ('active','approved')`, the same definition
-- `getUserMemberships` and the 4-club limit already use. A pending request is
-- not a member and must not be counted as one.
--
-- ── 2. THE COLUMN DEFAULT MINTED A DIFFERENT SHAPE OF CODE THAN THE CODE ────
--
-- `clubs.club_id` defaulted to `(100000 + floor(random() * 900000))::integer`
-- -- six digits -- while all three creation paths write
-- `Math.floor(10000 + Math.random() * 90000)` -- five. Every club that exists
-- is five-digit. Any insert path that omitted `club_id` would have minted a
-- six-digit club, and the Discover tab's join gate demanded exactly six until
-- today, so the two shapes were each unjoinable from one screen. Both lengths
-- are accepted by the client now (`src/utils/clubCode.ts`); this makes the
-- default agree with what the product actually generates.
--
-- ── ROLLBACK ────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_sync_club_member_count ON public.club_members;
--   DROP FUNCTION IF EXISTS public.fn_sync_club_member_count();
--   ALTER TABLE public.clubs ALTER COLUMN club_id
--     SET DEFAULT (100000 + floor(random() * 900000))::integer;
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_sync_club_member_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid;
BEGIN
  v_club := COALESCE(NEW.club_id, OLD.club_id);
  IF v_club IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Recomputed, never incremented. See the header for the drift the
  -- increment-only version produced.
  UPDATE clubs
     SET member_count = (
       SELECT count(*) FROM club_members
        WHERE club_id = v_club AND status IN ('active', 'approved')
     )
   WHERE id = v_club;

  -- A member moved between clubs fires this once for the row; the OLD club
  -- needs its own recount or it keeps counting somebody who left.
  IF TG_OP = 'UPDATE' AND OLD.club_id IS DISTINCT FROM NEW.club_id AND OLD.club_id IS NOT NULL THEN
    UPDATE clubs
       SET member_count = (
         SELECT count(*) FROM club_members
          WHERE club_id = OLD.club_id AND status IN ('active', 'approved')
       )
     WHERE id = OLD.club_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_club_member_count ON public.club_members;
CREATE TRIGGER trg_sync_club_member_count
  AFTER INSERT OR DELETE OR UPDATE OF status, club_id ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_club_member_count();

COMMENT ON FUNCTION public.fn_sync_club_member_count() IS
  'Keeps clubs.member_count equal to the number of active/approved club_members rows. Added 2026-08-26: ClubsService had claimed this trigger existed since before it was written, and the counter had drifted upward on every club because only one of three join paths incremented it and nothing decremented it.';

-- Backfill the drift the missing trigger left behind.
UPDATE clubs c
   SET member_count = (
     SELECT count(*) FROM club_members cm
      WHERE cm.club_id = c.id AND cm.status IN ('active', 'approved')
   )
 WHERE c.member_count IS DISTINCT FROM (
     SELECT count(*) FROM club_members cm
      WHERE cm.club_id = c.id AND cm.status IN ('active', 'approved')
   );

ALTER TABLE public.clubs
  ALTER COLUMN club_id SET DEFAULT (10000 + floor(random() * 90000))::integer;

DO $$
DECLARE
  v_drift int;
  v_default text;
BEGIN
  SELECT count(*) INTO v_drift FROM clubs c
   WHERE c.member_count IS DISTINCT FROM (
     SELECT count(*) FROM club_members cm
      WHERE cm.club_id = c.id AND cm.status IN ('active', 'approved'));
  IF v_drift > 0 THEN
    RAISE EXCEPTION '% clubs still have a member_count that disagrees with their rows', v_drift;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.club_members'::regclass
                    AND tgname='trg_sync_club_member_count') THEN
    RAISE EXCEPTION 'the member-count trigger the comments promised STILL does not exist';
  END IF;

  SELECT column_default INTO v_default FROM information_schema.columns
   WHERE table_schema='public' AND table_name='clubs' AND column_name='club_id';
  IF v_default NOT LIKE '%10000%' OR v_default LIKE '%100000%' THEN
    RAISE EXCEPTION 'clubs.club_id default is %, expected the five-digit form', v_default;
  END IF;
END $$;
