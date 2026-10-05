-- ===========================================================================
--  A GUARANTEE OVERLAY LOCKS THE BANK WITHOUT BLOCKING FOREIGN KEYS
-- ===========================================================================
--
-- SUPERSEDES the overlay half of
-- 20260929071925_a_tournament_start_locks_the_bank_without_blocking_foreign_k
-- (marked superseded in scripts/ci/applied-migration-aliases.json). That file
-- was merged and never installed. Its start-readiness half reached
-- production through 20261002083400; its overlay half did not, because a
-- later migration had already redefined fn_ca_fund_overlay_on_lock() and
-- the old file's full-body replacement would revert it.
--
-- READ ON PRODUCTION 2026-10-05: trg_tournaments_start_readiness locks the
-- bank row FOR NO KEY UPDATE, and fn_ca_fund_overlay_on_lock() (md5
-- 54d60d5b8e51a523f610c72b40c1fbaa), running in the same transaction after
-- it, still locks the same rows FOR UPDATE in three places: the union bank,
-- the club-treasury fallback, and the club treasury. FOR UPDATE is the one
-- row lock that also conflicts with FOR KEY SHARE, the lock every foreign-key
-- check takes, so every start that needed an overlay upgraded the guard's
-- lock mid-transaction and queued again behind every open insert that
-- references the club (agent_commissions, rake_records, table_seats,
-- tournament_players and more). 20260929071925's header has the measured
-- drain: launches waiting 21.7 s, finishes up to 43 s.
--
-- THE FIX IS THE LOCK MODE, NOTHING ELSE. FOR NO KEY UPDATE still conflicts
-- with FOR NO KEY UPDATE, FOR UPDATE, FOR SHARE and every UPDATE of the row,
-- so a competing start, any other overlay and every treasury debit or
-- credit stay serialized exactly as before; the overlay's own UPDATE of
-- chip_treasury or chip_balance is a non-key update and needs no more. No
-- balance, rule, alert, payout or ledger row changes. The disposable
-- PostgreSQL proof of both lock modes is 20260929071925's
-- (scripts/dev/probe-start-readiness-lock.py).
--
-- HOW: exact substitution through the pg_temp helper of 20261004224309:
-- preimage pinned, each of the three anchors proved to occur exactly once,
-- postimage md5 computed read-only on production, owner/security/settings/
-- grants asserted unmoved. Applied outside the :50-:03 window.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)) = '52773a5c7b5011bb82e0518f50b461b5')

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
  'public.fn_ca_fund_overlay_on_lock()',
  '54d60d5b8e51a523f610c72b40c1fbaa', '52773a5c7b5011bb82e0518f50b461b5',
  ARRAY[$o$  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR UPDATE;
$o$, $o$        FROM public.clubs WHERE id = NEW.club_id FOR UPDATE;
$o$, $o$    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR UPDATE;
$o$],
  ARRAY[$n$  /* FOR NO KEY UPDATE, NOT FOR UPDATE (2026-10-05). The start-readiness guard
     already locks this bank row FOR NO KEY UPDATE in the same transaction
     (20260929071925, installed by 20261002083400). FOR UPDATE here upgraded
     that lock mid-start to the one mode that also conflicts with FOR KEY
     SHARE, so an overlay start still queued behind every open foreign-key
     insert that references the club. A treasury debit is a non-key update
     and needs no more than this; start-vs-start and every treasury write
     still serialize exactly as before. */
  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR NO KEY UPDATE;
$n$, $n$        FROM public.clubs WHERE id = NEW.club_id FOR NO KEY UPDATE;
$n$, $n$    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR NO KEY UPDATE;
$n$]);

COMMIT;
