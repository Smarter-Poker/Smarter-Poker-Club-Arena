-- 20261006154000_an_escrow_refund_and_a_cutover_entry_refund_are_proven_returns.sql
--
-- WHAT HAPPENED (rows read 2026-10-06 ~15:30 UTC):
--
-- Midway Union's close for 2026-09-28 07:00 -> 2026-10-05 07:00 UTC cannot
-- certify its P&L basis: fn_union_pnl_evidence_report raises
-- original_money_flow_basis_incomplete (count 9), because
-- fn_union_pnl_original_flow_evidence files nine posted wallet credits as
-- 'unsupported'. Two shapes, each fully proven by rows that already exist:
--
-- (1) Six cancellation refunds (2 x 150.00, 4 x 15.00, SHARK CLUB a41434bb)
--     of the cancelled satellites 097e3601 / 92c93927 / a4262ba0, written by
--     atomic_cancel_tournament on 2026-10-02 02:16:54. Each entry was charged
--     2026-09-08, before entry capture, so there is no credit receipt and the
--     refund entitlement is a cutover 'wallet_charge' (not 'satellite_seat').
--     Each entitlement names its source_ledger_id, which is exactly the entry
--     ledger already proven in union_pnl_opening_registration_resolutions at
--     boundary 2026-09-28 07:00 (same tournament, player, owning club, one
--     entry of exactly the refunded gross, nothing returned at the boundary).
--
-- (2) Three returned pending add-ons (1.00, 21.96, 74.10), category
--     player_funding from table_stack. Each has exactly one
--     cash_funding_application_receipts refund of that amount in the same
--     transaction, from this player's own add-on funding receipt on this
--     table and club - the proof the validity check already demands. They
--     were never classified, because the add-on's occupancy has no 'buyin'
--     receipt (it arrived by horse funding / a table move), so ret.owners=0.
--
-- THE FIX (fn_union_pnl_original_flow_evidence only; nothing else changes):
--   * te: a 'wallet_charge' refund entitlement is a tournament return when its
--     source ledger is the proven opening entry of that registration at the
--     opening boundary of the week the refund was recognized in.
--     'satellite_seat' keeps its existing proof.
--   * a cash credit with exactly one proven escrow refund (refunds=1) is a
--     cash_return owned by that refund's club and player when no buy-in owner
--     or table move owns it. Its validity still requires category
--     player_funding and refund club/player = owner, as before.
--
-- Rows already classified are unchanged (each edit only reaches rows that
-- were 'unsupported', which are invalid by definition, so no certified week
-- can move). No chip moves in this migration.
--
-- PROOF (rehearsed in rolled-back transactions against production, 15:35-15:45
-- UTC): the whole week, all 421,583 Midway flows, was compared before/after in
-- three slices. Exactly these 9 rows changed (unsupported -> 6
-- tournament_return + 3 cash_return, each owned by the refunded player and
-- club, all valid); every other row is identical; invalid rows 9 -> 0.
--
-- Applied by editing the live definition with exact-match replacements; each
-- replacement must match exactly once or the migration aborts.

DO $mig$
DECLARE
 d text;
 o1 text := $o$    AND t.entitlement_kind='satellite_seat' AND t.gross=(q.l->>'amount')::numeric$o$;
 n1 text := $n$    AND t.entitlement_kind IN('satellite_seat','wallet_charge') AND t.gross=(q.l->>'amount')::numeric$n$;
 o2 text := $o$    AND public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id$o$;
 n2 text := $n$    AND CASE t.entitlement_kind
     WHEN 'satellite_seat' THEN public.fn_union_pnl_satellite_seat_owner(t.registration_id,NULL)=t.refund_wallet_club_id
     -- A pre-capture wallet entry refunded by cancellation (20261006154000):
     -- its entitlement's source ledger is the entry proven at the opening
     -- boundary of the refund's own week, for this exact registration, club
     -- and gross.
     WHEN 'wallet_charge' THEN t.source_ledger_id IS NOT NULL AND (SELECT count(*) FROM public.union_pnl_opening_registration_resolutions r
       WHERE r.boundary=public.fn_union_week_start(q.recognized_at) AND r.union_id=p_union_id AND r.tournament_id=t.tournament_id AND r.user_id=t.user_id
        AND r.owning_club_id=t.refund_wallet_club_id AND r.entries=1 AND r.entry_amount=t.gross AND r.returned=0
        AND r.proof_md5=md5(r.proof::text)
        AND r.proof->'entry_ledger' @> jsonb_build_array(jsonb_build_object('ledger_id',t.source_ledger_id::text)))=1
     ELSE false END$n$;
 o3 text := $o$WHEN owners=1 OR moved_club IS NOT NULL THEN 'cash_return'$o$;
 n3 text := $n$WHEN owners=1 OR moved_club IS NOT NULL OR refunds=1 THEN 'cash_return'$n$;
 o4 text := $o$COALESCE(cash_club,CASE WHEN moved_club IS NULL THEN return_club ELSE moved_club END,entry_club,credit_club,refund_ent_club) owner_club$o$;
 n4 text := $n$COALESCE(cash_club,CASE WHEN moved_club IS NOT NULL THEN moved_club WHEN owners=1 THEN return_club ELSE refund_club END,entry_club,credit_club,refund_ent_club) owner_club$n$;
 o5 text := $o$COALESCE(cash_user,CASE WHEN moved_club IS NULL THEN return_user ELSE moved_user END,entry_user,credit_user,refund_ent_user) owner_user$o$;
 n5 text := $n$COALESCE(cash_user,CASE WHEN moved_club IS NOT NULL THEN moved_user WHEN owners=1 THEN return_user ELSE refund_user END,entry_user,credit_user,refund_ent_user) owner_user$n$;
 o6 text := $o$WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL) AND l->>'from_type'='table_stack'$o$;
 n6 text := $n$WHEN 'cash_return' THEN (owners=1 OR moved_club IS NOT NULL OR (refunds=1 AND l->>'category'='player_funding')) AND l->>'from_type'='table_stack'$n$;
 pairs text[][] ;
 i int;
BEGIN
 d := pg_get_functiondef('public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz)'::regprocedure);
 pairs := ARRAY[[o1,n1],[o2,n2],[o3,n3],[o4,n4],[o5,n5],[o6,n6]];
 FOR i IN 1..array_length(pairs,1) LOOP
  IF (length(d)-length(replace(d,pairs[i][1],'')))/length(pairs[i][1]) <> 1 THEN
   RAISE EXCEPTION 'flow evidence edit % does not match exactly once', i;
  END IF;
  d := replace(d,pairs[i][1],pairs[i][2]);
 END LOOP;
 EXECUTE d;
END
$mig$;
