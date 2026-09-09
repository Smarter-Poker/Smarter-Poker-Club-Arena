DO $mig$
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* AN ESCROW THAT NEVER HEARD ABOUT THE RETURN IS NOT A SHORTFALL.     */
  /*                                                                     */
  /* Reading the escrow as the authority surfaced three more spins -      */
  /* db3e9392, 2cb23112, 018c0bf1 - each showing prize_balance 124.00     */
  /* while spin_reserve_ledger says the full 400.00 draw was already      */
  /* returned. Both are true. The old return path wrote its leg with      */
  /* category 'refund', and fn_ca_escrow_on_reserve_leg only listens for  */
  /* 'spin_entry' and 'spin_prize', so the reserve got its chips back and */
  /* the escrow was never told. (The sweep rewritten in the migration     */
  /* before this one writes the return as spin_entry precisely so that    */
  /* stops happening.)                                                    */
  /*                                                                     */
  /* The reserve ledger cannot be wrong about a return - the pool balance */
  /* moved by it - so it bounds the escrow. What an event still owes the  */
  /* reserve is the smaller of "what the escrow says it holds" and "what  */
  /* was drawn and not yet given back". For a2e30c1f that is             */
  /* LEAST(262.00, 500.00) = 262.00; for the three above it is           */
  /* LEAST(124.00, 0.00) = 0.00, and they leave the board.                */
  /* =================================================================== */
  CREATE OR REPLACE VIEW public.v_spin_unpaid_settlements AS
   WITH draw AS (
     SELECT l.tournament_id, sum(-l.amount) AS prize_drawn, max(l.created_at) AS drawn_at
       FROM spin_reserve_ledger l
      WHERE l.kind = 'jackpot_draw' AND l.tournament_id IS NOT NULL
      GROUP BY l.tournament_id
   ), returned AS (
     SELECT l.tournament_id, sum(l.amount) AS prize_returned
       FROM spin_reserve_ledger l
      WHERE l.kind = 'surplus_return' AND l.tournament_id IS NOT NULL
      GROUP BY l.tournament_id
   ), paid AS (
     SELECT w.related_entity_id AS tournament_id,
            sum(w.amount) FILTER (WHERE w.category = 'prize')  AS prize_credited,
            count(*)      FILTER (WHERE w.category = 'prize')  AS credit_rows,
            sum(w.amount) FILTER (WHERE w.category = 'refund') AS prize_refunded
       FROM wallet_transactions w
      WHERE w.type = 'credit' AND w.category IN ('prize','refund') AND w.related_entity_id IS NOT NULL
      GROUP BY w.related_entity_id
   ), seats AS (
     SELECT tp.tournament_id, count(*) AS seat_count,
            count(*) FILTER (WHERE tp."position" IS NULL) AS unranked_seats,
            count(*) FILTER (WHERE tp.status = 'playing') AS still_playing_seats,
            count(*) FILTER (WHERE tp."position" = 1) AS seats_at_first,
            COALESCE(sum(tp.prize), 0::numeric) AS sum_seat_prize
       FROM tournament_players tp
      GROUP BY tp.tournament_id
   ), judged AS (
     SELECT d.tournament_id,
            d.prize_drawn, d.drawn_at,
            COALESCE(r.prize_returned, 0::numeric) AS prize_returned,
            COALESCE(p.prize_credited, 0::numeric) AS prize_credited,
            COALESCE(p.credit_rows, 0::bigint)     AS credit_rows,
            COALESCE(p.prize_refunded, 0::numeric) AS prize_refunded,
            esc.prize_balance AS escrow_prize_balance,
            CASE
              WHEN esc.prize_balance IS NOT NULL
                THEN round(LEAST(esc.prize_balance,
                                 d.prize_drawn - COALESCE(r.prize_returned, 0::numeric)), 2)
              ELSE round(d.prize_drawn - COALESCE(r.prize_returned, 0::numeric)
                                       - COALESCE(p.prize_credited, 0::numeric)
                                       - COALESCE(p.prize_refunded, 0::numeric), 2)
            END AS chips_short
       FROM draw d
       LEFT JOIN returned r ON r.tournament_id = d.tournament_id
       LEFT JOIN paid p ON p.tournament_id = d.tournament_id
       LEFT JOIN tournament_escrow esc ON esc.tournament_id = d.tournament_id
   )
   SELECT t.id AS tournament_id, t.club_id, t.name, t.status AS tournament_status,
          t.buy_in_amount, t.spin_multiplier, t.started_at, t.ended_at, j.drawn_at,
          j.prize_drawn, j.prize_credited, j.credit_rows, j.chips_short,
          COALESCE(s.seat_count, 0::bigint) AS seat_count,
          COALESCE(s.unranked_seats, 0::bigint) AS unranked_seats,
          COALESCE(s.still_playing_seats, 0::bigint) AS still_playing_seats,
          COALESCE(s.seats_at_first, 0::bigint) AS seats_at_first,
          COALESCE(s.sum_seat_prize, 0::numeric) AS sum_seat_prize,
          CASE
            WHEN j.prize_returned > 0::numeric THEN 'draw_returned'
            WHEN j.prize_credited = 0::numeric AND j.prize_refunded = 0::numeric THEN 'nobody_paid'
            WHEN j.prize_credited < j.prize_drawn THEN 'under_paid'
            ELSE 'over_paid'
          END AS verdict,
          CASE
            WHEN COALESCE(s.unranked_seats, 0::bigint) > 0 THEN 'unranked_survivor'
            WHEN COALESCE(s.seats_at_first, 0::bigint) = 1 THEN 'ranked_but_unpaid'
            ELSE 'other'
          END AS seat_shape,
          j.prize_returned, j.prize_refunded, j.escrow_prize_balance
     FROM judged j
     JOIN tournaments t ON t.id = j.tournament_id AND t.variant = 'spin'
     LEFT JOIN seats s ON s.tournament_id = j.tournament_id
    WHERE j.chips_short <> 0::numeric
      AND ( (t.status = ANY (ARRAY['COMPLETED','CANCELLED','CANCELED'])
             AND COALESCE(t.ended_at, j.drawn_at) < now() - interval '10 minutes')
         OR (j.drawn_at < now() - interval '2 hours'
             AND t.status <> ALL (ARRAY['RUNNING','REGISTERING'])) )
      AND NOT (j.prize_credited > j.prize_drawn
               AND t.spin_multiplier IS NOT NULL
               AND j.prize_credited = round(t.buy_in_amount * t.spin_multiplier, 2));

  IF (SELECT count(*) FROM v_spin_unpaid_settlements
       WHERE tournament_id IN ('db3e9392-d691-4398-adae-822e12d7bfa3',
                               '2cb23112-2018-4bd0-82ef-6e9e50348a45',
                               '018c0bf1-4210-4995-8b27-8b6b7a5f767f')) <> 0 THEN
    RAISE EXCEPTION 'a fully returned draw is still reading as short';
  END IF;
  IF (SELECT chips_short FROM v_spin_unpaid_settlements
       WHERE tournament_id = 'a2e30c1f-6d9f-4e5a-81ba-9639a8298d1a') <> 262.00 THEN
    RAISE EXCEPTION 'the unspent 262.00 draw is no longer visible';
  END IF;
END
$mig$;
