-- 20260928163959_a_terminal_close_marker_may_stamp_unregistration_rake_eviden.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- changes ONE trigger function. It schedules nothing, retries nothing, writes
-- no row and moves no chip. The winner it unblocks is paid by the engine's
-- own terminal door (fn_complete_tournament_terminal), once, idempotently.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-09-28 16:20-16:45 UTC)
--
-- c7f21a83 "Sunday Funday Six-Card Closer" has been decided since 01:10 UTC:
-- one registration playing (15c38b11, 120,000 chips, the whole supply) and
-- three eliminated. The engine asks to finish it and is refused:
--
--   [Tournament:c7f21a83] FINALIZING... candidate winner: 15c38b11   16:23:08
--   [Tournament.atomic_finish_refused] TerminalSettlementRefusedError:
--     committed tournament unregistration rake evidence is immutable 16:23:19
--
-- A rolled-back probe of the terminal door (one DO block ending in RAISE,
-- psql, 16:41 UTC) names the exact line:
--
--   fn_complete_tournament_terminal
--   -> fn_complete_tournament_terminal_pre_seat_guard line 811:
--      UPDATE tournaments SET status='COMPLETED', ended_at=...
--   -> AFTER trigger fn_stamp_tournament_terminal_evidence_markers line 29:
--      UPDATE rake_records SET terminal_closed_at = <ended_at>
--       WHERE tournament_id = <event> AND terminal_closed_at IS NULL
--   -> BEFORE trigger fn_ca_unregistration_rake_evidence_is_immutable:
--      RAISE 'committed tournament unregistration rake evidence is immutable'
--
-- Two rake_records rows of this event are named by its one unregistration
-- receipt (owner-directed release of a never-seated satellite entry,
-- migration 20260926054204): 1ad31e6e (the 5.00 fee source) and 860694cf
-- (the -5.00 reversal). The immutability trigger refuses EVERY update of a
-- named row, including the terminal close marker that
-- fn_stamp_tournament_terminal_evidence_markers must write on every mutable
-- evidence row of every terminal event (it raises 40001 if one is left
-- unstamped). The two rules contradict each other, so an event holding a
-- committed unregistration fee reversal can never complete or cancel: its
-- winner is never paid. That is the whole stall. Everything before line 811
-- (places, prizes, escrow) computed without complaint in the probe.
--
-- Every sibling evidence guard on rake_records already admits exactly that
-- one transition: fn_satellite_target_rake_is_immutable (the same rows carry
-- its satellite metadata) returns early when
-- fn_ca_terminal_marker_transition_is_exact(to_jsonb(OLD),to_jsonb(NEW),
-- OLD.tournament_id) holds. The unregistration guard was written without it.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- fn_ca_unregistration_rake_evidence_is_immutable gains that same early
-- return, in the sibling's exact shape, BEFORE its receipt lookup. The helper
-- admits an UPDATE only when:
--   * OLD.terminal_closed_at is NULL and NEW.terminal_closed_at is not;
--   * every other column of the row is identical (jsonb minus the marker,
--     IS NOT DISTINCT FROM);
--   * the row's tournament is already COMPLETED/CANCELLED with a finite
--     ended_at, and the marker equals that ended_at exactly.
-- So the fee source, the reversal, their amounts, club, metadata and every
-- other field stay immutable exactly as before; a DELETE is refused exactly
-- as before; a second marker change is refused exactly as before.
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility, language and search_path. The trigger
-- tournament_unregistration_rake_evidence_is_immutable is not touched.
--
-- WHAT IS PAID AND BY WHOM: nothing here. After install the engine's next
-- finish attempt (its refusal back-off is capped at 15 minutes) settles
-- c7f21a83 through fn_complete_tournament_terminal: the stored terminal
-- receipt is the idempotency key, so it is paid exactly once.
--
-- Pinned by tests/a-terminal-close-marker-may-stamp-unregistration-evidence.law.test.ts.
--
-- @live-proof: (SELECT md5(prosrc)='05c68d8a7a9e0364483cee945695e020' AND proacl::text='{postgres=X/postgres}' AND prosecdef AND proconfig=ARRAY['search_path=public'] FROM pg_proc WHERE oid='public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $unregistration_marker_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_unregistration_rake_evidence_is_immutable()')
       AND md5(p.prosrc) = '9a1109d19453657645e668d6e0310113'
       AND md5(pg_get_functiondef(p.oid)) = '4d035b0d2f169db1cdbe987078448e99'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'UNREGISTRATION_MARKER_PREIMAGE_DRIFT: fn_ca_unregistration_rake_evidence_is_immutable()';
  END IF;
  -- The helper this reuses must be the one the sibling guard already trusts.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)')
       AND md5(p.prosrc) = '3c9ce32b45c11b7372654c6efa89f667'
       AND pg_get_userbyid(p.proowner) = 'postgres') THEN
    RAISE EXCEPTION 'UNREGISTRATION_MARKER_PREIMAGE_DRIFT: fn_ca_terminal_marker_transition_is_exact(jsonb,jsonb,uuid)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.rake_records'::regclass
         AND t.tgname = 'tournament_unregistration_rake_evidence_is_immutable'
         AND t.tgfoid = 'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure
         AND t.tgenabled = 'O' AND t.tgtype = 27 AND NOT t.tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'UNREGISTRATION_MARKER_PREIMAGE_DRIFT: trigger';
  END IF;
END
$unregistration_marker_preimage$;

CREATE OR REPLACE FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $unregistration_rake_evidence_is_immutable$
BEGIN
  -- The one write a terminal event owes every mutable evidence row: its close
  -- marker, NULL to the event's own ended_at, nothing else changed. Every
  -- sibling rake guard admits exactly this (fn_ca_terminal_marker_transition_
  -- is_exact); refusing it left an event with an unregistration fee reversal
  -- unable ever to complete, so its winner could never be paid.
  IF TG_OP = 'UPDATE'
     AND NEW.terminal_closed_at IS DISTINCT FROM OLD.terminal_closed_at
     AND public.fn_ca_terminal_marker_transition_is_exact(
           to_jsonb(OLD), to_jsonb(NEW), OLD.tournament_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_unregistration_receipts receipt
     WHERE ARRAY[OLD.id] && receipt.fee_reversal_ids
        OR ARRAY[OLD.id] && receipt.fee_source_rake_record_ids) THEN
    RAISE EXCEPTION
      'committed tournament unregistration rake evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$unregistration_rake_evidence_is_immutable$;

REVOKE ALL ON FUNCTION public.fn_ca_unregistration_rake_evidence_is_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

DO $unregistration_marker_postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure
       AND md5(p.prosrc) = '05c68d8a7a9e0364483cee945695e020'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'UNREGISTRATION_MARKER_POSTIMAGE_DRIFT';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.rake_records'::regclass
         AND t.tgname = 'tournament_unregistration_rake_evidence_is_immutable'
         AND t.tgfoid = 'public.fn_ca_unregistration_rake_evidence_is_immutable()'::regprocedure
         AND t.tgenabled = 'O' AND t.tgtype = 27 AND NOT t.tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'UNREGISTRATION_MARKER_POSTIMAGE_DRIFT: trigger';
  END IF;
END
$unregistration_marker_postimage$;

COMMIT;
