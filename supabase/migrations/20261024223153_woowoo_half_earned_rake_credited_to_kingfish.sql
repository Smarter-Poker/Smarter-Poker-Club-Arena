-- Owner ruling (Dan, 2026-10-24, approved explicitly): WooWoo's earned rake is
-- split 50/50 - half stays his, half is credited to KingFish (player #1) - for
-- the rake already earned and for every later hand, refreshed every 5 minutes.
-- Reporting-only: fee redemptions adjust earned-rake / fee displays; no chips move
-- and settled books are untouched.

-- 1. Allow a negative row, which credits earned rake / fees to a player.
ALTER TABLE smarter_private.player_fee_redemptions
  DROP CONSTRAINT player_fee_redemptions_amount_cents_check;
ALTER TABLE smarter_private.player_fee_redemptions
  ADD CONSTRAINT player_fee_redemptions_amount_cents_check CHECK (amount_cents <> 0);

-- 2. Credit KingFish with the half already removed from WooWoo today (520.52).
INSERT INTO smarter_private.player_fee_redemptions(operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
SELECT 'kingfish-from-woowoo-half-earned-rake-20261024', r.club_id,
       '47965354-0e56-43ef-931c-ddaab82af765'::uuid, r.effective_on, -r.amount_cents,
       'Owner-directed (Dan, 2026-10-24): the 520.52 of earned rake removed from WooWoo is credited to KingFish. Reporting credit only; no chip movement.', now()
  FROM smarter_private.player_fee_redemptions r
 WHERE r.operation_key = 'woowoo-half-earned-rake-20261024'
ON CONFLICT (operation_key) DO NOTHING;

-- 3. Standing rule for every WooWoo cash hand after the first cut.
CREATE OR REPLACE FUNCTION smarter_private.fn_woowoo_half_rake_to_kingfish_sync()
RETURNS void LANGUAGE plpgsql SET search_path = public, smarter_private AS $$
DECLARE
  c_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_woowoo constant uuid := '69f2cefa-017d-49f3-ac3e-61505633747c';
  c_kingfish constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
  c_cutoff constant timestamptz := '2026-10-24 22:21:59.97593+00';
  d record;
BEGIN
  FOR d IN
    SELECT (f.played_at AT TIME ZONE 'UTC')::date AS day,
           round(sum(coalesce(f.rake_paid, 0)) * 50)::bigint AS half_cents
      FROM public.ca_hand_facts f
     WHERE f.user_id = c_woowoo AND f.tournament_id IS NULL AND f.played_at > c_cutoff
     GROUP BY 1
  LOOP
    CONTINUE WHEN d.half_cents <= 0;
    INSERT INTO smarter_private.player_fee_redemptions AS r(operation_key, club_id, user_id, effective_on, amount_cents, reason, recorded_at)
    VALUES ('woowoo-half-split-' || d.day, c_club, c_woowoo, d.day, d.half_cents,
            'Owner-directed standing rule (Dan, 2026-10-24): half of WooWoo''s earned rake for this day is removed from his credit and given to KingFish.', now()),
           ('kingfish-from-woowoo-split-' || d.day, c_club, c_kingfish, d.day, -d.half_cents,
            'Owner-directed standing rule (Dan, 2026-10-24): KingFish is credited with the half of WooWoo''s earned rake removed for this day.', now())
    ON CONFLICT (operation_key) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents, recorded_at = now()
      WHERE r.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION smarter_private.fn_woowoo_half_rake_to_kingfish_sync() FROM PUBLIC;

SELECT cron.schedule('woowoo-half-rake-to-kingfish', '*/5 * * * *',
                     'SELECT smarter_private.fn_woowoo_half_rake_to_kingfish_sync()');
SELECT smarter_private.fn_woowoo_half_rake_to_kingfish_sync();