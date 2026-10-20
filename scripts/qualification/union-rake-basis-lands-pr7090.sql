-- 20261016104931_the_open_week_basis_stamps_its_own_unions_clubs
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16 10:49:31 UTC.
--
-- THE OPEN-WEEK BASIS STAMPS ITS OWN UNION'S CLUBS (2026-10-16)
--
-- What fired. financial_alerts fn_union_rake_basis_refresh, kind out_of_time,
-- Midway Union, 02:35 UTC on 2026-10-16: "Refreshing the open-week rake basis
-- snapshot ran out of the sweep's time; the money controls committed and the
-- snapshot keeps its previous refresh". It is filed once while open, so the
-- later hours were silent: the union-integrity-sweep cron (jobid 123) ran into
-- its 300 s statement timeout at 02:35, 07:35, 08:35 and 09:35, and Midway
-- Union's open-week union_rake_basis_snapshot was last written on 2026-10-15
-- at 17:35.
--
-- The cause, read from rows. fn_union_rake_basis_windowed keeps each closed
-- two-hour window in union_rake_basis_windows and reuses it while its
-- input_stamp is unchanged. Part of that stamp is
-- fn_accounting_clubs_scope_digest(), an md5 over EVERY row of public.clubs.
-- Certification fixtures create and remove clubs all day (148 club opening
-- grants in the 24 hours to 10:50; clubs created at 10:35 and 10:48, none in a
-- union), so the digest stored with the windows at 10:36 (3f94d8d5...) had
-- moved by 10:50 (5cc45e8c...) and again by 10:52 (3b7f7a58...), while the
-- digest of Midway Union's own four clubs did not. Every hour every one of the
-- week's 44 closed windows was therefore stale and recomputed (373 s of
-- compute at 10:36), the refresh could not finish inside the sweep, and the
-- reuse the 20261003 design depends on never happened.
--
-- The money is right. The snapshot is a reporting read; the money controls
-- committed every hour and nothing settles from this table. Not caused by an
-- r5 install: the digest has read every club since 20261003, and the cost grew
-- with the week and the certification churn.
--
-- The line. The window stamp digests this union's clubs (the union's own row
-- and every club whose union_id is this union), the same columns in the same
-- order. A club joining or leaving the union, or changing is_union, still
-- moves the stamp; a club created anywhere else does not.
-- fn_calculate_cash_rakeback_periods keeps the platform digest; it is not
-- touched.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545 and
-- 20261015222121. The live text must hash to the md5 measured on production on
-- 2026-10-16 (2c2bbb25...), the anchor must occur exactly once, and the
-- result must hash to the postimage derived read-only on production with
-- replace() (a68ecf97...); owner, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-the-open-week-basis-stamps-its-own-unions-clubs.py
-- (native PostgreSQL), run by
-- .github/workflows/the-open-week-basis-stamps-its-own-unions-clubs.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_rake_basis_windowed(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) = 'a68ecf97f457970970e97518d378e70c')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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
  'public.fn_union_rake_basis_windowed(uuid,timestamp with time zone,timestamp with time zone)',
  '2c2bbb252ef5d119bc6e9813bcc9354b', 'a68ecf97f457970970e97518d378e70c',
  ARRAY[$o$ digest:=public.fn_accounting_clubs_scope_digest();
$o$],
  ARRAY[$n$ -- THE UNION'S OWN CLUBS, NOT EVERY CLUB (2026-10-16). A window's basis
 -- reads only this union's clubs, but the stamp digested every club on the
 -- platform, so each certification club created or removed anywhere (148
 -- opening grants in the 24 hours to 10:50 UTC) invalidated every closed
 -- window of every union, the whole open week was recomputed each hour, and
 -- the refresh ran out of the sweep's time. A club joining or leaving this
 -- union still changes the stamp.
 digest:=(SELECT md5(COALESCE(string_agg(c.id::text||'|'||COALESCE(c.is_union::text,'null')||'|'||COALESCE(c.union_id::text,'null'),',' ORDER BY c.id),''))
            FROM public.clubs c WHERE c.union_id=p_union_id OR c.id=p_union_id);
$n$]
);

COMMIT;
