-- 20261007103144_retire_the_split_horse_hand_review_rollup_writer.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Horse Brain Phase 14.1 (plan package P14-C) cutover. Migration
-- 20261007020953 installed public.fn_hhr_record_atomic, which publishes a
-- horse hand review, its permanent receipt and its horse_review_rollup
-- arithmetic in one transaction. The old split writer called
-- public.fn_hhr_rollup_add once per inserted horse in a separate request, and
-- a failed or unanswered call left a review without its rollup.
--
-- The plan requires the old writer to be drained before the cutover, and the
-- cutover to be verified on its own evidence rather than by install time:
--
--   * The engine release carrying the single-call writer (#6352, merge
--     5f768074) has been serving since about 10:00Z on 2026-10-07; the
--     engine /health version read 5f768074 at 10:30Z.
--   * Read back from production at 10:30:58Z: 782 receipts written by
--     fn_hhr_record_atomic since 10:01:02Z, 782 reviews inserted in that time,
--     0 reviews without a receipt, every receipt joined to its review row and
--     to its rollup row.
--   * No installed function calls fn_hhr_rollup_add (pg_proc prosrc read back:
--     only comments and one explanatory text string mention it), and no
--     engine source calls it.
--
-- So service_role's EXECUTE on fn_hhr_rollup_add is revoked. The function
-- stays installed and unchanged (its owner keeps it, nothing else can call
-- it), so this is a permission change only: no table, row or aggregate is
-- touched, and nothing is backfilled or reset. Historical review rows written
-- by the old writer keep their unknown rollup status.
--
-- The migration refuses to apply unless fn_hhr_record_atomic exists and has
-- already written receipts, so it can never run ahead of the atomic path.
--
-- GRANT and REVOKE do not trigger a PostgREST schema reload (CLAUDE.md DDL
-- policy rule 5).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_acl text;
BEGIN
  IF to_regprocedure('public.fn_hhr_record_atomic(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'fn_hhr_record_atomic is not installed; the split writer cannot be retired first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.horse_hand_review_receipts) THEN
    RAISE EXCEPTION 'fn_hhr_record_atomic has written no receipt yet; the atomic path is not proven serving';
  END IF;
  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[]) is not installed';
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'fn_hhr_rollup_add ACL is not the pinned preimage: %', v_acl;
  END IF;
END
$guard$;

REVOKE EXECUTE ON FUNCTION public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) FROM service_role;

DO $post$
DECLARE
  v_acl text;
BEGIN
  SELECT p.proacl::text INTO v_acl
    FROM pg_proc p
   WHERE p.oid = 'public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])'::regprocedure;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'fn_hhr_rollup_add ACL after revoke is not the pinned postimage: %', v_acl;
  END IF;
END
$post$;

COMMIT;
