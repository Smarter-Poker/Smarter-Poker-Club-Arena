-- 20261015170338_the_payout_sweep_never_reads_a_cash_paid_ticket_as_pool_mone.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
-- Replaces the held draft 20261015072547 (PR #6928), which its own preimage
-- guard refused: two of its three functions had already been corrected live.
--
-- THE PAYOUT SWEEP NEVER READS A CASH PAID TICKET AS POOL MONEY (2026-10-15)
--
-- WHAT HAPPENED
--
-- At 03:25 UTC on 2026-10-15 the deep money-conservation pass (cron 274)
-- raised 56 "Tournament retained money it never paid out" warnings, 55,120.00
-- in all, on completed freezeout targets of direct satellites. At 23:33 UTC on
-- 2026-10-14 the stranded-ticket settlement had paid 928 entry-only direct
-- tickets, whose targets closed before they could be used, to their holders
-- in cash through fn_ca_pay_closed_target_ticket_in_cash: one ticket_redeem
-- leg escrow -> player_wallet with idempotency key
-- 'ticket:<id>:closed-target-cash', and the ticket moved issued -> redeemed.
-- The conservation reads count a redeemed ticket as a seat ARRIVING at its
-- target, because until 2026-10-12 admission was the only way to 'redeemed'.
-- Each cash-paid ticket therefore credited a target it never entered.
--
-- WHAT IS ALREADY FIXED LIVE
--
-- 20261015100003 (PR #6941, installed) corrected two of the three reads:
-- fn_tournament_conservation_delta and fn_tournament_conservation_deltas now
-- exclude a ticket whose redemption is the cash door's own leg. Measured
-- read-only on production 2026-10-15 17:05 UTC: all 56 alerts were resolved
-- by cron 144 pass 1 at 13:12:00 UTC, each one's delta had equalled its
-- target's cash-paid ticket value to the cent (56 of 56, 55,120.00 of
-- 55,120.00), and all 56 targets now read 0.00.
--
-- WHAT THIS FIXES: THE THIRD READ
--
-- fn_pay_backed_payout_shortfalls (cron 231, hourly at :26) carries the same
-- seat_income term inline and still gates it with the old
-- AND (k.id IS NULL OR k.status = 'redeemed'). It selects events whose delta
-- is above 0.01 as holding money it may pay a reconciler top-up from, and
-- compares that delta against the top-up to decide between paying and raising
-- a critical "withheld_unfunded_pool" alert. Measured read-only on production
-- 2026-10-15 17:05 UTC: 46 completed targets inside its 30-day window carry
-- cash-paid tickets worth 42,160.00, and each reads as holding that money.
-- None currently reports a top-up, so nothing has been paid and no alert was
-- suppressed. But the day one does, the sweep would count money the event
-- never held: in dry mode it reports the event as payable instead of raising
-- the withheld alert, and in apply mode it would pay the top-up and then hit
-- its own conservation refusal, because the corrected scalar reads the event
-- below zero. The payer and the scalar now disagree; this makes them agree.
--
-- THE FIX, at the line that misreads: the same gate #6941 installed, byte for
-- byte, so all three reads exclude a cash-paid ticket by the same rule (one
-- probe of the unique index ux_chip_ledger_idempotency_key per ticket row).
-- The satellite side (seat_outgoing) is untouched: the satellite really did
-- pay that seat out into the ticket escrow. No alert, wallet or ledger row is
-- written by this migration; no money moved wrongly, so 10.9 has nothing to
-- pay.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (c9e67c9c..., unchanged since
-- 20261009151510), the old gate must occur exactly once (measured: 1), and the
-- result must hash to the postimage derived read-only on production with
-- replace() (8a6a20c6...); owner, SECURITY DEFINER, proconfig and grants must
-- not move. The scalar and the set read are not edited; the migration only
-- asserts that each already carries the new gate exactly once, so the three
-- can never be installed out of step.
--
-- Regression: scripts/ci/test-ticket-cash-conservation-v2.py (native
-- PostgreSQL), run by .github/workflows/ticket-cash-conservation-v2.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = '8a6a20c6856b200dfa0ff7a1550044e4')
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_payout_sweep_subst(p_sig text, p_before text, p_after text,
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

-- The scalar and the set read must already exclude a cash-paid ticket with
-- this exact gate (20261015100003), so the payer is never ahead of them.
DO $guard$
DECLARE
  v_gate constant text := $g$AND (k.id IS NULL OR (k.status = 'redeemed' AND NOT EXISTS (SELECT 1 FROM public.chip_ledger cl WHERE cl.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash' AND cl.category = 'ticket_redeem')))$g$;
  v_sig text; v_def text; v_n integer;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.fn_tournament_conservation_delta(uuid)',
    'public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'] LOOP
    v_def := pg_get_functiondef(v_sig::regprocedure);
    v_n := (length(v_def) - length(replace(v_def, v_gate, ''))) / length(v_gate);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: carries the cash-paid ticket gate % times, expected exactly 1', v_sig, v_n;
    END IF;
  END LOOP;
END $guard$;

SELECT pg_temp.ca_payout_sweep_subst(
  'public.fn_pay_backed_payout_shortfalls(boolean,integer)',
  'c9e67c9c7e42028543e39b18d29f02d3', '8a6a20c6856b200dfa0ff7a1550044e4',
  $old$AND (k.id IS NULL OR k.status = 'redeemed')$old$,
  $new$AND (k.id IS NULL OR (k.status = 'redeemed' AND NOT EXISTS (SELECT 1 FROM public.chip_ledger cl WHERE cl.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash' AND cl.category = 'ticket_redeem')))$new$
);

COMMIT;
