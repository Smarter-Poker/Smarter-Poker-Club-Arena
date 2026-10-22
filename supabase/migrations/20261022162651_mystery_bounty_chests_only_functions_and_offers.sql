-- 20261022162651_mystery_bounty_chests_only_functions_and_offers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-22, verbatim:
--   "1, DON'T PAY ANY BOUNTIES UNTIL PLAYERS ARE 'IN THE MONEY' ALL BOUNTIES
--    ARE MYSTERY BOUNTY PRIZES ONLY. 2, CHANGE IT TO THE 50/50 HALF PAYOUT,
--    HALF BOUNTY POOL."
-- and, agreed the same morning: every knockout in the money is offered 3
-- sealed chests, picks one, wins what is inside it, and is then shown the two
-- it did not pick; those two are real prizes and go back into the pool, and
-- the next knockout's three are a fresh random draw.
--
-- READ FROM PRODUCTION FIRST (2026-10-22 16:00 UTC). Every mystery event was
-- 50/50 between a "regular" half that paid a flat head on every knockout
-- before the money and a "mystery" half sealed into chests at the money, with
-- a bounty of about 40% of the entry. The 14 mystery events still taking
-- registrations all already hold registrations (horses), so their entry
-- split stays exactly what those players paid; everything else below applies
-- to them.
--
-- 1. THE TERMS LIVE ON THE ROW (trigger a4_mystery_mtt_terms). A paid,
--    pre-start mystery MTT seals 100% of its bounty pool into chests (no
--    regular half), opens them at the money, and describes itself truthfully.
--    A NEW event also splits its entry 50/50: bounty_amount is half of the
--    entry contribution (a whole Diamond at the Diamond Arena), and the
--    advertised mystery range scales with it. Whatever door creates the event
--    (engine spawner, Diamond door, fn_create_tournament), the row is the same.
--
-- 2. NO BOUNTY BEFORE THE MONEY. fn_claim_bounty_legacy_candidate_20260907
--    records a pre-activation bust of a chests-only event as placed with NO
--    bounty obligation (its existing "a place is not a bounty" path), so
--    nothing is paid and the head stays in the pool for the chests. That is
--    the rule, not a fault, so it writes no warning alert. Events that started
--    under the old 50/50 regular/mystery terms keep them to the end.
--    fn_mystery_bounty_unrecorded_head_cents returns 0 for a chests-only
--    event for the same reason: no head is owed out of a regular half.
--
-- 3. PICK 1 OF 3. Every new award gets an offer row holding two companion
--    chests drawn at random (gen_random_uuid, a strong random source) from the
--    chests still available. They stay available: nothing reserves them, so
--    they remain in the pool and the next knockout's offer is its own fresh
--    random draw. fn_mystery_bounty_pick records the slot the designated
--    revealer chose; fn_mystery_bounty_offer shows the three prizes only once
--    the award is revealed (assigning a random slot if nobody picked). The
--    award's own chest is the prize in the slot the player picked: the chest
--    order was shuffled with a CSPRNG when the inventory was sealed, so the
--    player's prize is a uniformly random chest whichever slot is chosen -
--    exactly the odds of three random hidden chests - and every amount shown
--    is a real chest of this event. No money function changes.
--
-- 4. fn_mystery_bounty_inventory also reports regular_pool_percent, so the
--    lobby can say "no bounties before the money" only where that is true.
--
--
-- Part 1 of 3 (functions and the offer table; no lock on a live table).
-- @live-proof: (SELECT position('mystery_bounties_start_in_the_money' IN pg_get_functiondef('public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure)) > 0 AND to_regclass('public.tournament_bounty_award_offers') IS NOT NULL AND to_regprocedure('public.fn_mystery_bounty_offer(uuid)') IS NOT NULL)

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Part 1 of 3: functions and the offer table. No lock on a live table.

CREATE OR REPLACE FUNCTION public.fn_ca_mystery_mtt_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_unit bigint;
  v_half bigint;
  v_old numeric;
  v_bounty_pct integer;
BEGIN
  IF NOT COALESCE(NEW.is_mystery_bounty, false) OR COALESCE(NEW.is_pko, false) THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.tournament_type, 'MTT')) <> 'MTT'
     OR lower(COALESCE(NEW.variant, '')) = 'satellite'
     OR NEW.satellite_target_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF upper(COALESCE(NEW.status, 'REGISTERING')) NOT IN ('REGISTERING', 'ANNOUNCED')
     OR COALESCE(NEW.mystery_bounty_stage, 'pending') <> 'pending' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.buy_in_amount, 0) + COALESCE(NEW.buy_in_fee, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  -- Half the entry contribution is the bounty, on the event's own grid. Only
  -- at creation: an event that already took entries keeps the split they paid.
  IF TG_OP = 'INSERT' THEN
    v_unit := CASE WHEN EXISTS (SELECT 1 FROM public.clubs c
                                 WHERE c.id = NEW.club_id AND c.asset = 'diamonds')
                   THEN 100 ELSE 1 END;
    v_half := (floor(round(COALESCE(NEW.buy_in_amount, 0) * 100) / 2.0 / v_unit) * v_unit)::bigint;
    IF v_half > 0 THEN
      v_old := NEW.bounty_amount;
      NEW.bounty_amount := v_half / 100.0;
      IF COALESCE(v_old, 0) > 0 AND v_old <> NEW.bounty_amount THEN
        NEW.mystery_bounty_min := round(COALESCE(NEW.mystery_bounty_min, 0) * NEW.bounty_amount / v_old, 2);
        NEW.mystery_bounty_max := round(COALESCE(NEW.mystery_bounty_max, 0) * NEW.bounty_amount / v_old, 2);
      END IF;
    END IF;
  END IF;

  NEW.mystery_bounty_pool_percent := 100;
  NEW.mystery_bounty_regular_pool_percent := 0;
  NEW.mystery_bounty_activation := 'at_the_money';
  NEW.mystery_bounty_activation_value := NULL;

  IF COALESCE(NEW.buy_in_amount, 0) > 0 AND COALESCE(NEW.bounty_amount, 0) > 0 THEN
    v_bounty_pct := round(NEW.bounty_amount * 100 / NEW.buy_in_amount)::integer;
    NEW.short_description := format(
      '%s%% Of Each Entry Funds The Prize Pool And %s%% Funds The Mystery Bounty Pool. '
      || 'No Bounties Are Paid Before The Money. Once The Tournament Reaches The Money, '
      || 'Every Knockout Picks 1 Of 3 Mystery Chests.',
      100 - v_bounty_pct, v_bounty_pct);
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_mystery_mtt_terms() IS
  'Dan 2026-10-22: a paid pre-start mystery MTT seals its whole bounty pool into chests opened at the money (no bounty before the money); a new one splits its entry 50/50 between prize pool and bounty pool.';

-- Root may apply these terms to a registered pre-start event, the same narrow
-- way 20261021222049 let it lock the level clock. Only these keys.
DO $guard$
DECLARE
  d text;
  anchor constant text := '        -- Root may correct only the known literal-eight Diamond clock';
  clause constant text :=
'        -- Root may apply the mystery terms to a pre-start event (Dan 2026-10-22:
        -- no bounty before the money; chests only). Only these keys.
        CONTINUE WHEN v_key IN (''mystery_bounty_pool_percent'', ''mystery_bounty_activation'', ''mystery_bounty_activation_value'', ''short_description'')
          AND current_user = ''postgres''
          AND COALESCE(current_setting(''app.mystery_terms_rule'', true), '''') = ''on''
          AND upper(COALESCE(OLD.status, '''')) IN (''ANNOUNCED'', ''REGISTERING'');
';
BEGIN
  d := pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure);
  IF position('Root may apply the mystery terms to a pre-start event' IN d) > 0 THEN RETURN; END IF;
  IF position(anchor IN d) = 0 THEN
    RAISE EXCEPTION 'fn_guard_managed_game_lifecycle changed shape; mystery terms exception not installed';
  END IF;
  EXECUTE replace(d, anchor, clause || anchor);
