-- 20261026045104_a_horse_s_mystery_chest_opens_when_it_picks.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-25, watching Sunday Funday Mystery: "I JUST WATCHED THE LAST TWO
-- PLAYERS GET ZERO APPEAR ON THE SCREEN INSTEAD OF THE PRIZE THEY GOT", then
-- "LAST 3 PLAYERS NOW! IT SOMETIMES FLASHES IT VERY LATE."
--
-- A person's browser does two things when they pick a chest: it records the
-- pick (fn_mystery_bounty_pick) and it opens the award (fn_mystery_bounty_
-- reveal), so the prize exists the instant they tap. A horse's input device
-- (TournamentManagerEliminations.horseMysteryChestTap) did only the first.
-- The table opened the chest on the horse's tap, but the award stayed sealed
-- until the engine's 10-second deadline: every seat counted up to 0 and the
-- real figure flashed in after the screen had closed. Production 04:20-04:42
-- UTC: every horse pick left `revealed_at` 9.7-11.4 s after the reserve.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5): the horse's tap must do what a
-- person's tap does. When the ENGINE records a pick (the only engine caller is
-- the horse's input device), the award is opened in the same statement,
-- exactly as fn_mystery_bounty_reveal opens it: status 'revealed', the chest
-- 'revealed'. A browser's pick is unchanged - it still calls the reveal itself.
--
-- NOTHING HERE MOVES MONEY. Opening uncovers the award's own chest, fixed at
-- reserve time; payment stays with the engine's deadline settle, which already
-- treats an award revealed by a tap as the normal case (the reveal RPC falls
-- through on an award that is no longer reserved and returns the same payload).
--
-- @live-proof: (SELECT position('A HORSE''S TAP OPENS ITS CHEST' IN pg_get_functiondef('public.fn_mystery_bounty_pick(uuid,integer)'::regprocedure)) > 0)

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pick(p_award_id uuid, p_slot integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_offer public.tournament_bounty_award_offers%ROWTYPE;
  v_slots integer;
  v_engine boolean := COALESCE(auth.role(), '') = 'service_role' OR auth.uid() IS NULL;
  v_status text;
  v_chest uuid;
BEGIN
  IF p_award_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_required');
  END IF;
  IF NOT v_engine AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients r
     WHERE r.award_id = p_award_id AND r.user_id = auth.uid() AND r.is_designated_revealer) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_the_revealer');
  END IF;
  -- LOCK ORDER (2026-10-26 audit): the award first, then the offer, then the
  -- chest - the same order fn_mystery_bounty_reveal and the settle take them
  -- (award, chest, then the offer through zz_refresh_mystery_award_companions).
  -- Locking the award also closes the gap in which a reveal could commit
  -- between an unlocked status read and the pick, and the pick then move the
  -- slot after the reveal (forbidden since 20261022223610).
  SELECT aw.status, aw.chest_id INTO v_status, v_chest
    FROM public.tournament_bounty_awards aw
   WHERE aw.id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;
  -- The pick is made BEFORE the chest opens. Once the award is revealed the
  -- slot it stands in is already fixed (the pick, or the award id when the
  -- chest opened itself), and a later call may not move it. A void award has
  -- no chest to pick.
  IF v_status IN ('revealed', 'paid', 'completed', 'void') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_revealed');
  END IF;
  SELECT * INTO v_offer FROM public.tournament_bounty_award_offers o
   WHERE o.award_id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN
    -- A single chest. The horse's tap still opens it, as a person's does.
    IF v_engine AND v_status = 'reserved' THEN
      UPDATE public.tournament_bounty_awards
         SET status = 'revealed', revealed_at = now()
       WHERE id = p_award_id AND status = 'reserved';
      UPDATE public.tournament_bounty_chests SET status = 'revealed' WHERE id = v_chest;
    END IF;
    RETURN jsonb_build_object('ok', true, 'slots', 1, 'picked_slot', 1);
  END IF;
  v_slots := 1 + jsonb_array_length(v_offer.companions);
  IF v_offer.picked_slot IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'slots', v_slots,
                              'picked_slot', v_offer.picked_slot);
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > v_slots THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_slot', 'slots', v_slots);
  END IF;
  UPDATE public.tournament_bounty_award_offers
     SET picked_slot = p_slot, picked_by = auth.uid(), picked_at = now()
   WHERE award_id = p_award_id;

  -- A HORSE'S TAP OPENS ITS CHEST (2026-10-25). A browser picks and then
  -- reveals; the engine is the horse's browser, so its pick reveals too, the
  -- same way fn_mystery_bounty_reveal does. Every seat can then read the
  -- prize the moment the chest opens instead of counting up to zero.
  IF v_engine AND v_status = 'reserved' THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'revealed', revealed_at = now()
     WHERE id = p_award_id AND status = 'reserved';
    UPDATE public.tournament_bounty_chests SET status = 'revealed' WHERE id = v_chest;
  END IF;

  RETURN jsonb_build_object('ok', true, 'slots', v_slots, 'picked_slot', p_slot);
END;
$function$;

COMMIT;
