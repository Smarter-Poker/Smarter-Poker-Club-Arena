-- RESTORE SETTLEMENT ROUNDS 2 AND 3. THEY WERE DELETED, NOT LOST.
--
-- fn_settle_round2_club_to_agents and fn_settle_round3_agents_to_players — the
-- club-pays-agents and agents-pay-players halves of the weekly settlement
-- cascade — had been 315-character stubs since 2026-08-26 14:00. Their whole
-- body was:
--
--     RAISE EXCEPTION 'fn_settle_round2_club_to_agents original body was lost
--                      due to prior agent destruction. Rebuild required.';
--
-- HOW THEY WERE DESTROYED — by the migration trying to protect them.
-- 20260826140030_proper_settlement_locks.sql adds the GLOBAL_SETTLEMENT_FREEZE
-- check to every settlement entry point. For Round 1 its author found the
-- original body and preserved it; the file says so: "Original body retrieved
-- from 20260819_fn_union_weekly_rakeback_close.sql". For these two they could
-- not find it, and wrote a CREATE OR REPLACE with a RAISE in place of the body.
--
-- CREATE OR REPLACE with a stub body is not a note-to-self. It is a delete.
-- Working money functions were replaced with exceptions because their source
-- could not be located, turning "I cannot find this" into "this no longer
-- exists".
--
-- THEY WERE ALWAYS RECOVERABLE. Both bodies were in
-- supabase_migrations.schema_migrations the whole time:
--
--   fn_settle_round2_club_to_agents     20260820171822 round2_idempotency_settled_at
--   fn_settle_round3_agents_to_players  20260820160547 union_law_c1b_round3_correct_paid_columns
--
-- This restores them verbatim from those rows — carving the CREATE statement
-- out of the archived migration text, since the stored text is a whole file and
-- can carry BEGIN;/COMMIT; that EXECUTE cannot run — and re-inserts the
-- GLOBAL_SETTLEMENT_FREEZE check at the top of each body, so the protection the
-- destroying migration was adding is kept. Nothing invented, nothing retyped.
--
-- THE FREEZE STAYS ON. THIS PAYS NOBODY. settlement_locks has an ACTIVE
-- GLOBAL_SETTLEMENT_FREEZE on all three clubs, set 2026-08-26 13:38:56, reason
-- "EMERGENCY: PROFIT DRIFT INVESTIGATION", unlock_at 2099-01-01. That was a
-- deliberate emergency action twenty minutes before the destruction, and
-- lifting it is not an agent's call. The cascade still refuses on the next line.
--
-- What changes is that the capability EXISTS again. Before this, unfreezing
-- would have produced a cascade whose rounds 2 and 3 raise "Rebuild required" —
-- the freeze was masking the fact that player rakeback could not be paid even
-- if it were lifted. Verified by probe (rolled back): with the freeze lifted
-- inside the transaction, fn_union_settlement_cascade_all() returns
-- success:true and completes all four rounds, issuing weekly invoices.
--
-- fn_finalize_settlement_period is DELIBERATELY NOT restored. Its archived body
-- (20260420011713) declares a different signature from the live stub, so
-- applying it would leave the stub in place and add a competing overload. A
-- probe caught exactly that and refused. It needs its signature reconciled by
-- hand. Likewise fn_run_pending_rakeback_settlement(): the no-argument overload
-- is a stub, but the fn_run_pending_rakeback_settlement(p_max_clubs integer)
-- overload is intact and is what callers use.
--
-- ROLLBACK
--   Re-apply the stub bodies from 20260826140030_proper_settlement_locks.sql.

DO $mig$
DECLARE
  r record; v_stmt text; v_rest text; v_delim text; v_create text;
  p1 int; p2 int; dl int;
  v_def text; v_new text; v_pos int; v_bpos int; v_lock text;
