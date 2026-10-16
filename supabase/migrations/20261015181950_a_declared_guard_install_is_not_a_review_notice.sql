-- 20261015181950_a_declared_guard_install_is_not_a_review_notice.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DECLARED GUARD INSTALL IS NOT A REVIEW NOTICE (2026-10-15)
--
-- WHAT HAPPENED, read from production (kuklfnapbkmacvwxktbh):
--
--   Migration 20261015024752_a_finding_with_no_amount_is_not_a_chip_drift
--   redefined the watched guard fn_ca_raise_drift_incident. Its header pins
--   the end state in an @live-proof line (md5 b5025fd1a0f856767f3a91166722ed7f),
--   it was reviewed, and it was installed. It did not also call
--   fn_ca_declare_guard_redefinition (20260910143032), so at 17:25 UTC
--   fn_ca_guard_defs_watch saw the hash move, opened info notice 7e831a2c
--   ("it does not close itself"), and two rows landed in
--   operational_alert_events (fn_ca_guard_defs_watch and
--   drift_incident:fn_ca_guard_defs_watch). The live definition is exactly the
--   declared postimage (md5 b5025fd1... read 2026-10-15 18:20 UTC). Nothing
--   was wrong except the watch.
--
--   This is the same shape four earlier migrations had to repair by hand
--   (20260921003008, 20260921022420, 20260921035446 and the declaration in
--   20261012181905): a reviewed install that forgot the declaration call is
--   read as an undeclared redefinition.
--
-- THE CAUSE, at the line: fn_ca_guard_defs_watch treats every hash that is not
-- the stored baseline as undeclared (`ELSIF v_stored <> v_hash THEN` raises
-- unconditionally). The only declaration it can see is a baseline moved by
-- fn_ca_declare_guard_redefinition in the installing transaction.
--
-- THE FIX: before raising, the watch asks whether an INSTALLED migration
-- declared this exact end state, by its "-- @live-proof:" line carrying the new
-- md5 (supabase_migrations.schema_migrations.statements keeps every installed
-- migration's text). If one did, the baseline moves naming it
-- (declared_ref = 'migration <version> (@live-proof)'), an older open notice
-- for that guard is superseded, and nothing is raised. Only the @live-proof
-- line counts: it is the declared END state, so a migration that merely
-- mentions a hash (a preimage it moved away from) declares nothing, and a
-- rollback to an old text is still raised. A redefinition no installed
-- migration declares (a hand edit, an unreviewed CREATE OR REPLACE) is raised
-- exactly as loudly as before. The extra read runs only when a hash moved:
-- 2.7 ms when declared, 175 ms worst case across all 5,874 installed migrations
-- (measured read-only on production).
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (eed0ea56...), each of the three
-- anchors must occur exactly once (measured read-only on production: 1,1,1),
-- and the result must hash to the postimage derived read-only on production
-- with replace() (c39d324b...). Owner, SECURITY DEFINER, proconfig and grants
-- must not move. The watch is itself a watched guard, so this migration also
-- declares its own redefinition through fn_ca_declare_guard_redefinition.
--
-- Regression: scripts/ci/test-guard-watch-declared-install.py (native
-- PostgreSQL), run by .github/workflows/guard-watch-declared-install.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_guard_defs_watch()'::regprocedure)) = 'c39d324b3677d55feceb4522d67cc590')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_guard_watch_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_guard_watch_subst(
  'public.fn_ca_guard_defs_watch()',
  'eed0ea56a08ecefdf538ebba2318b600', 'c39d324b3677d55feceb4522d67cc590',
  ARRAY[$wo0$  v_def text; v_old_id bigint; v_new_id bigint;
$wo0$,
        $wo1$    SELECT def_hash INTO v_stored FROM public.ca_guard_defs WHERE proname = v_name;
$wo1$,
        $wo2$    ELSIF v_stored <> v_hash THEN
      v_changes := v_changes + 1;
$wo2$],
  ARRAY[$wn0$  v_def text; v_old_id bigint; v_new_id bigint; v_declared text;
$wn0$,
        $wn1$    SELECT def_hash INTO v_stored FROM public.ca_guard_defs WHERE proname = v_name;

    -- A DECLARED INSTALL IS NOT A REVIEW NOTICE (2026-10-15). An installed
    -- migration whose "-- @live-proof:" line pins this exact postimage md5 is
    -- the redefinition's review record: it was written, reviewed and
    -- installed on purpose. Raising an open notice for it put a row in front
    -- of the alert fleet for every declared install (fn_ca_raise_drift_incident,
    -- 2026-10-15 17:25 UTC, migration 20261015024752). Only the @live-proof
    -- line counts, because it names the END state; a migration that merely
    -- mentions a hash (a pinned preimage it moved away from) declares nothing.
    -- A redefinition no installed migration declares is still a notice.
    v_declared := NULL;
    IF v_stored IS NOT NULL AND v_stored <> v_hash THEN
      SELECT m.version INTO v_declared
        FROM supabase_migrations.schema_migrations m
       WHERE EXISTS (
               SELECT 1 FROM unnest(m.statements) s
                WHERE strpos(s, v_hash) > 0
                  AND EXISTS (SELECT 1 FROM regexp_split_to_table(s, E'\n') ln
                               WHERE ln LIKE '-- @live-proof:%'
                                 AND strpos(ln, v_hash) > 0))
       ORDER BY m.version DESC
       LIMIT 1;
    END IF;
$wn1$,
        $wn2$    ELSIF v_declared IS NOT NULL THEN
      -- Declared: the baseline moves, naming the migration that declared it
      -- (as fn_ca_declare_guard_redefinition would have), an older open
      -- notice for this guard is superseded, and no new notice is raised.
      UPDATE public.ca_drift_incidents
         SET status = 'resolved', resolved_at = now(),
             resolution = 'superseded: ' || v_name || ' was redefined by declared migration ' || v_declared
       WHERE source = 'fn_ca_guard_defs_watch'
         AND status <> 'resolved'
         AND dedupe_key LIKE 'guard-def-drift:' || v_name || ':%';
      UPDATE public.ca_guard_defs
         SET def_hash = v_hash, updated_at = now(),
             declared_ref = 'migration ' || v_declared || ' (@live-proof)', declared_at = now()
       WHERE proname = v_name;
    ELSIF v_stored <> v_hash THEN
      v_changes := v_changes + 1;
$wn2$]
);

-- The watch is on its own watchlist: declare this redefinition in the same
-- transaction, so the baseline names this migration.
SELECT public.fn_ca_declare_guard_redefinition(
  'fn_ca_guard_defs_watch',
  'migration 20261015181950_a_declared_guard_install_is_not_a_review_notice'
);

COMMIT;
