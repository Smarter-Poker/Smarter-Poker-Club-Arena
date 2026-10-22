-- 20261022180735_mystery_bounty_offer_reads_without_writing.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_mystery_bounty_offer (20261022162651) is the read every viewer of a
-- revealed mystery chest makes. When the chest opened itself (nobody picked),
-- it drew a random slot and wrote it, so a signed-in caller could make it
-- write. Nothing else depended on that write: the prize is the award's own
-- chest in whichever slot it is shown. The slot now comes from the award's
-- own random id, the same for every viewer, and the read writes nothing. The
-- picked slot a player chooses is still written only by fn_mystery_bounty_pick,
-- which checks who is calling.
--
-- @live-proof: (SELECT position('uuid_send(p_award_id), 15' IN pg_get_functiondef('public.fn_mystery_bounty_offer(uuid)'::regprocedure)) > 0 AND position('UPDATE public.tournament_bounty_award_offers' IN pg_get_functiondef('public.fn_mystery_bounty_offer(uuid)'::regprocedure)) = 0)

-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_offer(p_award_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  a record;
  v_offer public.tournament_bounty_award_offers%ROWTYPE;
  v_slots integer := 1;
  v_pick integer;
  v_revealed boolean;
  v_choices jsonb := '[]'::jsonb;
  v_companion integer := 0;
  s integer;
BEGIN
  SELECT aw.id, aw.amount_cents, aw.tier, aw.status
    INTO a FROM public.tournament_bounty_awards aw WHERE aw.id = p_award_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found');
  END IF;
  v_revealed := a.status IN ('revealed', 'paid', 'completed');

  SELECT * INTO v_offer FROM public.tournament_bounty_award_offers o
   WHERE o.award_id = p_award_id;
  IF FOUND THEN
    v_slots := 1 + jsonb_array_length(v_offer.companions);
    v_pick := v_offer.picked_slot;
    -- Nobody picked before the reveal: the chest opened itself. The slot it
    -- stands in comes from the award's own random id, so every viewer sees the
    -- same order and reading the offer writes nothing. The prize is the
    -- award's chest whichever slot it stands in.
    IF v_revealed AND v_pick IS NULL THEN
      v_pick := 1 + (get_byte(uuid_send(p_award_id), 15) % v_slots);
    END IF;
  ELSE
    v_pick := 1;
  END IF;

  IF v_revealed THEN
    FOR s IN 1..v_slots LOOP
      IF s = v_pick THEN
        v_choices := v_choices || jsonb_build_object('slot', s, 'picked', true,
          'amount_cents', a.amount_cents, 'tier', a.tier);
      ELSE
        v_choices := v_choices || jsonb_build_object('slot', s, 'picked', false,
          'amount_cents', (v_offer.companions -> v_companion ->> 'amount_cents')::bigint,
          'tier', v_offer.companions -> v_companion ->> 'tier');
        v_companion := v_companion + 1;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'slots', v_slots, 'picked_slot', v_pick,
                            'revealed', v_revealed, 'choices', v_choices);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_offer(uuid) TO authenticated, service_role;

COMMIT;
