-- 20261002145612_the_jackpot_lifetime_counts_a_pool_the_meter_has_not_opened_yet
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 14:56:12 UTC.
--
-- @live-proof: (SELECT position('LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0 AND position('o.opened_at IS NOT NULL AND l.created_at <= o.opened_at' IN pg_get_functiondef('public.fn_bbj_conservation_check()'::regprocedure)) > 0)
--
-- WHAT WAS WRONG. 20261002135140 (incident f3e82f59) put the journalled
-- welcome seeds and burns of a pool opened after the 2026-09-04 epoch into the
-- lifetime identity, but it found those pools through their meter baseline.
-- A pool the hourly meter has not opened yet has no baseline, so for up to an
-- hour after a club is created its 100.00 seed was balance with no inflow:
-- measured at 14:47 UTC, lifetime.moved_since_resolution -100.00 and
-- lifetime_healthy false, from pool 2032add6 (created 14:42:20, seeded 100.00,
-- no baseline). The epoch verdict was already right for such a pool (no
-- baseline, so the global window counts its seed once against an opening of
-- 0.00) and is unchanged.
--
-- WHAT THIS CHANGES. Only fn_bbj_conservation_check, by text replacement of
-- the 20261002135140 body (pre-image md5 b1fb89dc98aaad152bd5b2085b88bbfa):
--   * the later-opened set is every bbj_pools row whose opening - its baseline
--     if the meter has opened it, else its created_at - is after the epoch;
--   * only a pool WITH a baseline gives legs back to the epoch residue
--     (o.opened_at IS NOT NULL), so the epoch figure is identical.
-- Original pools (created before the epoch) are still excluded, so a seed or a
-- burn on one of those stays unexplained. Nothing credited, written off,
-- rebaselined or moved.
--
-- Probe (read-only, compiled into pg_temp, self-aborting) at 14:49 UTC:
-- healthy true, epoch moved_since_recorded 0.00 (unexplained -9.82, the
-- recorded residue), absorbed 5,100.00; lifetime_healthy true,
-- moved_since_resolution 0.00 (unexplained 45.80, the recorded residue),
-- journalled seeds 5,400.00, burns 5,200.00. Asserted again below at apply.

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '240s';

DO $mig$
DECLARE
  v_src text; v_new text; v_md5 text; v_owner text; v_secdef boolean; v_cfg text[]; v_vol "char";
  v_res jsonb; v_anchor text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), r.rolname, p.prosecdef, p.proconfig, p.provolatile
    INTO v_src, v_md5, v_owner, v_secdef, v_cfg, v_vol
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b1fb89dc98aaad152bd5b2085b88bbfa' THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check is not the 20261002135140 body (md5 %)', v_md5;
  END IF;

  v_anchor := $a$    FROM (SELECT s.pool_id, min(s.taken_at) AS opened_at
            FROM public.ca_bbj_pool_snapshots s
           WHERE s.is_baseline
           GROUP BY s.pool_id
          HAVING min(s.taken_at) > v_epoch_at) o$a$;
  IF position(v_anchor IN v_src) = 0 THEN RAISE EXCEPTION 'anchor A (later-opened set) not found'; END IF;
  v_new := replace(v_src, v_anchor, $a$    FROM (SELECT p.id AS pool_id, b.opened_at
            FROM public.bbj_pools p
            LEFT JOIN (SELECT s.pool_id, min(s.taken_at) AS opened_at
                         FROM public.ca_bbj_pool_snapshots s
                        WHERE s.is_baseline
                        GROUP BY s.pool_id) b ON b.pool_id = p.id
           WHERE COALESCE(b.opened_at, p.created_at) > v_epoch_at) o$a$);

  v_anchor := $a$        COALESCE(sum(CASE WHEN l.created_at <= o.opened_at$a$;
  IF position(v_anchor IN v_new) = 0 THEN RAISE EXCEPTION 'anchor B (absorbed window) not found'; END IF;
  v_new := replace(v_new, v_anchor, $a$        COALESCE(sum(CASE WHEN o.opened_at IS NOT NULL AND l.created_at <= o.opened_at$a$);

  EXECUTE v_new;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = 'public.fn_bbj_conservation_check()'::regprocedure
                    AND r.rolname = v_owner AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg AND p.provolatile = v_vol
                    AND md5(pg_get_functiondef(p.oid)) <> v_md5) THEN
    RAISE EXCEPTION 'fn_bbj_conservation_check post-image is not the pre-image with only its body changed';
  END IF;

  v_res := public.fn_bbj_conservation_check();
  IF COALESCE((v_res->>'healthy')::boolean, false) IS NOT TRUE
     OR abs((v_res->'epoch'->>'moved_since_recorded')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'the epoch verdict moved: %', v_res->'epoch';
  END IF;
  IF COALESCE((v_res->>'lifetime_healthy')::boolean, false) IS NOT TRUE
     OR abs((v_res->'lifetime'->>'moved_since_resolution')::numeric) > 1.00 THEN
    RAISE EXCEPTION 'the lifetime identity still moved: %', v_res->'lifetime';
  END IF;

  UPDATE public.bbj_conservation_baseline
     SET note = note || E'\n\nUNOPENED POOLS 2026-10-02. A pool created after the epoch that the meter has not opened yet is inside the lifetime identity from its creation, not from its first baseline; until then its 100.00 seed read as -100.00 lifetime. Epoch figure unchanged. Nothing credited, written off or rebaselined.'
   WHERE id = 1;
END
$mig$;

COMMIT;
