-- ===========================================================================
--  RETENTION PRUNES AN UNATTACHED CERTIFICATION HAND
-- ===========================================================================
--
-- SUPERSEDES 20260926151328_prune_e2e_certification_hand_history_fixtures
-- (marked superseded in scripts/ci/applied-migration-aliases.json). That file
-- was merged and never installed: its full-body CREATE OR REPLACE of
-- sp_prune_hand_history would revert 20261002082452 (an unsettled tournament
-- keeps its hands). It was also incomplete, which this file corrects.
--
-- READ ON PRODUCTION 2026-10-05: public.hand_history holds eight rows with
-- table_id NULL. All eight are the settled-hand fixture that
-- tests/e2e/production-daily-missions.spec.ts inserts through the service
-- role and deletes in its finally block: tournament_id NULL, players '[]',
-- has_human false, hand_number in the reserved 1,700,000,000-1,799,999,999
-- range, created 2026-09-11 to 2026-10-03. A run killed before its finally
-- block (a Playwright timeout tearing down the worker, SIGKILL, host loss)
-- leaves its row behind. The engine never writes such a row.
--
-- TWO LINES KEPT THEM FOR EVER, NOT ONE:
--   1. The candidate EXISTS requires tb.id = hh.table_id, which is never true
--      for a NULL table_id, so the row was never a candidate. 20260926151328
--      fixed only this.
--   2. Admitted, the classifier reads an empty player list as human
--      ("WHEN jsonb_array_length(c.players)=0 THEN true"), so the row would
--      have been stamped has_human=true and retained for ever as a hand a
--      person played. 20260926151328 would have done exactly that.
--
-- THE FIX: a row with no table, no tournament and nobody dealt in is
-- admitted past the table/tournament EXISTS and classified as not human.
-- Nothing else moves. Every other guard still governs it: retention age,
-- reported, BBJ payouts, the projection outbox, pending knockouts, and both
-- F06 helpers, which read false for a NULL table_id (measured on all eight
-- rows). Any row with a table or a tournament, or with a player in it, is
-- untouched by this clause.
--
-- This is the existing ten-minute retention job doing its ordinary work, not
-- a new sweep (CLAUDE.md 10.12), and no row is deleted by this migration:
-- the five rows already past horse_retention_days leave on the job's next
-- run, the other three as they age past it.
--
-- HOW: exact substitution through the pg_temp helper of 20261004224309:
-- preimage md5 pinned, each of four anchors proved to occur exactly once,
-- postimage md5 computed read-only on production, owner/security/settings/
-- grants asserted unmoved. Applied outside the :50-:03 window.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)) = '931d0ad53e8d65536a0d5558b704a42f')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
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


SELECT pg_temp.ca_audit_subst(
  'public.sp_prune_hand_history(integer)',
  '6c0286c294cc2784241b3e6a427e6c4f', '931d0ad53e8d65536a0d5558b704a42f',
  ARRAY[$o$      SELECT hh.id,hh.players
        FROM public.hand_history hh
$o$, $o$         AND EXISTS (
           SELECT 1 FROM public.tables tb
$o$, $o$
         )
       ORDER BY hh.created_at
$o$, $o$          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
$o$],
  ARRAY[$n$      SELECT hh.id,hh.players,
             (hh.table_id IS NULL AND hh.tournament_id IS NULL
              AND hh.players = '[]'::jsonb) AS unattached
        FROM public.hand_history hh
$n$, $n$         -- AN UNATTACHED ROW IS NOT A HAND ANYBODY PLAYED (2026-10-05). A row
         -- with no table, no tournament and nobody dealt in is the settled-hand
         -- fixture tests/e2e/production-daily-missions.spec.ts inserts and
         -- deletes; a run killed before its finally block leaves it behind.
         -- The engine never writes one. tb.id=hh.table_id is never true for a
         -- NULL table_id, so the EXISTS below excluded such a row from every
         -- run, and even admitted, an empty player list classifies as human
         -- below and would be kept for ever. Every guard above still governs
         -- it (both f06 helpers read false for a NULL table_id, measured on
         -- all eight such rows). Migration 20261005111120.
         AND ((hh.table_id IS NULL AND hh.tournament_id IS NULL
               AND hh.players = '[]'::jsonb) OR EXISTS (
           SELECT 1 FROM public.tables tb
$n$, $n$
         ))
       ORDER BY hh.created_at
$n$, $n$          WHEN c.unattached THEN false
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
$n$]);

COMMIT;
