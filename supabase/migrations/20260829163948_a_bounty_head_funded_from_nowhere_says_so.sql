-- ═══════════════════════════════════════════════════════════════════════════
--  A BOUNTY HEAD FUNDED FROM NOWHERE SAYS SO (2026-08-29)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- trg_seed_bounty_head returns early when NEW.current_bounty > 0, which is the
-- case for both register RPCs -- they pre-set the head from
-- fn_tournament_entry_split, i.e. from money actually collected. Any entrant
-- row that reaches the funding line therefore did NOT come through a paying
-- path, and the trigger adds tournaments.bounty_amount to bounty_pool anyway.
--
-- The 2026-08-27 migration that rewrote the head logic names this and leaves
-- it: "NOT CHANGED, ON PURPOSE: the bounty_pool increment... Flagged, not
-- touched." fn_finalize_bounty_pool pays bounty_pool - bounty_pool_paid to the
-- champion, so any over-funding becomes real chips handed to a player.
--
-- WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT.
--
-- It does NOT stop the funding. Measured before writing this: zero events in
-- the last seven days show a bounty pool without collection, so nothing is
-- known to walk this path today -- and if something does, refusing to fund is
-- not obviously safer. An unfunded head still makes its holder knockable, and
-- fn_collect_bounty caps payment at the unpaid pool, so the cost of
-- under-funding lands on whichever knockouts happen LAST. That is the shape of
-- the defect that cost 3,158 knockouts their bounty between 18 and 27 August;
-- trading a visible over-funding for an invisible under-funding would be a
-- poor trade made on a guess.
--
-- What it does is make the case VISIBLE. Whether a free entrant's head should
-- be funded by the club, by the satellite that sent them, or not granted at
-- all is a design decision, and the first thing that decision needs is to know
-- the path is being walked. One alert per tournament, so a 300-entrant event
-- cannot flood the table.
--
-- ── ROLLBACK ──────────────────────────────────────────────────────────────
-- Restore the previous body: identical, minus the financial_alerts INSERT.
-- ──────────────────────────────────────────────────────────────────────────

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
$function$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='trg_seed_bounty_head';
  IF position('SET current_bounty = v_head' in v_def) = 0 THEN
    RAISE EXCEPTION 'the head is no longer being set';
  END IF;
  IF position('bounty_pool = round(COALESCE(bounty_pool, 0) + v_head, 2)' in v_def) = 0 THEN
    RAISE EXCEPTION 'the pool funding was removed - that was not the intent';
  END IF;
  PERFORM 1 FROM pg_trigger WHERE tgname = 'seed_bounty_head' AND tgenabled = 'O';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seed_bounty_head is not attached and enabled';
  END IF;
END $$;
