-- MYSTERY BOUNTY RANGE (2026-08-21)
--
-- tournaments.mystery_bounty_min/max were written as `bounty` and `bounty*10`
-- and rendered in the lobby as MULTIPLIERS ("6x - 60x"). The prize is actually
-- drawn in fn_register_for_tournament / fn_register_horse_for_tournament from
-- a fixed table applied to the player's funded head:
--
--     60% x0.5   25% x1   10% x2   4% x3   1% x13     (expected value 1.0)
--
-- So a $6 head pays $3.00 at the floor and $78.00 at the ceiling. Players were
-- shown a 60x ceiling that cannot occur, and a floor above where 60% of draws
-- actually land. Align the advertised range with the money.
--
-- SCOPE NOTE: rows failing tournaments_rake_within_10_pct are skipped. That
-- constraint is NOT VALID, so it does not reject the existing row but DOES
-- reject any UPDATE to it, and one live event ($13 + $2 = 13.3% rake against
-- the 10% cap) trips it. Its rake predates the one-rake model; changing what
-- seated players already paid is a money decision, not a migration.

UPDATE public.tournaments
   SET mystery_bounty_min = round(bounty_amount * 0.5, 2),
       mystery_bounty_max = round(bounty_amount * 13, 2)
 WHERE is_mystery_bounty
   AND COALESCE(bounty_amount, 0) > 0
   AND status NOT IN ('COMPLETED', 'CANCELLED')
   AND COALESCE(buy_in_fee, 0)
       <= floor((COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0)) * 0.1 + 0.000000001);

DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournaments
   WHERE is_mystery_bounty
     AND COALESCE(bounty_amount,0) > 0
     AND status NOT IN ('COMPLETED','CANCELLED')
     AND COALESCE(buy_in_fee,0)
         <= floor((COALESCE(buy_in_amount,0) + COALESCE(buy_in_fee,0)) * 0.1 + 0.000000001)
     AND (mystery_bounty_min <> round(bounty_amount * 0.5, 2)
       OR mystery_bounty_max <> round(bounty_amount * 13, 2));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'assertion failed: % updatable mystery tournaments still misadvertise', v_bad;
  END IF;
END $$;
