-- 20261008140504_a_redeemed_satellite_ticket_is_not_extra_seat_evidence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ============================================================================
-- A REDEEMED SATELLITE TICKET IS NOT EXTRA SEAT EVIDENCE
-- ============================================================================
--
-- Measured on production (kuklfnapbkmacvwxktbh) 2026-10-08 13:45Z by
-- replaying every satellite receipt of the last seven days in a rolled-back
-- transaction: 328 of 562 refused -
--
--     satellite <id> has malformed or extra actual-seat evidence (P0404)
--
-- 299 cohort receipts and 29 single-winner receipts. Every one of them had
-- settled correctly and paid in full. What changed afterwards: a 'ticket'
-- award (a cap-blocked full award held as a tournament-entry-only ticket)
-- was REDEEMED into the target - by a horse, 22 seconds after settlement on
-- 00047f1f - and the redemption registers the holder in the target with
-- source_satellite_id = this satellite and is_satellite_qualifier = true,
-- exactly as a seat does. The receipt's "no target registration from this
-- satellite without a seat award" clause then reads that legitimate
-- registration as an extra seat and refuses.
--
-- The receipt is replayed after settlement by fn_get_satellite_qualifier_state
-- (the manager's own completion read: an engine restart between settlement
-- and cleanup leaves the event 'completed' but unprovable, which the manager
-- answers with 'pending' forever), by fn_resolve_satellite_qualifier_outcome
-- and by fn_get_my_satellite_qualifier_result (what the player's result
-- screen asks). An immutable receipt that stops proving 22 seconds after it
-- was written is not immutable.
--
-- THE CHANGE
--
-- In both receipts, in both the Diamond and the chip branch, a target
-- registration from this satellite is also accounted for when a REDEEMED
-- entry ticket of this satellite names its holder for that target:
--   tournament_tickets tk: source_satellite_id = this satellite,
--   holder_id = the registration's user, source_tournament_id = the target,
--   status 'redeemed', redeemed_at set, source_satellite_award_place set.
-- The ticket itself is still proved by the 'ticket' award clause (issue
-- journal, escrow leg, no wallet credit). The seat ledger count is
-- unchanged: a redemption writes from escrow, never from the satellite's
-- prize liability.
--
-- PROVED before apply: with this substitution all 562 satellites of the last
-- seven days replay clean (441 cohort, 121 single), zero refusals.
--
--
-- AS APPLIED, THIS MIGRATION DID NOTHING. Its idempotency guard looked for
-- 'tk.source_satellite_award_place IS NOT NULL', which the receipts already
-- carry in their ticket clause, so both edits were skipped with a NOTICE and
-- the proof passed on the same text. Caught by replaying 00047f1f against the
-- live function four minutes later. 20261008140724 carries the same edit with
-- a guard keyed on the new clause's own text (tk.holder_id = tp.user_id) and
-- is the one that changed the receipts. Kept because the database recorded
-- it; CLAUDE.md: a migration file matches what production ran.
-- @live-proof: (SELECT position('tk.source_satellite_award_place IS NOT NULL' in pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) > 0 AND position('tk.source_satellite_award_place IS NOT NULL' in pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  v_src text; v_anchor text; v_ins text; v_n int; fn text; v_md5 text;
  r record;
BEGIN
  IF NOT (current_user IN ('postgres','service_role','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;
  v_anchor := $a$       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)$a$;
  v_ins := $i$       AND tp.source_satellite_id = p_tournament_id
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_satellite_awards a
          WHERE a.tournament_id = p_tournament_id
            AND a.delivery_kind = 'seat' AND a.registration_id = tp.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_satellite_id = p_tournament_id
            AND tk.holder_id = tp.user_id
            AND tk.source_tournament_id = tp.tournament_id
            AND tk.status = 'redeemed'
            AND tk.redeemed_at IS NOT NULL
            AND tk.source_satellite_award_place IS NOT NULL)$i$;
  FOR r IN SELECT * FROM (VALUES
      ('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])',   'b77ddbf69afdb53bd342e6e0c0f3a5a2'),
      ('public.fn_ca_satellite_settlement_receipt(uuid,uuid)', '34f61b69fa205cc61a2f6b16b8b57be2')) AS x(fn, pre)
  LOOP
    v_src := pg_get_functiondef(r.fn::regprocedure);
    IF position('tk.source_satellite_award_place IS NOT NULL' in v_src) > 0 THEN
      RAISE NOTICE '% already admits a redeemed ticket registration; skipping', r.fn;
      CONTINUE;
    END IF;
    v_md5 := md5(v_src);
    IF v_md5 <> r.pre THEN
      RAISE EXCEPTION 'preimage: % is % not % - re-read this edit against the live body', r.fn, v_md5, r.pre;
    END IF;
    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 2 THEN
      RAISE EXCEPTION '% carries the extra-registration clause % times, expected 2 (Diamond and chip branches)', r.fn, v_n;
    END IF;
    EXECUTE replace(v_src, v_anchor, v_ins);
  END LOOP;
END
$mig$;

DO $prove$
BEGIN
  IF position('tk.source_satellite_award_place IS NOT NULL' in pg_get_functiondef('public.fn_ca_satellite_cohort_receipt(uuid,uuid[])'::regprocedure)) = 0
     OR position('tk.source_satellite_award_place IS NOT NULL' in pg_get_functiondef('public.fn_ca_satellite_settlement_receipt(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'a redeemed ticket registration is still read as extra seat evidence';
  END IF;
END
$prove$;

COMMIT;
