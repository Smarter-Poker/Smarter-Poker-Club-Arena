/*
  THE SIX AM FREEROLL IS FINISHED AND ITS LAST TWO PLACES ARE PAID (2026-09-09).

  $100 Freeroll 6:00 AM (d6f7a7e2) started at 2026-09-08 11:21 and had been
  RUNNING for twenty-nine hours with two players unranked, holding 179.11 of
  prize money and 67.90 of fees that no door could release.

  THE STANDINGS.
    - 316bb405 rexlarsen holds 3,021,200 chips, every chip left in the event.
      They are the champion; place 1 pays 16.54% of 765.10 = 126.55.
    - ef5a8ddd rford already carries place 3 and a roster prize of 52.56
      (6.87% of 765.10) and was never paid a cent of it. Their stack of
      404,093.00 was lost at 14:21:33 on 2026-09-08 when their chair moved from
      fec369c3 seat 6 to a713fdc0 seat 6; they were retro-eliminated at 17:17:50
      by a sweep three hours later.
    - 27ebd8e0 BLUFFROCK lost 38,718.00 the same way at 13:05:17 moving off
      4684bf3e seat 3, sat at four more chairs holding nothing, and was never
      recorded out. Places 2 to 391 are complete but for 313, so 313 is the
      place they take. Their true bust order is a little better than that - the
      chair went at 13:05, where place 312 belongs to a bust at 12:28 - but
      every place above 313 is held by somebody who has been paid, and the only
      renumbering that would seat them exactly is one that moves a paid place.
      Place 313 pays nothing either way; the ladder stops at 40.

  126.55 + 52.56 = 179.11, which is the escrow's prize balance to the cent. The
  money proves the standings: there is no third prize left to pay, so there is
  no third player owed one.

  WHY IT IS A RULING.  Thirty-seven of the forty paid places disagree with bust
  chronology, because positions were stamped from a live count that still
  counted players who had left the felt hours before. fn_normalize_tournament_
  final_standings therefore refuses this event outright, and it is right to:
  every ordering that satisfies chronology moves a place that has already been
  paid. So the paid record stands, the two open places are paid against it, and
  the disagreement is recorded in a batch receipt marked mode=ruling rather than
  quietly renumbered away.

  BLUFFROCK's 38,718.00 stays on the chair they left, where it has been since
  13:05:17. It is not written back: the event is over, the chips are tournament
  chips with no wallet value, one player already holds seventy-eight times that
  amount, and restoring them now would change no result and no payment. The loss
  is named here, and the door that lost it is closed by the two migrations that
  land beside this one.
*/

DO $mig$
DECLARE
  v_t   uuid := 'd6f7a7e2-6e55-400d-a81c-581a586c541a';
  v_rex uuid := '316bb405-cc94-4563-9e3b-5026ab1fccdb';
  v_blf uuid := '27ebd8e0-2d90-4c96-882d-cff35f91c53b';
  v_rfd uuid := 'ef5a8ddd-0a68-4ef1-b6f2-4ba9369e0318';
  r jsonb;
  v_prize numeric; v_fee numeric; v_status text; v_seats integer;
