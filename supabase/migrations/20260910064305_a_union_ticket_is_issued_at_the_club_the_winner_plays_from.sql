-- a_union_ticket_is_issued_at_the_club_the_winner_plays_from
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, drift board incidents af21bb58,
-- 8f3805ba, 3c55bd7b, 31dab48a, 6c2130b5):
--
-- 1. THREE SATELLITE FINISHES REFUSED: "ticket place 1 has no exact target
--    club" (c327bb92, 34434fe4, d25904af - all union-hosted, target
--    0f0d8ce1 / c6e849c1, winners are members of a0000000 / a41434bb).
--    When a winner is at the four-table cap the settlement gate
--    (fn_settle_satellite_tournament_pre_money_path_gate) delivers the funded
--    entry as a target-scoped ticket, and demanded that the ticket's club be
--    EXACTLY the target's club. For a union-hosted target that is the union's
--    house club, and fn_tournament_club_for_user rightly resolves a member to
--    the club whose wallet they play from - so every capped winner of a union
--    satellite was refused. Redemption (fn_ca_register_for_tournament_with_
--    ticket_for) already accepts a ticket at any member club of the target's
--    union; issuance was stricter than redemption for no reason. All three
--    events settled on a later retry once a game freed up (seat delivered,
--    remainder paid, escrow 0.00, verified below), so nothing is owed; the
--    refusal is what is fixed.
--
-- 2. THE SATELLITE AUDIT DOUBLE-COUNTED A CASH DELIVERY (db2110a2, 93a959cd:
--    "seats 1/1, cash 38, excess 30"). fn_satellite_conservation_audit
--    counted every tournament_payouts row with source satellite_ticket as a
--    funded seat, but a place-1 award delivered as CASH writes that same
--    payout row AND the wallet credit, so 30.00 was counted twice. The
--    payout branch now counts only awards whose tournament_satellite_awards
--    row says seat or ticket. The audit must return no rows afterwards.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text; v_n integer; v_rows integer;
  v_gate_anchor text := E'      v_ticket_club_id := public.fn_tournament_club_for_user(\n'
                     || E'        v_finisher.user_id, v_target_id,\n'
                     || E'        COALESCE(v_target.club_id, v_source.club_id));\n'
                     || E'      IF v_ticket_club_id IS NULL\n'
                     || E'         OR (v_target.club_id IS NOT NULL\n'
                     || E'             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id) THEN';
  v_gate_new    text := E'      v_ticket_club_id := public.fn_tournament_club_for_user(\n'
                     || E'        v_finisher.user_id, v_target_id,\n'
                     || E'        COALESCE(v_target.club_id, v_source.club_id));\n'
                     || E'      -- A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM\n'
                     || E'      -- (2026-09-10): a union-hosted target accepts a ticket at any member\n'
                     || E'      -- club of its union, exactly as redemption already does. Demanding the\n'
                     || E'      -- house club refused every capped winner of a union satellite.\n'
                     || E'      IF v_ticket_club_id IS NULL\n'
                     || E'         OR (v_target.club_id IS NOT NULL\n'
                     || E'             AND v_ticket_club_id IS DISTINCT FROM v_target.club_id\n'
                     || E'             AND NOT EXISTS (\n'
                     || E'               SELECT 1 FROM public.tournaments tt\n'
                     || E'               JOIN public.union_clubs uc ON uc.union_id = tt.union_id\n'
                     || E'              WHERE tt.id = v_target_id AND uc.club_id = v_ticket_club_id)) THEN';
  v_audit_anchor text := E'  SELECT p.tournament_id, p.user_id\n'
                      || E'    FROM tournament_payouts p\n'
                      || E'   WHERE p.tournament_id IN (SELECT id FROM sats)\n'
                      || E'     AND p.source IN (''satellite_seat'', ''satellite_ticket'')\n),';
  v_audit_new    text := E'  -- A CASH DELIVERY IS NOT A SEAT (2026-09-10): a capped winner paid in\n'
                      || E'  -- cash writes the same satellite_ticket payout row as a held ticket; the\n'
                      || E'  -- award row says which it was, and only seat/ticket is a funded seat.\n'
                      || E'  SELECT p.tournament_id, p.user_id\n'
                      || E'    FROM tournament_payouts p\n'
                      || E'    JOIN tournament_satellite_awards a\n'
                      || E'      ON a.tournament_id = p.tournament_id AND a.place = p.position\n'
                      || E'     AND a.delivery_kind IN (''seat'', ''ticket'')\n'
                      || E'   WHERE p.tournament_id IN (SELECT id FROM sats)\n'
                      || E'     AND p.source IN (''satellite_seat'', ''satellite_ticket'')\n),';