END
$guard$;

-- ═══ 2. No bounty before the money ═════════════════════════════════════════

DO $claim$
DECLARE
  sig constant regprocedure :=
    'public.fn_claim_bounty_legacy_candidate_20260907(uuid,uuid,integer,numeric,uuid,uuid,bigint,timestamp with time zone,uuid,jsonb,numeric,boolean)'::regprocedure;
  d text;
  a1 constant text := E'  IF v_mode=''pko'' THEN\n    v_predecessors:=public.fn_pko_claim_predecessor_status_v1(';
  c1 constant text := E'  /* NO BOUNTY BEFORE THE MONEY (Dan 2026-10-22). A chests-only mystery\n'
    || E'     event pays nothing for a bust before its chests open: the bust is\n'
    || E'     placed and the head stays in the pool for the chests. */\n'
    || E'  IF v_mode=''mystery_pre'' AND EXISTS (\n'
    || E'       SELECT 1 FROM public.tournaments tt\n'
    || E'        WHERE tt.id=p_tournament_id\n'
    || E'          AND COALESCE(tt.mystery_bounty_regular_pool_percent,50)=0) THEN\n'
    || E'    v_bounty_blocked:=''mystery_bounties_start_in_the_money'';\n'
    || E'  END IF;\n\n';
  a2 constant text := E'    INSERT INTO public.financial_alerts(severity,source,message,context)\n    VALUES (''warning'',\n      ''fn_claim_tournament_bounty_elimination.bounty_head_not_attributed'',';
  a3 constant text := E'''mode'',v_mode,''reason'',v_bounty_blocked));\n  END IF;';
  n integer;
BEGIN
  d := pg_get_functiondef(sig);
  IF position('mystery_bounties_start_in_the_money' IN d) > 0 THEN RETURN; END IF;
  FOREACH n IN ARRAY ARRAY[
    (length(d) - length(replace(d, a1, ''))) / length(a1),
    (length(d) - length(replace(d, a2, ''))) / length(a2),
    (length(d) - length(replace(d, a3, ''))) / length(a3)] LOOP
    IF n <> 1 THEN
      RAISE EXCEPTION 'fn_claim_bounty_legacy_candidate_20260907 changed shape; no-bounty-before-the-money not installed';
    END IF;
  END LOOP;
  d := replace(d, a1, c1 || a1);
  d := replace(d, a2,
    E'    IF v_bounty_blocked IS DISTINCT FROM ''mystery_bounties_start_in_the_money'' THEN\n' || a2);
  d := replace(d, a3,
    E'''mode'',v_mode,''reason'',v_bounty_blocked));\n    END IF;\n  END IF;');
  EXECUTE d;