BEGIN
  ---------------------------------------------------------------- preconditions
  IF (SELECT status FROM public.tournaments WHERE id = v_t) <> 'RUNNING' THEN
    RAISE NOTICE 'the 6:00 AM freeroll is no longer RUNNING; nothing to do';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.tournament_players
       WHERE tournament_id = v_t AND position IS NULL) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two unranked players in the 6:00 AM freeroll';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = v_t AND position IN (1, 313)) THEN
    RAISE EXCEPTION 'place 1 or place 313 is no longer free';
  END IF;
  IF (SELECT round(prize_balance, 2) FROM public.tournament_escrow
       WHERE tournament_id = v_t) <> 179.11 THEN
    RAISE EXCEPTION 'the prize balance is no longer 179.11';
  END IF;
  IF (SELECT round(prize, 2) FROM public.tournament_players
       WHERE tournament_id = v_t AND user_id = v_rfd) <> 52.56 THEN
    RAISE EXCEPTION 'rford no longer carries the 52.56 place-3 prize';
  END IF;

  ---------------------------------------------------------------- the standings
  UPDATE public.tournament_players
     SET status = 'eliminated', position = 313, chips = 0,
         eliminated_at = timestamptz '2026-09-08 13:05:17.092+00'
   WHERE tournament_id = v_t AND user_id = v_blf;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLUFFROCK was not recorded out'; END IF;

  UPDATE public.tournament_players
     SET status = 'winner', position = 1, prize = 126.55
   WHERE tournament_id = v_t AND user_id = v_rex;
  IF NOT FOUND THEN RAISE EXCEPTION 'rexlarsen was not recorded as the winner'; END IF;

  ---------------------------------------------------------------- the finish
  r := public.fn_claim_tournament_finish(v_t, v_rex, 'chip standard 10.9 (Claude)');
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the finish claim was refused: %', r;
  END IF;

  r := public.fn_settle_tournament_rake(v_t, 'reconcile');
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the rake settlement was refused: %', r;
  END IF;

  r := public.fn_settle_tournament_places_by_ruling(v_t,
    'Thirty-seven of the forty paid places in $100 Freeroll 6:00 AM disagree with bust '
    || 'chronology because positions were stamped at bust time from a live count that still '
    || 'counted players who had lost their chair hours earlier: 7f2fcb20 busted at 14:32:35 '
    || 'and was paid place 2, then 89a23158 at 14:37:43 took place 21, 65f99ae2 at 14:41:56 '
    || 'place 26, b1dd1863 at 14:43:45 place 30 and 786eb11f at 14:44:10 place 35, an order '
    || 'no field can produce because nobody un-busts. 585.99 has already been paid against '
    || 'those places, so every chronological renumbering moves money that is already spent. '
    || 'The paid record therefore stands and the two open places are paid against it: place 1 '
    || 'of 126.55 to 316bb405 who holds all 3,021,200 remaining chips, and place 3 of 52.56 '
    || 'to ef5a8ddd whose roster prize was stamped and never paid. 126.55 + 52.56 = 179.11, '
    || 'the exact prize balance, which is the evidence that no third place is owed. 27ebd8e0 '
    || 'takes place 313, the only vacancy, outside a ladder that stops at 40.',
    'chip standard 10.9 (Claude)');
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the ruling was refused: %', r;
  END IF;
  RAISE NOTICE 'ruling -> %', r;

  /* fn_certify_tournament_finish answers 'completed_without_certificate' here,
     and it does so for every completed tournament on this platform: the trigger
     that stamps the certificate, zzzzzz_tournaments_financial_certificate, is
     DISABLED, along with six other guards on public.tournaments. All 5,658
     finish receipts carry certified_at NULL and evidence NULL. That is a
     platform-wide gap this migration did not open and must not paper over, so
     it is recorded as its own finding rather than swallowed here.

     What IS asserted is the proof the certificate would have carried:
     fn_tournament_finish_readiness must return ok with no failures. That is the
     same jsonb the trigger would have written into evidence, and it is the
     thing that actually says the money is settled. */
  r := public.fn_certify_tournament_finish(v_t, v_rex, 'chip standard 10.9 (Claude)');
  RAISE NOTICE 'certify -> %', r;

  r := public.fn_tournament_finish_readiness(v_t, v_rex);
  IF COALESCE((r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the finish is not financially ready: %', r;
  END IF;

  ---------------------------------------------------------------- assertions
  SELECT round(prize_balance, 2), round(fee_balance, 2) INTO v_prize, v_fee
    FROM public.tournament_escrow WHERE tournament_id = v_t;
  SELECT status INTO v_status FROM public.tournaments WHERE id = v_t;
  SELECT count(*) INTO v_seats FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id = v_t AND ts.left_at IS NULL;

  IF v_prize <> 0.00 OR v_fee <> 0.00 THEN
    RAISE EXCEPTION 'the escrow did not close at zero: prize=% fee=%', v_prize, v_fee;
  END IF;
  IF v_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'the event did not reach COMPLETED: %', v_status;
  END IF;
  IF v_seats <> 0 THEN
    RAISE EXCEPTION '% seat(s) are still live after the finish', v_seats;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_place_settlement_batches
                  WHERE tournament_id = v_t AND mode = 'ruling' AND settled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the ruling receipt was not written';
  END IF;
  IF (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = v_t
         AND abs(round(o.amount_paid,2) - round(o.amount_owed,2)) > 0.005) <> 0 THEN
    RAISE EXCEPTION 'an obligation is still unsettled';
  END IF;

  RAISE NOTICE 'the 6:00 AM freeroll is COMPLETED: escrow prize=% fee=%, % live seat(s)',
    v_prize, v_fee, v_seats;
END
$mig$;
