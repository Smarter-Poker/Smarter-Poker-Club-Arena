-- 20261031212432_release_drained_predecessor_witness.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The release transaction may now replace engine eed06fe5 without its
-- full-heap legacy census, but only at a DRAINED HAND BOUNDARY (owner,
-- 2026-10-31; docs/changelog/2026-10-31-eed-cutover-at-a-drained-hand-boundary.md).
-- The engine's strict restart certificate covers every REGISTERED running
-- table. This read-only witness is the database half: it says whether any
-- tournament hand is still MOVING anywhere in the process (registered or not),
-- and whether any Lightning hand formed in the window is still unsettled.
--
-- MOVEMENT, NOT EXISTENCE. Measured on production 2026-10-31 21:25 UTC, every
-- open smarter_private.hand_continuations row belongs to a reserved permit
-- (272 of 272), and their ages were: <60s 165, 60-120s 9, 120-300s 0,
-- 300-600s 27, 600-1200s 75. The old rows sit on stalled tournament tables
-- (19 of the 20 stalled tables /health lists, many "Diamond Tournaments Are
-- Not Open"), are durable, and are resumed by the successor from this very
-- table. Gating on "no open continuation" would therefore refuse every cutover
-- for ever (CLAUDE.md 10.86 rule 4). A hand in flight is one whose row is
-- still being WRITTEN; the 120-300s band was empty, so the 120s window used by
-- engine-release-inflight-hands.py for hand_state_snapshots applies here too.
--
-- LIGHTNING. Unsettled public.lightning_hand rows by age at the same moment:
-- <60s 45, 60-120s 1, 120-300s 1, 300-600s 0, 600-3600s 3, 1h-1d 528, >1d 185.
-- Live hands settle within a minute; the hours-old rows are not live. The
-- release holds every Cluster at the announcement, so a row formed in the last
-- 600s that is still unsettled is a hand that may still be in the air.
--
-- Read-only, STABLE, SECURITY DEFINER, service_role only. It writes nothing,
-- takes no lock beyond ordinary reads, and creates one function: one
-- transaction, no hot-table lock, so it does not need the daily window.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_release_drained_predecessor_witness(
  p_moving_window_seconds integer DEFAULT 120,
  p_lightning_window_seconds integer DEFAULT 600
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private
AS $fn$
DECLARE
  -- Transaction time, so the formed_at index is usable (one-statement call).
  v_now timestamptz := now();
  v_reserved bigint;
  v_open bigint;
  v_moving bigint;
  v_lightning bigint;
BEGIN
  IF p_moving_window_seconds IS NULL OR p_moving_window_seconds < 30 OR p_moving_window_seconds > 600
     OR p_lightning_window_seconds IS NULL OR p_lightning_window_seconds < 120 OR p_lightning_window_seconds > 1800 THEN
    RAISE EXCEPTION 'DRAINED_WITNESS_WINDOW_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_reserved FROM smarter_private.f06_hand_permits WHERE state = 'reserved';
  SELECT count(*), count(*) FILTER (WHERE updated_at >= v_now - make_interval(secs => p_moving_window_seconds))
    INTO v_open, v_moving
    FROM smarter_private.hand_continuations;
  SELECT count(*) INTO v_lightning
    FROM public.lightning_hand
   WHERE formed_at >= v_now - make_interval(secs => p_lightning_window_seconds)
     AND settled_at IS NULL;

  RETURN jsonb_build_object(
    'contract', 'drained-predecessor-witness-v1',
    'observed_at', v_now,
    'moving_window_seconds', p_moving_window_seconds,
    'lightning_window_seconds', p_lightning_window_seconds,
    'reserved_tournament_permits', v_reserved,
    'retained_tournament_hands', v_open,
    'moving_tournament_hands', v_moving,
    'unsettled_recent_lightning_hands', v_lightning
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_ca_release_drained_predecessor_witness(integer, integer) IS
  'Read-only release witness for an eed06fe5 replacement at a drained hand boundary: moving tournament hands and recently formed unsettled Lightning hands must both be zero. See docs/changelog/2026-10-31-eed-cutover-at-a-drained-hand-boundary.md.';

REVOKE ALL ON FUNCTION public.fn_ca_release_drained_predecessor_witness(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_release_drained_predecessor_witness(integer, integer) TO service_role;

COMMIT;
