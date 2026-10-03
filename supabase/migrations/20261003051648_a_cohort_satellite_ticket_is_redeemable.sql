-- 20261003051648_a_cohort_satellite_ticket_is_redeemable
--
-- A SATELLITE WINNER'S ENTRY TICKET FROM A COHORT SETTLEMENT CAN BE SPENT.
--
-- What was wrong. A satellite winner who is at the four-table cap when the
-- satellite settles gets a target-scoped, noncash "tournament entry only"
-- ticket instead of a seat (fn_ca_settle_satellite_cohort, the 'ticket'
-- delivery branch). The only door that spends that ticket,
-- fn_ca_register_for_tournament_with_ticket_for, and its read-only selector,
-- fn_ca_find_tournament_entry_ticket_for, re-prove the ticket's issue
-- evidence before admitting it. That proof was written on 2026-09-09 against
-- the single-winner v2 receipt, which books the award's slot as
--   tournament_payouts.position = award place   and
--   chip_ledger.metadata->>'position' = award place.
-- The v3 multi-qualifier cohort receipt (2026-09-17) books the same slot as
-- chip_ledger.metadata->>'award_slot' and leaves tournament_payouts.position
-- NULL (every qualifier is still alive when the cohort is paid, so nobody has
-- a finishing position). Both clauses are false for every v3 ticket, the
-- selector answers 'matching_tournament_ticket_unavailable', and the horse
-- ticket rail (prestart and late-registration discovery) never admits the
-- holder. The won seat then dies with its target.
--
-- Measured 2026-10-03 05:15 UTC, tournament_tickets joined to their award,
-- payout, issue ledger row and settlement receipt:
--   receipt v3 tickets ever redeemed ............... 0
--   receipt v2 tickets redeemed ..................... 144
--   v3 tickets issued, target still REGISTERING ..... 60  (5,250.00)
--   v3 tickets issued, target RUNNING ............... 11  (330.00)
--   v3 tickets issued, target COMPLETED ............. 322 (15,050.00)
-- Satellite 00efaa48 "Sunday Funday Main Event Satellite" (settled
-- 2026-10-02 21:30:44, financial alert 79cdb720) is one of them: all eight
-- qualifiers were paid in that commit (three seats into 57b8642a, one cash
-- award to a qualifier already seated by satellite 91ba0ccb, four v3 entry
-- tickets f8fc59b6 / 1041df45 / da37ec2d / c9651d52). The engine saw a
-- supabase_timeout on the reply and raised "outcome unknown"; nothing was
-- lost, but the four tickets could never be spent. A query evaluating the
-- selector clause by clause on ticket f8fc59b6 returned every clause true
-- except exactly these two.
--
-- What this changes. Only the two slot clauses, in both functions:
--   chip_ledger.metadata->>'position' = place
--     -> COALESCE(metadata->>'position', metadata->>'award_slot') = place
--   tournament_payouts.position = place
--     -> position = place OR the settlement receipt is v3 (whose slot is
--        then bound by the award_slot clause above, the award row's own
--        place, the ticket's source_satellite_award_place and the
--        chip_transactions issue row's source_award_place).
-- Every other proof (award, payout identity/amount/key, issue ledger leg,
-- issue chip_transaction, receipt cost/buy-in/fee, no wallet credit) is
-- unchanged. No money moves here: the existing prestart/late discovery
-- admits the holders through the unchanged atomic ticket door.
--
-- The functions are redefined from their own live definitions with exact,
-- counted substitutions, so this cannot regress anything else that changed
-- in them since 2026-09-09. Each substitution must match exactly once or the
-- whole migration aborts.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $cohort_ticket$
DECLARE
  v_fn regprocedure;
  v_def text;
  v_next text;
  v_old_ledger text := $q$issue_l.metadata->>'position'=source_a.place::text$q$;
  v_new_ledger text := $q$COALESCE(issue_l.metadata->>'position',issue_l.metadata->>'award_slot')=source_a.place::text$q$;
  v_old_payout text := $q$source_p."position"=source_a.place$q$;
  v_new_payout text := $q$(source_p."position"=source_a.place OR source_h.receipt_version>=3)$q$;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.fn_ca_find_tournament_entry_ticket_for(uuid,uuid)'::regprocedure,
    'public.fn_ca_register_for_tournament_with_ticket_for(uuid,uuid,uuid)'::regprocedure]
  LOOP
    v_def := pg_get_functiondef(v_fn);
    IF (length(v_def) - length(replace(v_def, v_old_ledger, ''))) / length(v_old_ledger) <> 1
       OR (length(v_def) - length(replace(v_def, v_old_payout, ''))) / length(v_old_payout) <> 1
       OR position(v_new_ledger IN v_def) > 0 THEN
      RAISE EXCEPTION '% does not carry exactly one v2-only slot proof of each kind', v_fn
        USING ERRCODE = 'P0404';
    END IF;
    v_next := replace(replace(v_def, v_old_ledger, v_new_ledger), v_old_payout, v_new_payout);
    EXECUTE v_next;
  END LOOP;
END
$cohort_ticket$;

-- The settled case this was found on: the selector now names the exact
-- ticket. Only asserted where that ticket exists and is still unspent, so a
-- fresh database replaying history is not held to production rows.
DO $cohort_ticket_proof$
DECLARE
  v_ticket uuid := 'f8fc59b6-72ec-4285-be59-2c1172d47366';
  v_found jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tournament_tickets
              WHERE id = v_ticket AND status = 'issued') THEN
    v_found := public.fn_ca_find_tournament_entry_ticket_for(
      '57b8642a-a398-4bd7-a878-17c1043b7171',
      '3c6a16c3-9251-40da-a03b-4ca28afeb750');
    IF (v_found->>'ticket_id') IS DISTINCT FROM v_ticket::text THEN
      RAISE EXCEPTION 'cohort ticket % is still not selectable: %', v_ticket, v_found
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
END
$cohort_ticket_proof$;

COMMIT;
