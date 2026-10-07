-- 20261007001000_a_satellite_seat_open_at_the_boundary_is_held_for_its_owner.sql
--
-- WHAT HAPPENED (rows read 2026-10-07 ~00:15 UTC):
--
-- Midway Union's close for 2026-09-28 07:00 -> 2026-10-05 07:00 UTC cannot
-- certify: fn_union_pnl_boundary(Midway, 2026-10-05 07:00) raises
-- open_tournament_original_instrument_or_earning_club_missing for 86
-- registrations in three tournaments open at that boundary (Sunday Funday
-- Six-Card Closer, Wednesday Feature, Sunday $200 Deep Stack).
--
-- Every one of the 86 is a satellite-won seat (source_satellite_id set). A
-- seat is never charged to a wallet, so it never has a
-- tournament_participant_funding_receipts row - and the boundary only knew
-- how to value an open registration from those receipts. Midway's first
-- satellite series began 2026-10-02, so this is the first boundary that met
-- an open satellite seat. No money is missing: each seat's value reached the
-- target's prize liability through exactly one posted ledger row naming the
-- registration (a satellite_seat_pool_transfer from the satellite's prize
-- liability, or a tournament_entry_ticket_admission from escrow for a seat
-- delivered as a ticket), and every affected tournament balances to the chip.
--
-- THE FIX (fn_union_pnl_boundary only): an open registration with no entry
-- receipt is held at its seat value for the seat's owning club when ALL of:
--   * it carries source_satellite_id and no non-chip instrument;
--   * exactly one posted, hashed ledger row before the boundary moved its
--     seat value into this tournament's prize liability and names this
--     registration and player (pool transfer from that same satellite, or a
--     ticket admission whose ticket came from that same satellite);
--   * fn_union_pnl_satellite_seat_owner (the existing rule: the club that
--     funded the player's satellite entry) resolves one club;
--   * nothing was credited back to the player from this tournament before
--     the boundary.
-- Anything else is refused exactly as before. No chip moves.
--
-- PROOF (rehearsed in a rolled-back transaction against production): the
-- 2026-10-05 07:00 Midway boundary goes from blocked (86 issues) to ready
-- (0 issues), holding the 86 seats for their owning clubs, 3,400.00 total.
--
-- Applied by editing the live definition with exact-match replacements; each
-- replacement must match exactly once or the migration aborts.

DO $mig$
DECLARE
 d text;
 o1 text := $o$ nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;$o$;
 n1 text := $n$ nonchips boolean; changed boolean; returned numeric; res_club uuid; res_amount numeric; v_proj boolean;
 seat_rows int; seat_value numeric; seat_club uuid; seat_credits int;$n$;
 o2 text := $o$   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN$o$;
 n2 text := $n$   -- A satellite-won seat (20261007001000) has no entry receipt: it was
   -- never charged to a wallet. It is held at the value its one funding row
   -- moved into this prize liability, for the club that funded the seat.
   IF entries=0 AND NOT nonchips AND s->>'source_satellite_id' IS NOT NULL THEN
    SELECT count(*),sum(l.amount) INTO seat_rows,seat_value FROM public.chip_ledger l
     WHERE l.status='posted' AND l.row_hash IS NOT NULL AND l.created_at<p_at
      AND l.to_type='prize_liability' AND l.to_entity_id=(t->>'id')::uuid
      AND l.metadata->>'registration_id'=s->>'id' AND l.metadata->>'user_id'=s->>'user_id'
      AND ((l.category='tournament_buyin' AND l.from_type='prize_liability' AND l.from_entity_id=(s->>'source_satellite_id')::uuid
        AND l.metadata->>'kind'='satellite_seat_pool_transfer')
       OR (l.category='ticket_redeem' AND l.from_type='escrow' AND l.metadata->>'kind'='tournament_entry_ticket_admission'
        AND l.metadata->>'source_satellite_id'=s->>'source_satellite_id'));
    seat_club:=public.fn_union_pnl_satellite_seat_owner((s->>'id')::uuid,(t->>'id')::uuid);
    SELECT (SELECT count(*) FROM public.tournament_accounting_credit_receipts c
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
      WHERE c.tournament_id=(t->>'id')::uuid AND c.user_id::text=s->>'user_id' AND b.observed_at<p_at)
     +(SELECT count(*) FROM public.tournament_refund_tranches r2
      JOIN public.union_pnl_transaction_frames b ON b.transaction_id=r2.transaction_id
      WHERE r2.tournament_id=(t->>'id')::uuid AND r2.user_id::text=s->>'user_id' AND b.observed_at<p_at)
     INTO seat_credits;
    IF seat_rows=1 AND seat_value>0 AND seat_club IS NOT NULL AND seat_credits=0 THEN
     holdings:=holdings||jsonb_build_array(jsonb_build_object('club_id',seat_club,'user_id',s->'user_id','amount',seat_value,
      'kind','deferred_tournament_result','source_id',s->'id','basis','satellite_seat'));
     CONTINUE;
    END IF;
   END IF;
   IF entries=0 OR owners<>1 OR owned IS NULL OR nonchips THEN$n$;
 pairs text[][];
 i int;
BEGIN
 d := pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamptz)'::regprocedure);
 pairs := ARRAY[[o1,n1],[o2,n2]];
 FOR i IN 1..array_length(pairs,1) LOOP
  IF (length(d)-length(replace(d,pairs[i][1],'')))/length(pairs[i][1]) <> 1 THEN
   RAISE EXCEPTION 'boundary edit % does not match exactly once', i;
  END IF;
  d := replace(d,pairs[i][1],pairs[i][2]);
 END LOOP;
 EXECUTE d;
END
$mig$;