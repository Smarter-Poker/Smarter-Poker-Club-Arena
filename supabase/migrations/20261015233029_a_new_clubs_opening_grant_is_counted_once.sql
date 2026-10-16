-- @live-proof: (SELECT severity = 'ok' AND opening = 0 FROM public.fn_ca_treasury_positions() WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d') AND position('ca_treasury_opening_is_what_the_ledger_lacks' IN pg_get_functiondef('public.fn_ca_club_gets_a_baseline()'::regprocedure)) > 0 AND position('_retired' IN pg_get_functiondef('public.fn_charge_place_overpays(integer)'::regprocedure)) > 0
-- 20261015233029_a_new_clubs_opening_grant_is_counted_once.sql
--
-- PHASE 1, "no silent money failures". Two changes, no chip moves.
--
-- 1. A NEW CLUB'S OPENING GRANT IS COUNTED ONCE.
--
--    fn_ca_treasury_positions() read critical for e14bc9f7 (Lightning
--    Internal Pilot): ledger 184,830.64 against stored 84,830.64, a gap of
--    exactly 100,000.00. Nothing moved without its leg (the ledger invariant
--    was in refuse mode throughout). The check counted one leg twice.
--
--    Read from rows: the club was inserted 2026-10-12 05:09:48.147954.
--    fn_seed_new_club_opening_bank (BEFORE INSERT) gives every new club its
--    100,000 opening bank; trg_ca_autoledger (AFTER INSERT) journals it as
--    chip_ledger 59a04fd3 (issuance_reserve -> club_treasury, 100,000.00,
--    key club-opening-grant:<club>, created_at = the insert). Then
--    trg_ca_club_gets_a_baseline (AFTER INSERT, 20260908125658) wrote the
--    club's ca_treasury_baseline row with opening_balance = NEW.chip_treasury
--    = 100,000.00, ledger_at_baseline 0, at the same instant. Every reader
--    (fn_ca_treasury_positions, reconcile_ledger_nightly through it,
--    fn_cashier_conservation_report) computes opening + ledger flow since
--    the cutover / taken_at, so the grant was the opening AND a credit.
--    The writer assumed an inserted balance has no ledger row; since
--    2026-09-03 the opening grant always has one, and since the ledger
--    invariant a club INSERT with a non-zero treasury cannot commit without
--    it. Any club created after 2026-09-08 with the grant would read
--    100,000.00 critical; Lightning is the only one so far (Diamond Arena
--    opened at 0; Deep Stack Society's row is the 09-08 backfill of a club
--    whose opening had no leg, and it reads ok).
--
--    Fix at the writer: the opening is the part of the inserted balance the
--    ledger does NOT already hold (inserted balance minus this treasury's
--    ledger net at that instant). trg_ca_autoledger fires before
--    trg_ca_club_gets_a_baseline (AFTER triggers run in name order), so a
--    journaled opening grant gives opening 0, ledger_at_baseline 100,000.
--    The one row written wrong is corrected to exactly that, guarded on the
--    grant leg existing at taken_at. This is a correction of a reference
--    record proven wrong by the journal, not a rebaseline: no other row and
--    no balance changes, and the club then reads ok because ledger equals
--    stored (probe, rolled back, 2026-10-15 23:28 UTC: opening 0, credited
--    104,950.10, debited 20,119.46, ledger 84,830.64 = stored 84,830.64,
--    critical positions 0).
--
-- 2. fn_charge_place_overpays IS RETIRED (CLAUDE.md 10.12).
--
--    A repair job: it charged clubs for prizes overpaid on duplicate
--    finishing places renumbered on 2026-08-28. The cause is fixed at the
--    root - unique index tournament_players_one_finish_position
--    (tournament_id, position) makes a duplicate place impossible - no
--    renumber has been written since 2026-08-28 18:43, all 296 charges were
--    taken by 2026-09-02 06:31, and its queue has been empty since. Its debit
--    (fn_debit_treasury without a declaration) would be refused by name if it
--    ever filled. It now moves nothing and answers status '_retired'; the
--    engine caller is removed in the same pull request. The function stays so
--    a running engine generation calling it gets an answer, not an error.
--
-- Changelog: docs/changelog/2026-10-15-a-new-clubs-opening-grant-is-counted-once.md

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.fn_ca_club_gets_a_baseline()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    DECLARE
      v_ledgered numeric;
    BEGIN
      /* A club created after the baseline cutover had no opening row, and
         reconcile_ledger_nightly read that absence as an opening of zero -
         9,981,739.70 of fabricated critical drift against Deep Stack Society,
         every night, from the day it was created. Recording it here means the
         reconciler is never guessing.

         ca_treasury_opening_is_what_the_ledger_lacks (2026-10-15): the
         opening is the part of the inserted balance the ledger does NOT
         already hold. A new club's 100,000 opening grant is journaled by
         trg_ca_autoledger, which fires before this trigger (AFTER triggers
         run in name order); recording the whole inserted balance as the
         opening counted that grant twice - 100,000.00 of false critical
         drift against Lightning Internal Pilot. */
      SELECT COALESCE(sum(CASE WHEN l.to_type = 'club_treasury' AND l.to_entity_id = NEW.id
                               THEN l.amount ELSE 0 END), 0)
           - COALESCE(sum(CASE WHEN l.from_type = 'club_treasury' AND l.from_entity_id = NEW.id
                               THEN l.amount ELSE 0 END), 0)
        INTO v_ledgered
        FROM public.chip_ledger l
       WHERE (l.to_type = 'club_treasury' AND l.to_entity_id = NEW.id)
          OR (l.from_type = 'club_treasury' AND l.from_entity_id = NEW.id);

      INSERT INTO public.ca_treasury_baseline
        (club_id, opening_balance, ledger_at_baseline, unledgered_gap, taken_at)
      VALUES (NEW.id,
              round(COALESCE(NEW.chip_treasury, 0) - v_ledgered, 2),
              round(v_ledgered, 2),
              round(COALESCE(NEW.chip_treasury, 0) - v_ledgered, 2),
              now())
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END;
    $function$;

CREATE OR REPLACE FUNCTION public.fn_charge_place_overpays(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* _retired 2026-10-15 (CLAUDE.md 10.12). A repair job for duplicate
     finishing places; tournament_players_one_finish_position makes a
     duplicate place impossible, the last renumber was 2026-08-28 and the
     last charge 2026-09-02. Moves nothing. */
  RETURN jsonb_build_object('ok', true, 'status', '_retired',
    'charged', 0, 'clubs_charged', 0,
    'blocked_insufficient_treasury', 0, 'clubs_blocked', 0,
    'reason', 'duplicate finishing places are refused by tournament_players_one_finish_position; nothing left to charge');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_charge_place_overpays(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_charge_place_overpays(integer) TO service_role;

DO $fix$
DECLARE
  v_n integer;
  v_pos record;
BEGIN
  IF current_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  -- The writer depends on the autoledger leg existing when it runs.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.clubs'::regclass
                  AND tgname = 'trg_ca_autoledger' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'trg_ca_autoledger is not enabled on clubs';
  END IF;

  -- Nothing left for the retired repair job.
  IF EXISTS (SELECT 1 FROM public.tournament_place_overpay_charges
              WHERE charged_at IS NULL AND overpaid > 0.005) THEN
    RAISE EXCEPTION 'place overpay queue is not empty; not retiring';
  END IF;
  IF to_regclass('public.tournament_players_one_finish_position') IS NULL THEN
    RAISE EXCEPTION 'tournament_players_one_finish_position is missing; the root fix is not in place';
  END IF;

  UPDATE public.ca_treasury_baseline b
     SET opening_balance = 0, ledger_at_baseline = 100000.00, unledgered_gap = 0
   WHERE b.club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d'
     AND b.opening_balance = 100000.00
     AND EXISTS (SELECT 1 FROM public.chip_ledger l
                  WHERE l.idempotency_key = 'club-opening-grant:e14bc9f7-736d-425f-8f2c-e78305ebac1d'
                    AND l.to_type = 'club_treasury' AND l.to_entity_id = b.club_id
                    AND l.amount = 100000.00 AND l.created_at = b.taken_at);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected to correct 1 baseline row, matched %', v_n;
  END IF;

  SELECT * INTO v_pos FROM public.fn_ca_treasury_positions()
   WHERE club_id = 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  IF v_pos.severity IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'Lightning treasury still reads % (ledger %, stored %)',
      v_pos.severity, v_pos.ledger_balance, v_pos.stored_balance;
  END IF;
END
$fix$;

COMMIT;
