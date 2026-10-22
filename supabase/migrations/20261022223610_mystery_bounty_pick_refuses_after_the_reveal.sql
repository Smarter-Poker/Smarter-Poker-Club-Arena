-- 20261022223610_mystery_bounty_pick_refuses_after_the_reveal.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_mystery_bounty_pick (20261022162651) records the chest the knockout
-- picks from the three on offer. It checked who was calling and that the slot
-- had not been picked, but not whether the chest had already opened. A chest
-- that opened itself (no pick) shows its prize in the slot taken from the
-- award id; a pick sent after that would have moved the prize into another
-- slot on every screen. No amount was ever affected (the prize is the award's
-- own chest), but the record of the choice must not change after the reveal.
-- The pick now refuses once the award is revealed, or void.
--
-- @live-proof: (SELECT position('already_revealed' IN pg_get_functiondef('public.fn_mystery_bounty_pick(uuid,integer)'::regprocedure)) > 0)

-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_pick(p_award_id uuid, p_slot integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_offer public.tournament_bounty_award_offers%ROWTYPE;
  v_slots integer;
  v_engine boolean := COALESCE(auth.role(), '') = 'service_role' OR auth.uid() IS NULL;
BEGIN
  IF p_award_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_required');
  END IF;
  IF NOT v_engine AND NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_award_recipients r
     WHERE r.award_id = p_award_id AND r.user_id = auth.uid() AND r.is_designated_revealer) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_the_revealer');
  END IF;
  -- The pick is made BEFORE the chest opens. Once the award is revealed the
  -- slot it stands in is already fixed (the pick, or the award id when the
  -- chest opened itself), and a later call may not move it. A void award has
  -- no chest to pick.
  IF EXISTS (SELECT 1 FROM public.tournament_bounty_awards aw
              WHERE aw.id = p_award_id AND aw.status IN ('revealed', 'paid', 'completed', 'void')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_revealed');
  END IF;
  SELECT * INTO v_offer FROM public.tournament_bounty_award_offers o
   WHERE o.award_id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN
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
  RETURN jsonb_build_object('ok', true, 'slots', v_slots, 'picked_slot', p_slot);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pick(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pick(uuid, integer) TO authenticated, service_role;

COMMIT;
