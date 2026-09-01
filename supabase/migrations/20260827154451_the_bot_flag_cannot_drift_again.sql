-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827154451; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE BOT FLAG CANNOT DRIFT AGAIN
-- ═══════════════════════════════════════════════════════════════════════════
-- 985 of 1,487 horses -- 66% of the fleet, holding 74,572,743.02 chips -- were
-- flagged club_members.is_bot = false while profiles.is_horse said true.
-- Anything segmenting on is_bot counted them as human beings.
--
-- ROOT CAUSE, and it is a missing line rather than bad logic:
-- server/src/services/HorseOnboarding.ts inserted the membership without
-- is_bot at all, so the column took its `false` default. Every horse onboarded
-- through the live path was recorded as a person. The older seed
-- (009_horse_fleet_300_full_parity.sql) and the horse-management runbook both
-- write FALSE explicitly. NOTHING anywhere has ever written is_bot = true.
-- The insert is fixed in the same commit as this migration.
--
-- WHY IT IS SAFE TO CORRECT NOW, having actually checked rather than assumed
-- (the previous migration deliberately left it alone until this was done):
--
--   * ZERO application readers. A sweep of both repos found no .eq('is_bot'),
--     no filter, no branch. Every consequential horse check in shipped code
--     keys on profiles.is_horse -- prize pools, payouts, seating, fleet
--     management, UI badges, cashier.
--   * fn_membership_starts_with_zero_chips is BEFORE INSERT and its condition
--     is `is_bot OR profiles.is_horse`. All 985 already satisfy the second
--     half, so flipping the first is a no-op there.
--   * fn_club_union_join_blockers already excludes on BOTH flags
--     (`NOT is_bot AND NOT is_horse`), so it was never fooled.
--
-- ONE REAL BEHAVIOUR CHANGE, called out rather than buried:
--   mass_fund_horses counts `is_bot = true AND is_active = true` and divides a
--   FIXED p_amount across that count. It will now see 1,487 horses instead of
--   502, so a funding run distributes the SAME TOTAL in roughly one-third
--   shares. It does not spend more money -- and funding the whole fleet rather
--   than a third of it is the behaviour the flag was always meant to produce --
--   but anyone used to the old per-horse figure should know it changed. It is
--   a manual admin RPC, so nothing happens until someone calls it.
--
-- ROLLBACK:
--   DROP TRIGGER trg_club_members_bot_follows_horse ON public.club_members;
--   DROP FUNCTION public.fn_club_members_bot_follows_horse();
--   -- the backfill itself should NOT be rolled back: false was never correct.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE public.club_members cm
   SET is_bot = true
  FROM public.profiles p
 WHERE p.id = cm.user_id
   AND coalesce(p.is_horse, false)
   AND NOT coalesce(cm.is_bot, false);

/* profiles.is_horse is authoritative; this keeps the per-membership copy
   honest so the two can never disagree again. Deliberately NOT a generated
   column: is_horse lives on another table, and a foreign read is not
   something a GENERATED expression is allowed to do. */
CREATE OR REPLACE FUNCTION public.fn_club_members_bot_follows_horse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.is_bot := coalesce(
    (SELECT p.is_horse FROM public.profiles p WHERE p.id = NEW.user_id),
    NEW.is_bot,
    false);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_club_members_bot_follows_horse() IS
  'Keeps club_members.is_bot equal to profiles.is_horse. Added 2026-08-27 after 985 horses (74.5M chips) sat flagged as human because HorseOnboarding inserted the row without the column.';

DROP TRIGGER IF EXISTS trg_club_members_bot_follows_horse ON public.club_members;
CREATE TRIGGER trg_club_members_bot_follows_horse
  BEFORE INSERT OR UPDATE OF user_id, is_bot ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_bot_follows_horse();

COMMENT ON COLUMN public.club_members.is_bot IS
  'Mirror of profiles.is_horse, kept in step by trg_club_members_bot_follows_horse. profiles.is_horse is authoritative; writing this column directly has no lasting effect.';

DO $$
DECLARE v_dis bigint; v_fund bigint; v_trg int;
BEGIN
  SELECT count(*) INTO v_dis
    FROM public.club_members cm JOIN public.profiles p ON p.id = cm.user_id
   WHERE coalesce(p.is_horse,false) <> coalesce(cm.is_bot,false);
  IF v_dis <> 0 THEN RAISE EXCEPTION 'still % disagreeing rows after backfill', v_dis; END IF;

  SELECT count(*) INTO v_trg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname='club_members' AND t.tgname='trg_club_members_bot_follows_horse';
  IF v_trg <> 1 THEN RAISE EXCEPTION 'sync trigger not installed'; END IF;

  SELECT count(*) INTO v_fund FROM public.club_members WHERE is_bot AND is_active;
  RAISE NOTICE 'bot flag reconciled; mass_fund_horses now sees % horses', v_fund;
END $$;
