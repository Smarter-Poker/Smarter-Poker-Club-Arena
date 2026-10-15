-- 20261015094435_the_satellite_board_never_blocks_a_feeder_s_foreign_key_chec.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE SATELLITE BOARD NEVER BLOCKS A FEEDER'S FOREIGN KEY CHECK (2026-10-15)
--
-- The deadlock, read from postgres_logs (2026-10-15 01:26, 02:14, 02:45,
-- 02:50, 06:28 x2, 07:17, 07:19, 07:21, 07:22, 08:44, 08:48 UTC; 40P01):
--   fn_register_horse_for_tournament -> ..._before_maintenance_gate line 231
--     "UPDATE public.tournaments SET current_players = ... WHERE id = <feeder>"
--     -> RI check "SELECT 1 FROM ONLY tournaments x WHERE id = $1 FOR KEY SHARE"
--   against fn_ensure_scheduled_mtt_satellite, waiting at its feeder lock
--     "SELECT * FROM public.tournaments t WHERE ... ORDER BY ... FOR UPDATE".
--
-- The cycle:
--   registration  locks the satellite (feeder) row FOR UPDATE (line 38); the
--                 roster insert's trg_sync_tournament_current_players updates
--                 that row, so the explicit UPDATE that follows changes a row
--                 version this transaction wrote, and PostgreSQL re-checks
--                 tournaments_satellite_target_id_fkey: FOR KEY SHARE on the
--                 TARGET row;
--   board         locks the TARGET row FOR UPDATE, then waits for the feeder.
-- FOR UPDATE is the one row lock that refuses FOR KEY SHARE. The board takes
-- it only to hold the target still while it reads and decides; it never
-- deletes the target or changes its key.
--
-- The fix: the board locks the target FOR NO KEY UPDATE. That still refuses
-- every other writer and every other FOR UPDATE / NO KEY UPDATE locker of the
-- target (no status, start time, price or finalisation can change under the
-- board), and it no longer refuses a foreign-key check from a row that points
-- at the target. The registration's check passes, the registration commits,
-- and the board then takes the feeder. Nothing registered, charged or created
-- changes.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545
-- (live md5 read on production 2026-10-15; postimage derived read-only on
-- production with replace(); owner, SECURITY DEFINER, proconfig and grants
-- must not move).
--
-- Regression: scripts/ci/test-deadlock-lock-orders-r5.py (native PostgreSQL,
-- two sessions), run by .github/workflows/deadlock-lock-orders-r5.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ensure_scheduled_mtt_satellite(jsonb)'::regprocedure)) = '7d2692a9dd3ba29538636bb35029ace0')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_lock_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_lock_subst(
  'public.fn_ensure_scheduled_mtt_satellite(jsonb)',
  '1760f4d9077253a29ed4243f0d16717b', '7d2692a9dd3ba29538636bb35029ace0',
  ARRAY[$o1$ SELECT * INTO v_target FROM public.tournaments WHERE id=v_row.satellite_target_id FOR UPDATE;
$o1$],
  ARRAY[$n1$ -- NO KEY UPDATE, not UPDATE (20261015094435): a feeder registration
 -- re-checks its satellite_target_id foreign key (FOR KEY SHARE on this row)
 -- while it holds the feeder this board locks next. FOR UPDATE refused that
 -- check and closed a cycle; NO KEY UPDATE still refuses every writer.
 SELECT * INTO v_target FROM public.tournaments WHERE id=v_row.satellite_target_id FOR NO KEY UPDATE;
$n1$]
);

COMMIT;
