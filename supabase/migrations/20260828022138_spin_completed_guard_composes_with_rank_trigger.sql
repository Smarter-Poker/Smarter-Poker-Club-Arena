-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022138; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- spin_completed_guard_composes_with_rank_trigger
--
-- WHAT WAS ASKED FOR, AND WHY MOST OF IT IS ALREADY DONE
-- -----------------------------------------------------
-- The Spins audit asked for a guard stopping a Spin from flipping to
-- COMPLETED while a seat still has a null position. Before writing one I
-- checked what is already there, because a colleague shipped
-- public.tournaments_rank_before_complete -- a BEFORE UPDATE trigger on
-- public.tournaments, firing on the COMPLETED transition, which calls
-- public.fn_rank_survivors(uuid) and hands every null-position seat a free
-- rank ordered by chips.
--
-- That already covers Spins, and I can show it rather than assert it:
--   * 40 COMPLETED Spins in history still carry a null-position seat. The
--     most recent of them ended 2026-08-25 17:09:06 UTC.
--   * Since that instant, 10,267 Spins have completed and ZERO of them have
--     a null-position seat.
-- Reading fn_rank_survivors confirms why: it takes v_bound = GREATEST(seat
-- count, max position), computes the free positions in 1..v_bound, and joins
-- survivors to them by row number. The count of free slots is always >= the
-- count of survivors, so every survivor always gets a rank. The invariant
-- holds by construction, not by luck.
--
-- So: I have NOT dropped, replaced or duplicated that trigger, and I have
-- not written a second ranking path.
--
-- WHAT SPINS STILL NEED THAT RANKING DOES NOT GIVE THEM
-- ----------------------------------------------------
-- Ranking is not paying. Of the 36 Spins that drew a prize from the reserve
-- and credited nobody, 26 had the unranked-survivor shape the audit
-- described -- but the other 10 had a completely well-formed final table, a
-- seat at position 1 with status='winner', and STILL prize=0.00 with no
-- wallet credit. Those 10 are worth 391.00 chips. fn_rank_survivors would
-- have ranked them and changed nothing, because they were already ranked.
-- The money invariant is a different invariant from the ranking invariant.
--
-- So this migration adds ONE separate object that composes with the existing
-- trigger rather than fighting it:
--
--   trigger public.tournaments_spin_completed_guard
--     -> public.trg_spin_completed_guard()
--
-- Both are BEFORE UPDATE on public.tournaments. Postgres fires BEFORE ROW
-- triggers in alphabetical name order, and 'tournaments_rank_...' sorts
-- before 'tournaments_spin_...', so the ranking trigger has always already
-- run by the time this one looks. This one observes the state the other one
-- produced. That ordering is deliberate; do not rename either trigger
-- without re-checking it.
--
-- BLOCK VS ALERT -- THE ONE JUDGEMENT CALL HERE
-- ---------------------------------------------
-- The guard HARD BLOCKS only the null-position condition, which is the
-- invariant that was actually requested. Given the proof above that
-- fn_rank_survivors always fills every seat, this branch is unreachable in
-- normal operation; it is a tripwire that fires only if the ranking trigger
-- is dropped, disabled or broken by a future change. Cost today: nothing.
--
-- The money condition -- prize drawn from the reserve, nothing credited --
-- is ALERT ONLY, and I want to be explicit about why, because it looks like
-- the weaker choice. If we raise here we abort the COMPLETED flip. The Spin
-- then sits RUNNING forever, the seats stay locked, and the players' buy-ins
-- stay committed with no way out. That is a strictly worse outcome for the
-- player than a completed game plus a loud alert. Refusing to finish a game
-- does not put money back in anyone's wallet. So we let the flip through and
-- shout.
--
-- The check is sound at this point in time: across the 14,571 Spins
-- completed in the last three days, the prize credit landed BEFORE the
-- COMPLETED flip in 14,571 of 14,571 cases, a mean of 3.2 seconds earlier.
-- There is no legitimate "the credit is still coming" case to false-positive
-- on. If that ordering ever changes, this trigger starts crying wolf and
-- should be revisited -- it will not, however, break anything.
--
-- Moves no money. Writes financial_alerts and nothing else.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_spin_completed_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_unranked integer;
  v_drawn    numeric;
  v_credited numeric;
BEGIN
  -- Spins only. Every other variant is another agent's lane.
  IF COALESCE(NEW.variant, '') <> 'spin' THEN
    RETURN NEW;
  END IF;

  -- (1) The requested CAS invariant. tournaments_rank_before_complete has
  --     already run by now and should have made this impossible.
  SELECT COUNT(*) INTO v_unranked
    FROM public.tournament_players tp
   WHERE tp.tournament_id = NEW.id
     AND tp.position IS NULL;

  IF v_unranked > 0 THEN
    RAISE EXCEPTION
      'refusing to complete Spin %: % seat(s) still have a null position after ranking. '
      'public.fn_rank_survivors should have filled these; check whether '
      'tournaments_rank_before_complete is still enabled.',
      NEW.id, v_unranked
      USING ERRCODE = 'check_violation';
  END IF;

  -- (2) The money invariant the audit was really about. Alert, do not block.
  SELECT COALESCE(SUM(-l.amount), 0) INTO v_drawn
    FROM public.spin_reserve_ledger l
   WHERE l.tournament_id = NEW.id
     AND l.kind = 'jackpot_draw';

  IF v_drawn > 0 THEN
    SELECT COALESCE(SUM(w.amount), 0) INTO v_credited
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = NEW.id
       AND w.type = 'credit'
       AND w.category = 'prize';

    IF round(v_drawn - v_credited, 2) <> 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT CASE WHEN v_credited = 0 THEN 'critical' ELSE 'warning' END,
             'trg_spin_completed_guard',
             format('Spin %s completed having drawn %s from the reserve but credited %s to players',
                    COALESCE(NEW.name, NEW.id::text), v_drawn, v_credited),
             jsonb_build_object('tournament_id',  NEW.id,
                                'club_id',        NEW.club_id,
                                'prize_drawn',    v_drawn,
                                'prize_credited', v_credited,
                                'chips_short',    round(v_drawn - v_credited, 2),
                                'buy_in',         NEW.buy_in_amount,
                                'multiplier',     NEW.spin_multiplier,
                                'caught_at',      'COMPLETED flip',
                                'detail',         'flip allowed on purpose; blocking it would strand the seats and the buy-ins')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts fa
          WHERE fa.source = 'trg_spin_completed_guard'
            AND fa.resolved IS NOT TRUE
            AND fa.context->>'tournament_id' = NEW.id::text);
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.trg_spin_completed_guard() IS
  'Spin-only companion to trg_tournaments_rank_before_complete. Blocks a '
  'COMPLETED flip that still has null-position seats (a tripwire: the rank '
  'trigger makes this unreachable), and raises a financial_alert when the '
  'reserve was drawn but players were not credited. Never blocks on money.';

DROP TRIGGER IF EXISTS tournaments_spin_completed_guard ON public.tournaments;

-- Name matters: BEFORE ROW triggers fire in alphabetical order, and
-- 'tournaments_rank_before_complete' < 'tournaments_spin_completed_guard',
-- so the ranking trigger runs first and this one inspects its result.
CREATE TRIGGER tournaments_spin_completed_guard
  BEFORE UPDATE ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
  EXECUTE FUNCTION public.trg_spin_completed_guard();