END
$claim$;

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Heads earned by a bust the hand commit has proven (knockout candidate
  -- 'pending') that the claim door has not yet recorded (player still
  -- 'playing'). Same head expression as fn_claim_bounty_legacy_candidate_20260907
  -- and fn_collect_bounty, so the reserve is exactly what will be collected.
  -- A chests-only event (regular half 0, Dan 2026-10-22) owes no head before
  -- the money, so nothing is held back from its chests.
  SELECT COALESCE(sum(round(COALESCE(NULLIF(tp.current_bounty,0),
                                     t.bounty_amount, 0) * 100)), 0)::bigint
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing'
     AND NOT (COALESCE(t.is_mystery_bounty, false)
              AND COALESCE(t.mystery_bounty_regular_pool_percent, 50) = 0)
     AND EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id = tp.tournament_id
          AND c.eliminated_user_id = tp.user_id
          AND c.state = 'pending');
$function$;

-- ═══ 3. Pick 1 of 3 ════════════════════════════════════════════════════════

-- No foreign keys (CLAUDE.md section 2 rule 7): an offer is presentation, and
-- a lock on the award or chest tables is not worth one.
CREATE TABLE IF NOT EXISTS public.tournament_bounty_award_offers (
  award_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  companions jsonb NOT NULL DEFAULT '[]'::jsonb,
  picked_slot smallint,
  picked_by uuid,
  picked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tournament_bounty_award_offers_slot_check
    CHECK (picked_slot IS NULL OR picked_slot BETWEEN 1 AND 3),
  CONSTRAINT tournament_bounty_award_offers_companions_check
    CHECK (jsonb_typeof(companions) = 'array' AND jsonb_array_length(companions) <= 2)
);
ALTER TABLE public.tournament_bounty_award_offers ENABLE ROW LEVEL SECURITY;
-- Every read and write goes through the SECURITY DEFINER doors below
-- (fn_mystery_bounty_pick / fn_mystery_bounty_offer and the award trigger), so
-- no role is granted the table itself. (Applied as one REVOKE after this file's
-- first install, which revoked anon and authenticated only.)
REVOKE ALL ON public.tournament_bounty_award_offers FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.tournament_bounty_award_offers IS
  'Dan 2026-10-22 pick 1 of 3: the two companion chests offered beside each mystery award (real chests, left available in the pool) and the slot the player picked.';