BEGIN
  -- 1. the gate
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_settle_satellite_tournament_pre_money_path_gate';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_settle_satellite_tournament_pre_money_path_gate is missing'; END IF;
  IF position('A UNION TICKET IS ISSUED AT THE CLUB THE WINNER PLAYS FROM' IN v_def) > 0 THEN
    RAISE NOTICE 'gate already union-aware';
  ELSE
    v_n := (length(v_def) - length(replace(v_def, v_gate_anchor, ''))) / length(v_gate_anchor);
    IF v_n <> 1 THEN RAISE EXCEPTION 'gate anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_gate_anchor, v_gate_new);
  END IF;

  -- 2. the audit
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_satellite_conservation_audit';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_satellite_conservation_audit is missing'; END IF;
  IF position('A CASH DELIVERY IS NOT A SEAT' IN v_def) > 0 THEN
    RAISE NOTICE 'audit already counts awards';
  ELSE
    v_n := (length(v_def) - length(replace(v_def, v_audit_anchor, ''))) / length(v_audit_anchor);
    IF v_n <> 1 THEN RAISE EXCEPTION 'audit anchor appears % times, expected 1', v_n; END IF;
    EXECUTE replace(v_def, v_audit_anchor, v_audit_new);
  END IF;

  -- post-conditions
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'fn_settle_satellite_tournament_pre_money_path_gate';
  IF position('JOIN public.union_clubs uc ON uc.union_id = tt.union_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-condition: the gate does not accept a union member club';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p WHERE p.proname = 'fn_satellite_conservation_audit';
  IF position('a.delivery_kind IN (''seat'', ''ticket'')' IN v_def) = 0 THEN
    RAISE EXCEPTION 'post-condition: the audit still counts a cash payout as a seat';
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_satellite_conservation_audit(24);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'post-condition: the satellite audit still reports % finding(s) over 24h', v_n;
  END IF;

  -- The three refused events are read as settled before their incidents close.
  SELECT count(*) INTO v_n FROM public.tournaments t
   WHERE t.id IN ('c327bb92-2eae-4819-bc49-c298eb42bb0c','34434fe4-df38-465c-944d-d974f96848c4','d25904af-ceb9-42ce-80ce-d0d91ad5989b')
     AND t.status = 'COMPLETED'
     AND EXISTS (SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id = t.id AND e.closed_at IS NOT NULL
                   AND abs(e.prize_balance) < 0.005 AND abs(e.fee_balance) < 0.005)
     AND EXISTS (SELECT 1 FROM public.tournament_satellite_awards a WHERE a.tournament_id = t.id AND a.place = 1 AND a.delivery_kind = 'seat')
     AND EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id = t.id AND o.kind = 'satellite_remainder' AND o.settled_at IS NOT NULL AND o.amount_paid = o.amount_owed);
  IF v_n <> 3 THEN RAISE EXCEPTION 'expected the three refused satellites to be settled, found %', v_n; END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_settle_satellite_tournament_pre_money_path_gate refused a capped winner''s ticket because the resolved club (the member club the winner plays from) was not the union house club the target is hosted by; redemption already accepted any member club of the union. Fixed in migration a_union_ticket_is_issued_at_the_club_the_winner_plays_from.',
         correction_ref = 'migration a_union_ticket_is_issued_at_the_club_the_winner_plays_from',
         resolution = 'No money owed: each event settled on the platform''s own retry once the winner had a free game (seat delivered to the target, remainder paid, escrow closed at 0.00). The refusal path is fixed so a capped winner of a union satellite is issued a ticket at their member club.'
   WHERE i.status = 'open'
     AND i.source = 'financial_alerts:Tournament.atomic_satellite_finish_refused'
     AND i.tournament_id IN ('c327bb92-2eae-4819-bc49-c298eb42bb0c','34434fe4-df38-465c-944d-d974f96848c4','d25904af-ceb9-42ce-80ce-d0d91ad5989b');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 3 THEN RAISE EXCEPTION 'expected to resolve 3 refusal incidents, resolved %', v_rows; END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'fn_satellite_conservation_audit counted a satellite_ticket payout as a funded seat even when the award was delivered as cash, so a capped winner paid 30.00 in cash read as 30.00 seat + 30.00 cash (excess 30). The payout branch now counts only awards whose delivery_kind is seat or ticket. Fixed in migration a_union_ticket_is_issued_at_the_club_the_winner_plays_from.',
         correction_ref = 'migration a_union_ticket_is_issued_at_the_club_the_winner_plays_from',
         resolution = 'Detector defect, no chips moved wrongly: db2110a2 and 93a959cd each paid exactly their 38.00 pool (30.00 cash place 1 under the four-table cap, 8.00 place 2) with escrow closed at 0.00. The audit returns no findings after the fix, asserted in the migration.'
   WHERE i.status = 'open'
     AND (i.source = 'financial_alerts:FeeReconciler.satellite_conservation'
          OR i.source = 'fn_ca_conservation_sweep:fn_satellite_conservation_audit');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 2 THEN RAISE EXCEPTION 'expected to resolve 2 audit incidents, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
