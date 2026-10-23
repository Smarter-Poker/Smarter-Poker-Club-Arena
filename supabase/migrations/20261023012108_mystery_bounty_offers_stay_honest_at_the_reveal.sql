-- 20261023012108_mystery_bounty_offers_stay_honest_at_the_reveal.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A review of pick 1 of 3 (20261022162651 onward) found three gaps.
--
-- 1. THE OTHER CHESTS COULD GIVE AWAY THE NEXT PRIZE. Companions were drawn
--    when the award was inserted, from chests available at that moment. In a
--    hand with several knockouts in the money, award 1 could show a chest that
--    award 2 had just reserved, so the table saw award 2's prize before it
--    opened, and that chest had not "stayed in the pool". Now, when an award
--    leaves 'reserved' (it is revealed or settled), any companion that is no
--    longer available is replaced by a chest that still is (never the award's
--    own, never one already shown). Same random draw, read at the reveal.
--
-- 2. THE OFFER SAYS WHETHER ANYONE CHOSE. When the chest opened itself, the
--    slot comes from the award id; the client said "<Name> Picked Chest N".
--    fn_mystery_bounty_offer now returns `chosen`, and the client says
--    "Chest N Held The Prize" when nobody picked.
--
-- 3. THE ADVERTISED RANGE IS WHOLE CHIPS. fn_ca_mystery_mtt_terms scaled
--    mystery_bounty_min/max to two decimals; Dan: never fractions. They now
--    round to whole chips (at least 1).
--
-- Nothing here moves money: the award amount is the award's own chest.
--
-- @live-proof: (SELECT position('''chosen''' IN pg_get_functiondef('public.fn_mystery_bounty_offer(uuid)'::regprocedure)) > 0 AND position('GREATEST(1, round(' IN pg_get_functiondef('public.fn_ca_mystery_mtt_terms()'::regprocedure)) > 0 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_refresh_mystery_award_companions'))

-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';

-- 1. Companions are re-checked at the reveal.
CREATE OR REPLACE FUNCTION public.fn_ca_refresh_mystery_award_companions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_companions jsonb;
  v_keep jsonb := '[]'::jsonb;
  v_need integer;
  c jsonb;
BEGIN
  -- Presentation only: it must never stand between a reveal and its payment.
  BEGIN
    SELECT o.companions INTO v_companions
      FROM public.tournament_bounty_award_offers o
     WHERE o.award_id = NEW.id
     FOR UPDATE;
    IF v_companions IS NULL OR jsonb_array_length(v_companions) = 0 THEN
      RETURN NEW;
    END IF;
    FOR c IN SELECT value FROM jsonb_array_elements(v_companions) LOOP
      IF EXISTS (SELECT 1 FROM public.tournament_bounty_chests ch
                  WHERE ch.id = (c->>'chest_id')::uuid AND ch.status = 'available') THEN
        v_keep := v_keep || jsonb_build_array(c);
      END IF;
    END LOOP;
    v_need := jsonb_array_length(v_companions) - jsonb_array_length(v_keep);
    IF v_need = 0 THEN
      RETURN NEW;
    END IF;
    SELECT v_keep || COALESCE(jsonb_agg(jsonb_build_object(
             'chest_id', x.id, 'tier', x.tier, 'amount_cents', x.amount_cents)), '[]'::jsonb)
      INTO v_keep
      FROM (
        SELECT ch.id, ch.tier, ch.amount_cents
          FROM public.tournament_bounty_chests ch
         WHERE ch.tournament_id = NEW.tournament_id
           AND ch.status = 'available'
           AND ch.id <> NEW.chest_id
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_keep) k
                            WHERE (k->>'chest_id')::uuid = ch.id)
         ORDER BY gen_random_uuid()
         LIMIT v_need
      ) x;
    -- With fewer chests left than were offered, the offer shrinks rather than
    -- show a chest that is no longer in the pool. The picked slot, if any,
    -- still names the prize's place among what remains.
    UPDATE public.tournament_bounty_award_offers
       SET companions = v_keep,
           picked_slot = CASE WHEN picked_slot > 1 + jsonb_array_length(v_keep)
                              THEN 1 + jsonb_array_length(v_keep) ELSE picked_slot END
     WHERE award_id = NEW.id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_refresh_mystery_award_companions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_refresh_mystery_award_companions() TO service_role;

CREATE TRIGGER zz_refresh_mystery_award_companions
  AFTER UPDATE OF status ON public.tournament_bounty_awards
  FOR EACH ROW
  WHEN (OLD.status = 'reserved' AND NEW.status IN ('revealed', 'paid', 'completed'))
  EXECUTE FUNCTION public.fn_ca_refresh_mystery_award_companions();

-- 2. The offer says whether anyone chose.
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
                            'chosen', COALESCE(v_offer.picked_slot IS NOT NULL, false),
                            'revealed', v_revealed, 'choices', v_choices);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_offer(uuid) TO authenticated, service_role;

-- 3. The advertised range is whole chips.
DO $terms$
DECLARE
  sig constant regprocedure := 'public.fn_ca_mystery_mtt_terms()'::regprocedure;
  d text;
  a1 constant text := 'NEW.mystery_bounty_min := round(COALESCE(NEW.mystery_bounty_min, 0) * NEW.bounty_amount / v_old, 2);';
  a2 constant text := 'NEW.mystery_bounty_max := round(COALESCE(NEW.mystery_bounty_max, 0) * NEW.bounty_amount / v_old, 2);';
BEGIN
  d := pg_get_functiondef(sig);
  IF position('GREATEST(1, round(' IN d) > 0 THEN RETURN; END IF;
  IF (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1
     OR (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1 THEN
    RAISE EXCEPTION 'fn_ca_mystery_mtt_terms changed shape; whole-chip range not installed';
  END IF;
  d := replace(d, a1, 'NEW.mystery_bounty_min := GREATEST(1, round(COALESCE(NEW.mystery_bounty_min, 0) * NEW.bounty_amount / v_old));');
  d := replace(d, a2, 'NEW.mystery_bounty_max := GREATEST(1, round(COALESCE(NEW.mystery_bounty_max, 0) * NEW.bounty_amount / v_old));');
  EXECUTE d;
END
$terms$;

COMMIT;
