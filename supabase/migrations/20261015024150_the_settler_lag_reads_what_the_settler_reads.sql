-- 20261015024150_the_settler_lag_reads_what_the_settler_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SETTLER LAG READS WHAT THE SETTLER READS (2026-10-15)
--
-- fn_settler_lag_check() is read by three callers: fn_ca_conservation_sweep
-- (fn_ca_conservation_sweep:fn_settler_lag_check), the hourly
-- fn_ca_settlement_correctness_check (settler_lag) and
-- fn_union_treasury_selftest (rakeback_settler_lagging). On 2026-10-15 those
-- classes held 76 + 40 + 16 open alert rows, 45 of them in one day, and not
-- one of them was a settler that had stopped. Read from rows:
--
--   1. AN IDLE SETTLER HAS NOTHING TO SAVE. RakebackSettlerService returns
--      'idle' and leaves its cursor and daemon_state.updated_at alone when no
--      row is waiting. No rake_records row was written between 2026-10-13
--      19:17:37 and 2026-10-14 23:04:06 UTC (the floor was dark), so the
--      cursor stayed at 19:17:37 and lag_hours = now() - cursor climbed past 6
--      with backlog_rows 0. The check called that unhealthy every hour
--      (lag_hours 27.57, last_save_hours_ago 27.43, backlog_rows 0).
--   2. THE FIRST HAND AFTER A QUIET SPELL IS NOT A STALL. At 2026-10-14 23:15,
--      eleven minutes after play resumed, 1,545 fresh rows sat above the
--      cursor and the last save was 1,669 minutes old, so stalled = (stale >
--      45 min AND backlog > 0) was true although the oldest waiting row was
--      eleven minutes old and the next 30-minute cycle drained it.
--   3. THE SETTLER NEVER READS A NON-POSITIVE ROW. It pages rake_records
--      WHERE rake_amount > 0 (RakebackSettlerService .gt('rake_amount', 0)).
--      The 853 rake reversals written 2026-10-13 16:10 to 16:17 (sum -1,351.85,
--      none positive) can never move its cursor, yet the check counted them as
--      backlog, and fn_union_treasury_selftest filed
--      "rakeback_settler_lagging" (lag 3.74 h, backlog 853) at 17:01.
--
-- THE FIX, in the one function all three callers read: the backlog is the
-- rows the settler will read (rake_amount > 0, above the (created_at, id)
-- keyset cursor, exactly its own page predicate), and the lag is the age of
-- the OLDEST such row, not the age of the cursor. A stall is a row the settler
-- reads that has waited longer than the grace (one 30-minute interval plus the
-- maintenance freeze). An idle settler (no such row) is healthy whatever the
-- cursor's age; a settler that skips a cycle while a positive row waits is
-- still found, and a week blocked by unaccrued cash rake is untouched. The
-- cursor's own age stays visible as cursor_age_hours, and the oldest waiting
-- row as oldest_pending_at. The read is bounded and uses the created_at index
-- (measured on production 2026-10-15: 10 ms for 1,537 rows, 21 ms for 5,000).
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured md5 (5cdd53e0...), each of the five
-- anchors must occur exactly once, and the result must hash to the postimage
-- derived read-only on production with replace(); owner, SECURITY DEFINER,
-- STABLE, proconfig and grants must not move. Nothing here writes a row.
--
-- Regression: scripts/ci/test-settler-lag-reads-what-the-settler-reads.py
-- (native PostgreSQL), run by
-- .github/workflows/settler-lag-reads-what-the-settler-reads.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settler_lag_check()'::regprocedure)) = '84bf7dc6f8cb3fedcf0146ac2927075f')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_settler_lag_subst(p_sig text, p_before text, p_after text,
                                             p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
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

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.provolatile
    INTO v_acl, v_owner, v_secdef, v_cfg, v_vol
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
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg
                    AND p.provolatile = v_vol) THEN
    RAISE EXCEPTION '%: owner, security, volatility, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_settler_lag_subst(
  'public.fn_settler_lag_check()',
  '5cdd53e06cc8dbbc843b99fdbc2ff7db', '84bf7dc6f8cb3fedcf0146ac2927075f',
  ARRAY[$o1$  v_stalled    boolean;
BEGIN$o1$,
        $o2$  v_lag_h   := round(EXTRACT(epoch FROM (now() - v_cursor)) / 3600.0, 2);$o2$,
        $o3$  -- Bounded on purpose: the verdict needs to know that backlog exists and
  -- roughly how much, never the exact depth of a days-old hole.
  SELECT count(*) INTO v_backlog
    FROM (SELECT 1 FROM rake_records WHERE created_at > v_cursor LIMIT 5000) s;$o3$,
        $o4$  -- A stall is a cursor that has not moved for materially longer than one
  -- interval WHILE there is work above it. Either half alone is ordinary: an
  -- idle table gives the settler nothing to save, and a fresh backlog just
  -- means the drain is mid-cycle.
  v_stalled := (v_stale_m > c_grace_m AND v_backlog > 0);$o4$,
        $o5$    'cursor',                  v_cursor,$o5$],
  ARRAY[$n1$  v_stalled    boolean;
  v_oldest     timestamptz;
  v_cursor_age_h numeric;
BEGIN$n1$,
        $n2$  v_cursor_age_h := round(EXTRACT(epoch FROM (now() - v_cursor)) / 3600.0, 2);$n2$,
        $n3$  -- THE BACKLOG IS WHAT THE SETTLER READS (2026-10-15). The settler pages
  -- rake_records WHERE rake_amount > 0 by the keyset (created_at, id) and,
  -- with nothing to read, leaves its cursor and updated_at alone. So the
  -- backlog is the positive rows above that keyset (a reversal it never reads
  -- is not work), and the lag is the age of the OLDEST of them: an idle
  -- settler has no lag however old its cursor is. Bounded on purpose: the
  -- verdict needs to know that backlog exists and roughly how much, never
  -- the exact depth of a days-old hole.
  SELECT count(*), min(s.created_at) INTO v_backlog, v_oldest
    FROM (SELECT rr.created_at
            FROM rake_records rr
           WHERE rr.rake_amount > 0
             AND rr.created_at >= v_cursor
             AND (rr.created_at > v_cursor
                  OR (rr.created_at = v_cursor
                      AND v_cursor_id IS NOT NULL AND rr.id > v_cursor_id))
           ORDER BY rr.created_at, rr.id
           LIMIT 5000) s;
  v_lag_h := COALESCE(round(EXTRACT(epoch FROM (now() - v_oldest)) / 3600.0, 2), 0);$n3$,
        $n4$  -- A stall is a row the settler reads that has waited longer than one
  -- interval plus the freeze. The cursor's age alone is not one (an idle
  -- floor gives the settler nothing to save), and neither is a backlog that
  -- arrived after a quiet spell and is younger than the grace.
  v_stalled := v_oldest IS NOT NULL
    AND v_oldest < now() - make_interval(mins => c_grace_m::integer);$n4$,
        $n5$    'cursor',                  v_cursor,
    'cursor_age_hours',        v_cursor_age_h,
    'oldest_pending_at',       v_oldest,$n5$]
);

COMMIT;
