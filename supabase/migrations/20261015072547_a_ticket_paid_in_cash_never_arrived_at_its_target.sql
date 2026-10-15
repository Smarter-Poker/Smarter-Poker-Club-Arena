-- 20261015072547_a_ticket_paid_in_cash_never_arrived_at_its_target
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 07:25:47 UTC.
--
-- A TICKET PAID IN CASH NEVER ARRIVED AT ITS TARGET (2026-10-15)
--
-- The deep money-conservation pass (cron tourney_money_conservation_deep_daily,
-- 03:25 UTC, fn_tournament_money_conservation(45, 1.0, 500)) raised 56
-- "Tournament retained money it never paid out" alerts in one run on
-- 2026-10-15, every one a COMPLETED freezeout target of direct satellites,
-- deltas 20.00 to 6,700.00. Nothing was stranded. Read from rows:
--
--   * At 2026-10-14 23:33 UTC the stranded-ticket settlement
--     (20261012055242..20261012055452, source stranded_ticket_settlement_20261012)
--     paid 928 entry-only direct tickets worth 55,120.00, whose targets had
--     closed before they could be used, to their holders in cash through
--     fn_ca_pay_closed_target_ticket_in_cash: one ticket_redeem leg
--     escrow -> player_wallet keyed ticket:<id>:closed-target-cash, a
--     wallet credit "Satellite Seat Paid In Cash: Target Entry Closed", and
--     the ticket guard's one sanctioned transition issued -> redeemed.
--     zz_closed_target_pays_its_satellite_tickets does the same live for
--     every target that closes from now on (12 more tickets since).
--   * The seat_income term of fn_tournament_conservation_delta and
--     fn_tournament_conservation_deltas counts a ticket as money arriving at
--     its target when k.status = 'redeemed'. Before 2026-10-12 the only door
--     to 'redeemed' was tournament admission (escrow -> prize_liability leg
--     naming the target). The cash door reuses the status, so each cash-paid
--     ticket now credits a target it never entered.
--   * Measured read-only on production 2026-10-15 07:25 UTC: 57 targets carry
--     cash-paid tickets (940 tickets, 57,520.00) and for all 57 the live
--     delta equals the cash-paid value exactly; no other event moves. The
--     example a94f8c5f (DSS Wednesday $22 NLH Deepstack, +20.00) is one
--     4efa39ae ticket of 20.00 paid in cash at 23:33:05. The satellites
--     themselves stay at 0.00: seat_paid_out already counts an issued ticket
--     leaving the satellite, and the cash credit is category 'transfer', not
--     a 'prize' the satellite could double count.
--
-- THE FIX, at the line that misreads: in both reads a redeemed ticket counts
-- as seat income only when it has no closed-target-cash leg (one primary-key
-- probe of chip_ledger_idem per ticket row). After install the hourly pass 1
-- re-reads every open alert through the corrected scalar and closes the 56
-- itself; no alert row, wallet or ledger row is written by this migration.
-- Not a settlement: no money moved wrongly, so 10.9 has nothing to pay.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (scalar 17ae3dfd..., set
-- 118b1c0b...), the one anchor must occur exactly once in each (measured
-- read-only on production 2026-10-15: 1 and 1), and each result must hash to
-- the postimage derived read-only on production with replace() (scalar
-- 34e1f8a4..., set 4bc2c77d...); owner, SECURITY DEFINER, proconfig and
-- grants must not move.
--
-- Regression: scripts/ci/test-ticket-cash-conservation.py (native
-- PostgreSQL), run by .github/workflows/ticket-cash-conservation.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = '34e1f8a48e1ba37b8009e3d64c5ed626' AND md5(pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure)) = '4bc2c77d5e02abe38a535367bade00e8')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_conservation_subst(p_sig text, p_before text, p_after text,
                                              p_old text, p_new text)
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '%: anchor occurs % times, expected exactly 1', p_sig, v_n;
  END IF;
  v_new := replace(v_def, p_old, p_new);
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_conservation_subst(
  'public.fn_tournament_conservation_delta(uuid)',
  '17ae3dfd32d3cb1d2673a86c0d8d9426', '34e1f8a48e1ba37b8009e3d64c5ed626',
  $old$AND (k.id IS NULL OR k.status = 'redeemed')$old$,
  $new$AND (k.id IS NULL OR (k.status = 'redeemed'
          -- A TICKET PAID IN CASH NEVER ARRIVED HERE (2026-10-15). A direct
          -- ticket whose target closed before it was used is paid to its
          -- holder from ticket escrow by fn_ca_pay_closed_target_ticket_in_cash,
          -- and the ticket guard records that as issued -> redeemed too. That
          -- redemption is an escrow -> wallet leg keyed
          -- ticket:<id>:closed-target-cash, not an entry into this event (an
          -- admitted ticket's leg is escrow -> prize_liability instead), so it
          -- is income the target never received.
          AND NOT EXISTS (SELECT 1 FROM public.chip_ledger_idem ci
                           WHERE ci.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash')))$new$
);

SELECT pg_temp.ca_conservation_subst(
  'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)',
  '118b1c0bbf6f959809efe6b385d92bf9', '4bc2c77d5e02abe38a535367bade00e8',
  $old$AND (k.id IS NULL OR k.status = 'redeemed')$old$,
  $new$AND (k.id IS NULL OR (k.status = 'redeemed'
          -- A TICKET PAID IN CASH NEVER ARRIVED HERE (2026-10-15). A direct
          -- ticket whose target closed before it was used is paid to its
          -- holder from ticket escrow by fn_ca_pay_closed_target_ticket_in_cash,
          -- and the ticket guard records that as issued -> redeemed too. That
          -- redemption is an escrow -> wallet leg keyed
          -- ticket:<id>:closed-target-cash, not an entry into this event (an
          -- admitted ticket's leg is escrow -> prize_liability instead), so it
          -- is income the target never received.
          AND NOT EXISTS (SELECT 1 FROM public.chip_ledger_idem ci
                           WHERE ci.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash')))$new$
);

COMMIT;
