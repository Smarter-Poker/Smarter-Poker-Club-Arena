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

  /**
   * REACHING THIS LINE MEANS NOBODY PAID FOR THIS HEAD (2026-08-29).
   *
   * The early return above catches every entrant who arrived through a
   * register RPC, because those pre-set the head from the collected buy-in
   * split. So the pool was just increased by an entrant with no recorded
   * contribution -- a satellite seat award, a ticket redemption, a backfill,
   * or a path that does not exist yet.
   *
   * Not blocked: see the migration header. Made loud, once per tournament, so
   * the question can be answered from evidence instead of assumption.
   */
  INSERT INTO financial_alerts (severity, source, message, context)
  SELECT 'warning', 'trg_seed_bounty_head',
         'Bounty pool funded for an entrant with no collected buy-in split',
         jsonb_build_object(
           'tournament_id', NEW.tournament_id,
           'head', v_head,
           'detail', 'this entrant did not arrive through a register RPC, so no bounty '
                  || 'contribution was collected for the head just added to bounty_pool; '
                  || 'fn_finalize_bounty_pool pays any unclaimed remainder to the champion')
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_alerts
      WHERE source = 'trg_seed_bounty_head'
        AND resolved IS NOT TRUE
        AND context->>'tournament_id' = NEW.tournament_id::text);

  RETURN NEW;
END;
$function$