CREATE OR REPLACE FUNCTION public.fn_ca_offer_mystery_award_companions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Presentation only: it must never stand between a knockout and its chest.
  BEGIN
    INSERT INTO public.tournament_bounty_award_offers (award_id, tournament_id, companions)
    SELECT NEW.id, NEW.tournament_id,
           COALESCE(jsonb_agg(jsonb_build_object(
             'chest_id', x.id, 'tier', x.tier, 'amount_cents', x.amount_cents)), '[]'::jsonb)
      FROM (
        SELECT c.id, c.tier, c.amount_cents
          FROM public.tournament_bounty_chests c
         WHERE c.tournament_id = NEW.tournament_id
           AND c.status = 'available'
           AND c.id <> NEW.chest_id
         ORDER BY gen_random_uuid()
         LIMIT 2
      ) x
    ON CONFLICT (award_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$fn$;


-- The designated revealer picks a slot. Once. Before or after the engine's own
-- reveal, because the player has not seen any amount until the offer says so.
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

-- What the player was offered. Before the reveal: only how many chests there
-- are and which one was picked. After it: all of them, with the amounts.
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_offer(p_award_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
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
    -- same order and reading the offer writes nothing. (As first applied this
    -- drew a random slot and wrote it; 20261022180857 replaced that, and this
    -- file states the body that is live so a rebuild matches production.)
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

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_pick(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_pick(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_offer(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_ca_offer_mystery_award_companions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_mystery_mtt_terms() FROM PUBLIC, anon, authenticated;

-- ═══ 4. The lobby can tell a chests-only event ═══════════════════════════

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_inventory(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'pool_cents', COALESCE(t.mystery_bounty_pool_cents, 0),
    'stage', t.mystery_bounty_stage,
    'profile', t.mystery_bounty_profile,
    'activation', t.mystery_bounty_activation,
    'activation_value', t.mystery_bounty_activation_value,
    'activated_players', t.mystery_bounty_activated_players,
    'activated_at', t.mystery_bounty_activated_at,
    'regular_pool_percent', t.mystery_bounty_regular_pool_percent,
    'tiers', COALESCE((
      SELECT jsonb_agg(row_to_json(x) ORDER BY x.amount_cents DESC)
        FROM (
          SELECT c.tier,
                 c.amount_cents,
                 count(*)::int AS original,
                 count(*) FILTER (WHERE c.status IN ('reserved','revealed','paid'))::int AS awarded,
                 count(*) FILTER (WHERE c.status = 'available')::int AS remaining
            FROM public.tournament_bounty_chests c
           WHERE c.tournament_id = p_tournament_id
           GROUP BY c.tier, c.amount_cents
        ) x
    ), '[]'::jsonb))
  FROM public.tournaments t WHERE t.id = p_tournament_id;
$function$;

COMMIT;
