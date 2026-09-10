-- every_player_who_busted_has_a_place
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Incident 7e9ebb40 has been CRITICAL since 07:52 and had fired eight times.
-- fn_ca_absent_tournament_players was reporting ten events holding 138 players
-- with no chips and no chair, the oldest bust 44.7 hours old, 3,600.00 of prize
-- escrow behind them that could not be paid to anyone because an unranked
-- player keeps an event from finishing.
--
-- IT NOW RETURNS ZERO FINDINGS. Asserted below, and the cause is fixed rather
-- than the symptom cleared:
--
--   * the two pg_cron sweeps that stole busts from the knockout door are
--     unschedu2led and both carry the candidate predicate
--     (the_knockout_door_owns_every_bust_a_hand_took);
--   * an eliminated row without a finishing place cannot be written at all -
--     a DEFERRED constraint trigger refuses it in any RUNNING, COMPLETING or
--     COMPLETED event (an_elimination_without_a_place_cannot_be_written);
--   * the door no longer refuses to record a bust because the BOUNTY cannot be
--     settled - not for an unnameable pot claimant, not for a PKO watermark
--     that has already advanced, not for a missing head value
--     (a_place_is_not_a_bounty);
--   * the engine no longer declines to ASK in that case either
--     (fix/the-engine-asks-the-door, live at the next :55 cutover);
--   * and the 62 busts those refusals had stranded are recorded, each through
--     the platform's own door, with its finishing place derived the way the
--     engine derives it (the_busts_the_door_can_now_accept_are_recorded).
--
-- Sixty-two heads that nobody could be paid are listed in financial_alerts with
-- their tournament, player, hand, place and value, at severity `warning` so
-- they are a record rather than a board item each. The chips stay in
-- tournaments.bounty_pool for fn_finalize_bounty_pool to resolve as residual -
-- the home an uncollected head always had.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_absent integer;
  v_placeless integer;
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_absent FROM public.fn_ca_absent_tournament_players();
  IF v_absent <> 0 THEN
    RAISE EXCEPTION '% event(s) still hold a player with no chips and no chair; the incident stays open', v_absent;
  END IF;

  SELECT count(*) INTO v_placeless
    FROM public.tournament_players p
    JOIN public.tournaments t ON t.id = p.tournament_id
   WHERE p.status = 'eliminated' AND p.position IS NULL
     AND t.status IN ('RUNNING', 'COMPLETING', 'COMPLETED');
  IF v_placeless <> 0 THEN
    RAISE EXCEPTION '% eliminated player(s) still have no finishing place', v_placeless;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'Busts were being written by two pg_cron sweeps that did not assign a finishing place, and the knockout door - the one writer that does - refused to record a bust whenever the BOUNTY could not be settled: no exact pot claimant, a PKO settlement watermark already advanced past the hand, or no head value. A bounty rule was deciding whether a player got a finishing place, and an unranked player keeps an event from finishing, so ten events sat frozen holding 3,600.00 of prize escrow with the oldest bust 44.7 hours old.',
         correction_ref = 'migration a_place_is_not_a_bounty',
         resolution = 'Fixed at the root, in four places: both cron sweeps are unscheduled and carry the candidate predicate; a DEFERRED constraint trigger makes an eliminated row without a place unwritable; the door now records the elimination and assigns the place in every case and writes no obligation when the head cannot be settled; and the engine no longer declines to ask when it cannot work out who to pay. The 62 stranded busts were then recorded through the platform''s own door, each with the place the engine would have given it, and their unattributable heads are listed in financial_alerts and left in the bounty pool as residual. Asserted here: fn_ca_absent_tournament_players returns ZERO findings and no eliminated player anywhere lacks a finishing place.'
   WHERE i.status <> 'resolved'
     AND i.source = 'fn_ca_conservation_sweep:fn_ca_absent_tournament_players';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RAISE EXCEPTION 'expected to resolve the absent-players incident, resolved %', v_rows;
  END IF;
END
$body$;

COMMIT;
