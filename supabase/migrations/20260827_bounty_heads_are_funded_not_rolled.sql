-- ============================================================================
-- A BOUNTY HEAD IS FUNDED, NOT ROLLED.
--
-- Migration 20260825410000 section 9 is titled "NEUTRALISE THE REGISTRATION-TIME
-- DRAW" and server/src/tournament/mysteryBountyDraw.ts says the random() roll at
-- the till is gone. It was not gone. It had moved into trg_seed_bounty_head,
-- which nobody re-checked, and it ran there until this migration:
--
--     v_roll := random() * 100;
--     IF    v_roll < 60 THEN v_mult := 0.5;
--     ELSIF v_roll < 85 THEN v_mult := 1;
--     ELSIF v_roll < 95 THEN v_mult := 2;
--     ELSIF v_roll < 99 THEN v_mult := 3;
--     ELSE                   v_mult := 13;
--
-- The ladder's EV is 1x, so it funds "in aggregate" only over an infinite field.
-- On a real 22-99 player event it does not, and every mystery tournament in the
-- fortnight before this migration carried more head than pool:
--
--   Evening Mystery Bounty (PLO5)  59 entrants  pool  354.00  heads  534.00  (+180)
--   Union Mystery Bounty (PLO5)    22 entrants  pool  220.00  heads  320.00  (+100)
--   Union Mystery Bounty (PLO5)    99 entrants  pool  990.00  heads 1080.00  (+90)
--
-- Those events structurally could not pay their own heads. The 13x tail is the
-- whole problem: one unlucky draw puts a head on the felt that thirteen
-- entrants' contributions have to cover.
--
-- The architecture already had the right answer and this trigger was competing
-- with it. A mystery value is drawn at the KNOCKOUT from a chest inventory that
-- fn_mystery_bounty_seed has already proven adds up (it refuses with
-- 'inventory_mismatch' unless sum(chests) = pool_cents exactly). That draw is
-- funded by construction. A PRNG at registration is not.
--
-- So the trigger now seeds the flat bounty_amount and nothing else, which is
-- exactly what fn_register_for_tournament and fn_register_horse_for_tournament
-- already do on the paths they own.
--
-- SAFE WHEN APPLIED: no live mystery tournament had an over-funded head at the
-- time (2 REGISTERING, mystery_bounty_stage 'pending', 0 rows over). Pure
-- prevention. Finished events are left exactly as they are, because rewriting
-- the recorded heads of a settled tournament would be inventing history rather
-- than fixing code.
--
-- NOT CHANGED, ON PURPOSE: the bounty_pool increment. It is the ONLY funding for
-- entrants who arrive through a path other than the two register RPCs (satellite
-- seat awards, ticket redemptions) - the register RPCs pre-set current_bounty, so
-- the guard at the top returns early for them and there is no double count.
-- Whether a free seat should fund a bounty pool at all is a pricing question for
-- Dan, not a bug an agent gets to decide silently. Flagged, not touched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_seed_bounty_head()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_head numeric;
BEGIN
  -- Already seeded by fn_register_for_tournament / fn_register_horse_for_tournament.
  IF COALESCE(NEW.current_bounty, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount
    INTO v_t FROM tournaments WHERE id = NEW.tournament_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
          OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    RETURN NEW;
  END IF;

  v_head := round(COALESCE(v_t.bounty_amount, 0), 2);
  IF v_head <= 0 THEN RETURN NEW; END IF;

  -- EVERY bounty format, mystery included, puts the FLAT bounty on the head.
  -- The mystery value is drawn from the funded chest inventory at the knockout
  -- (fn_mystery_bounty_reserve), not from a PRNG at the till. mystery_bounty_value
  -- is deliberately left alone here: it is set by the reveal, from the chest.
  UPDATE tournament_players
     SET current_bounty = v_head
   WHERE id = NEW.id;

  -- Fund the pool by this entrant's bounty contribution.
  UPDATE tournaments
     SET bounty_pool = round(COALESCE(bounty_pool, 0) + v_head, 2)
   WHERE id = NEW.tournament_id;

  RETURN NEW;
END;
$function$;

DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM pg_proc
   WHERE proname = 'trg_seed_bounty_head'
     AND pronamespace = 'public'::regnamespace
     AND pg_get_functiondef(oid) ILIKE '%random()%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'trg_seed_bounty_head still rolls random() - the draw belongs to the funded chest inventory, not to registration';
  END IF;
END $$;

COMMENT ON FUNCTION public.trg_seed_bounty_head() IS
  'Seeds a bounty entrant''s head with the FLAT tournaments.bounty_amount and funds bounty_pool by the same figure. Never rolls a multiplier: the mystery value comes from the funded chest inventory at the knockout (fn_mystery_bounty_reserve). See migration 20260827_bounty_heads_are_funded_not_rolled.';
