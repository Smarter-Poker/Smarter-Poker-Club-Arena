DO $mig$
DECLARE v_src text; v_new text; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* EVERY REGISTRANT IS DEALT IN, SO EVERY REGISTRANT COUNTS.           */
  /*                                                                     */
  /* I narrowed this check an hour ago to count only players who appear   */
  /* in table_seats, on the reasoning that a no-show is never dealt a     */
  /* stack. That reasoning was wrong, and the data says so plainly:       */
  /*                                                                     */
  /*   Morning Free Buy (NLH), RUNNING                                    */
  /*     200 registrants, 192 eliminated, 8 still seated                  */
  /*     ever appearing in table_seats: 115                               */
  /*     200 x 3,000 + 10 x 3,000 + 200 x 10,000 = 2,630,000              */
  /*     chips on open seats                      = 2,630,000  exact      */
  /*                                                                     */
  /* Seats are recycled - a seat row's user_id is overwritten as players  */
  /* bust and tables consolidate - so "ever appeared in table_seats" is   */
  /* not a record of who was dealt in; it is a record of which chairs     */
  /* still remember their last occupant. Counting it turned an event that */
  /* balances to the chip into a 255,000 chip finding.                    */
  /*                                                                     */
  /* Reverted. The registrant count is the right denominator, and the     */
  /* events that genuinely do not balance stay on the board where a       */
  /* person can look at them.                                             */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_tournament_chip_conservation_check';
  IF position($old$           /* SEATED, NOT MERELY REGISTERED (2026-09-09). A no-show was
              never dealt a stack, so counting them multiplies the expected
              chips by people who are not at the table. */$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the seated-only narrowing is not present - nothing to revert';
  END IF;
  v_new := replace(v_src,
$old$           /* SEATED, NOT MERELY REGISTERED (2026-09-09). A no-show was
              never dealt a stack, so counting them multiplies the expected
              chips by people who are not at the table. */
           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id
               AND EXISTS (SELECT 1 FROM table_seats ts2
                             JOIN tables tb2 ON tb2.id = ts2.table_id
                            WHERE tb2.tournament_id = t.id
                              AND ts2.user_id = tp.user_id)) AS players,$old$,
$old$           /* EVERY REGISTRANT IS DEALT IN (2026-09-09). Narrowing this to
              players found in table_seats was wrong: seats are recycled as
              players bust and tables consolidate, so that set is who last
              sat in each chair, not who was dealt in. Morning Free Buy has
              200 registrants and 115 such rows, and balances to the chip
              against 200. */
           (SELECT count(*) FROM tournament_players tp
             WHERE tp.tournament_id = t.id) AS players,$old$);
  EXECUTE v_new;

  SELECT count(*) INTO v_n FROM public.fn_tournament_chip_conservation_check(0.01)
   WHERE tournament_id = 'a9be040d-0cd4-4d71-9056-a48cfc85ce58';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'Morning Free Buy still reads as drifting after the revert';
  END IF;
END
$mig$;