BEGIN
  v_lock := E'\n  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = ''GLOBAL_SETTLEMENT_FREEZE'' AND is_active = true) THEN\n    RAISE EXCEPTION ''EMERGENCY_PROFIT_DRIFT_LOCK'';\n  END IF;\n';

  FOR r IN SELECT * FROM (VALUES
      ('fn_settle_round2_club_to_agents',   '20260820171822'),
      ('fn_settle_round3_agents_to_players','20260820160547')
    ) AS t(fname, ver)
  LOOP
    DECLARE v_target oid;
    BEGIN
      -- Pin the exact stub we intend to replace, by oid, so a signature
      -- mismatch cannot quietly create a second overload and leave the stub.
      SELECT p.oid INTO v_target
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = r.fname
         AND p.prosrc LIKE '%original body was lost%';
      IF v_target IS NULL THEN
        RAISE EXCEPTION 'no stub found for % - already restored?', r.fname;
      END IF;

      SELECT s.stmt INTO v_stmt
        FROM supabase_migrations.schema_migrations m,
             LATERAL unnest(m.statements) AS s(stmt)
       WHERE m.version = r.ver AND s.stmt LIKE '%' || r.fname || '%'
         AND s.stmt ~* 'CREATE\s+OR\s+REPLACE\s+FUNCTION'
         AND s.stmt NOT LIKE '%original body was lost%'
       LIMIT 1;
      IF v_stmt IS NULL THEN
        RAISE EXCEPTION 'no archived body for % in %', r.fname, r.ver;
      END IF;

      v_rest  := substr(v_stmt, position('CREATE OR REPLACE FUNCTION' IN v_stmt));
      v_delim := (regexp_match(v_rest, 'AS (\$[A-Za-z_]*\$)'))[1];
      dl := length(v_delim);
      p1 := position(v_delim IN v_rest);
      p2 := position(v_delim IN substr(v_rest, p1 + dl));
      IF v_delim IS NULL OR p1 = 0 OR p2 = 0 THEN
        RAISE EXCEPTION 'could not carve the CREATE statement for %', r.fname;
      END IF;
      v_create := substr(v_rest, 1, p1 + dl + p2 + dl - 2);

      EXECUTE v_create;

      IF (SELECT prosrc LIKE '%original body was lost%' FROM pg_proc WHERE oid = v_target) THEN
        RAISE EXCEPTION 'archived body for % did not replace the stub (signature drift)', r.fname;
      END IF;

      v_def  := pg_get_functiondef(v_target);
      v_pos  := position('AS $function$' IN v_def);
      v_bpos := position(E'\nBEGIN\n' IN substr(v_def, v_pos));
      IF v_pos = 0 OR v_bpos = 0 THEN
        RAISE EXCEPTION 'could not locate body BEGIN for %', r.fname;
      END IF;
      v_new := overlay(v_def placing (E'\nBEGIN\n' || v_lock)
                       from v_pos + v_bpos - 1 for length(E'\nBEGIN\n'));
      EXECUTE v_new;
    END;
  END LOOP;
END
$mig$;

DO $post$
DECLARE r record; v_def text; v_n int;
BEGIN
  FOR r IN SELECT unnest(ARRAY['fn_settle_round2_club_to_agents',
                               'fn_settle_round3_agents_to_players']) AS fname
  LOOP
    SELECT p.prosrc, length(p.prosrc) INTO v_def, v_n
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname
     ORDER BY length(p.prosrc) DESC LIMIT 1;

    IF v_def LIKE '%original body was lost%' THEN
      RAISE EXCEPTION '% is still a stub', r.fname;
    END IF;
    -- The stubs were ~315 characters. A real body is an order of magnitude
    -- bigger; anything near the stub size means the restore did not take.
    IF v_n < 1000 THEN
      RAISE EXCEPTION '% restored to only % chars - that is not the real body', r.fname, v_n;
    END IF;
    IF position('EMERGENCY_PROFIT_DRIFT_LOCK' IN v_def) = 0 THEN
      RAISE EXCEPTION '% lost its settlement freeze check', r.fname;
    END IF;
  END LOOP;

  -- Restoring capability must not have unfrozen anything.
  IF NOT EXISTS (SELECT 1 FROM public.settlement_locks
                  WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'the GLOBAL_SETTLEMENT_FREEZE is no longer active; this migration must not have lifted it';
  END IF;
END
$post$;
