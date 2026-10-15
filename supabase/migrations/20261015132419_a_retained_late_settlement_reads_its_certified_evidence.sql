-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure)='2c1a8c9228ca708965748ccb56e88db9'
-- 20261015132419_a_retained_late_settlement_reads_its_certified_evidence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT HAPPENED
--
-- The original week (union fade0000, 2026-10-05 -> 10-12) proved all 84
-- flow windows at 12:16 UTC today and assembled pnl_flows_problem with 22
-- invalid flows, so the union report answers
-- original_money_flow_basis_incomplete and the week cannot close. The
-- certificate of 2026-10-14 12:13 read the same week with no invalid flow.
--
-- The 22 are the late seat settlements written between 15:33:05 and 15:34:17
-- UTC on 2026-10-06 (chip_ledger category 'settlement', idempotency key
-- late_seat_settle:<hand>:<player>, 15 debits of 105.85 and 7 credits of
-- 138.34, all horses of Club JAQK and SHARK CLUB). Each one is a real,
-- completed settlement: its ca_settlements row, idempotency key, provenance
-- receipt, accepted outcome, signed request, wallet credit and funding lineage
-- all exist and agree.
--
-- CAUSE (read from rows)
--
-- fn_union_pnl_prove_late_settlement proves a hand either from its live
-- hand_atomic_commits row or, once that row is retained and pruned, from its
-- smarter_private.horse_settlement_key_certificates row. The retained branch
-- compares cert.accounting_evidence_sha256 with the sha256 of the outcome's
-- full evidence (union_pnl_cash_outcomes.evidence). But
-- smarter_private.compact_horse_settlement_keys writes that digest over
-- fn_pnl_cash_hand_evidence(table, hand), the base evidence, and every
-- outcome row carries the base evidence plus the three accepted_* keys
-- (accepted_bbj, accepted_rake, accepted_external_net). Read over all 472,751
-- certificates on production: the digest equals the outcome evidence with
-- those three keys removed on every one, and the full evidence on none. So
-- the retained branch could never prove a hand. The 22 hands moved to it when
-- compaction retained them at 2026-10-14 15:33, which is why the 10-14
-- certificate had no invalid flow and today's has 22.
--
-- FIX
--
-- The retained branch digests the outcome evidence in the shape the
-- certificate was written over: without accepted_bbj, accepted_rake and
-- accepted_external_net. Nothing else in the proof changes; every other
-- condition still holds each flow to its settlement, request, credit and
-- funding lineage.
--
-- Proved in production with a pg_temp successor: all 22 flows prove, one row
-- each, net 32.49 (138.34 credited - 105.85 debited), against none today. The
-- function is not a pinned original-inventory source, so no certificate's
-- generation moves; the problem windows are re-proved by the weekly close on
-- its own schedule.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

DO $migration$
DECLARE
  sig constant regprocedure := 'public.fn_union_pnl_prove_late_settlement(uuid)'::regprocedure;
  old_line constant text := $o$AND w.retained_evidence_sha=encode(extensions.digest(convert_to(w.evidence::text,'UTF8'),'sha256'),'hex') END$o$;
  new_line constant text := $n$AND w.retained_evidence_sha=encode(extensions.digest(convert_to((w.evidence-'accepted_bbj'-'accepted_rake'-'accepted_external_net')::text,'UTF8'),'sha256'),'hex') END$n$;
  src text; meta_before text; meta_after text;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'late_settlement_evidence_operator_refused' USING ERRCODE = '42501';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false
     OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'late_settlement_evidence_freeze_refused';
  END IF;
  SELECT p.prosrc, format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
    INTO src, meta_before FROM pg_proc p WHERE p.oid = sig;
  IF md5(src) <> 'fe123c476dd189b5e5588682c5f8a355' THEN
    RAISE EXCEPTION 'late_settlement_evidence_preimage_refused';
  END IF;
  IF (length(src) - length(replace(src, old_line, ''))) / length(old_line) <> 1 THEN
    RAISE EXCEPTION 'late_settlement_evidence_anchor_refused';
  END IF;
  -- The shape the certificate is written over, read where it is written.
  IF position($w$encode(extensions.digest(convert_to(evidence::text,'UTF8'),'sha256'),'hex'),a.post_commit_completed_at)$w$
       IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'smarter_private.compact_horse_settlement_keys(uuid[])'::regprocedure)) = 0
     OR position('evidence:=public.fn_pnl_cash_hand_evidence(h.table_id,h.hand_number::bigint);'
       IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'smarter_private.compact_horse_settlement_keys(uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'late_settlement_evidence_certificate_writer_moved';
  END IF;
  EXECUTE replace(pg_get_functiondef(sig), old_line, new_line);
  SELECT p.prosrc, format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
    INTO src, meta_after FROM pg_proc p WHERE p.oid = sig;
  IF md5(src) <> '2c1a8c9228ca708965748ccb56e88db9' THEN
    RAISE EXCEPTION 'late_settlement_evidence_postimage_refused: %', md5(src);
  END IF;
  IF meta_after IS DISTINCT FROM meta_before THEN
    RAISE EXCEPTION 'late_settlement_evidence_security_refused';
  END IF;
END
$migration$;

COMMIT;
