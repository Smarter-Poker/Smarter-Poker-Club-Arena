-- 20260920234647_lightning_phase_1_remediation_the_lobby_reads_one_lightning_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- LIGHTNING 2.0 PHASE 1 REMEDIATION. An adversarial audit of the merged Phase 1
-- delivery (20260920172736, PR4976) found three real defects. This repairs all
-- three. It adds no new Lightning capability and does not begin Phase 2.
--
-- DEFECT 1: THE BACKFILL STAMPED HISTORY IT COULD NOT KNOW.
--
-- The Phase 1 backfill carried no closed_at predicate, so it wrote cluster_id
-- onto every session whose table has a cluster, open or closed. The assignment
-- was narrower: Phase 0 said "account for currently OPEN table-scoped
-- sessions", and the column comment says cluster_id is the Cluster the session
-- "belongs to".
--
-- Measured on production before this migration: 985 sessions that had already
-- CLOSED were stamped with a Cluster that did not exist while they were alive.
-- The earliest such session closed 2026-09-04 12:12:17 UTC; the earliest
-- cluster was created 2026-09-05 03:55:59 UTC. The cause is that the only
-- writer of tables.cluster_id for an already-existing table was the one-shot
-- adoption block in 20260905034937_gate_7_every_cash_table_is_a_game.sql, so a
-- table adopted on the 5th retroactively claimed every session it ever held.
--
-- Nothing reads it today - every consumer looks at open sessions - so there is
-- no live impact. But "one player has one continuous cash identity per Cluster"
-- is exactly the history query later phases will run, and it would have
-- returned 985 wrong answers. A closed session at a table that was ALREADY in
-- the cluster is correctly attributed and is left alone; only the retroactive
-- ones are cleared.
--
-- DEFECT 2: THE READER WAS SECURITY DEFINER FOR NO REASON.
--
-- fn_cash_cluster_lightning_state reads cash_games and cash_player_session and
-- is granted to service_role alone, which already carries BYPASSRLS. So
-- SECURITY DEFINER bought nothing and cost real surface: cash_player_session
-- has RLS enabled with ZERO policies and no grant to authenticated, meaning it
-- is completely unreadable by clients today. A later migration that granted
-- EXECUTE on this function to authenticated - a one-line mistake the estate
-- already runs a CI check for - would have handed clients a session census
-- straight through that lockdown. As SECURITY INVOKER the same mistake yields
-- nothing, because the caller's own (absent) privileges apply.
--
-- DEFECT 3: THE READER HAD NO CALLER.
--
-- Phase 1 created one authoritative reader so that later phases would not each
-- grow a slightly different idea of what mode a Cluster is in, and then called
-- it from nowhere. A reader nothing reads is a reader nothing constrains. The
-- Must Move lobby is the one surface that already answers "what is this
-- Cluster doing" - it returns state, must_move and enabled from the same
-- cash_games row - so it is where the Lightning mode belongs, and the
-- specification agrees: "the lobby represents one Cluster".
--
-- fn_cash_game_lobby is patched by asserted substitution on its LIVE body
-- rather than restated, which is this estate's established pattern for editing
-- a large maintained function (20260907173251, 20260910004358). Restating a
-- 120-line client-facing SECURITY DEFINER function to add one key is how a
-- transcription error reaches production.
--
-- The added read is one primary-key lookup plus one index-only scan of a 16 kB
-- partial index, inside a function that already aggregates every seat at every
-- table in the cluster. It changes no existing key, so no client can break: it
-- adds 'lightning' beside 'tables'.
--
-- NOT CHANGED: the Phase 1 migration file itself. It is merged and applied;
-- it is history. Its fn_cash_session_open body, the four columns, the index and
-- the constraints are all correct and are left exactly as installed.
--
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM public.cash_player_session s JOIN public.cash_games g ON g.id = s.cluster_id WHERE s.closed_at IS NOT NULL AND s.closed_at < g.created_at))
-- @live-proof: (SELECT NOT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_cash_cluster_lightning_state')
-- @live-proof: (SELECT position('fn_cash_cluster_lightning_state' in pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('table_id, cluster_id, variant' in pg_get_functiondef('public.fn_cash_session_open(uuid,uuid,numeric)'::regprocedure)) > 0)

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Clear the retroactive bindings.
-- ---------------------------------------------------------------------------
-- A session that closed before its Cluster existed was never in that Cluster.
-- Sessions closed AFTER their cluster was created are left bound: those are
-- genuine history. No open session is touched by this predicate.

UPDATE public.cash_player_session s
   SET cluster_id = NULL
  FROM public.cash_games g
 WHERE g.id = s.cluster_id
   AND s.closed_at IS NOT NULL
   AND s.closed_at < g.created_at;

-- ---------------------------------------------------------------------------
-- 2. The reader drops SECURITY DEFINER.
-- ---------------------------------------------------------------------------
-- Body is byte-identical to 20260920172736; only the security attribute moves.

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
           'game_id',               g.id,
           'cluster_mode',          g.cluster_mode,
           'cluster_epoch',         g.cluster_epoch,
           'lightning_enabled',     g.lightning_enabled,
           'must_move',             g.must_move,
           'enabled',               g.enabled,
           'handedness',            g.handedness,
           'open_cluster_sessions', (SELECT count(*)
                                       FROM public.cash_player_session s
                                      WHERE s.cluster_id = g.id
                                        AND s.closed_at IS NULL))
    FROM public.cash_games g
   WHERE g.id = p_game_id;
$$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) TO service_role;

COMMENT ON FUNCTION public.fn_cash_cluster_lightning_state(uuid) IS
  'The one authoritative read of a Cluster''s Lightning mode, epoch and enablement. SECURITY INVOKER on purpose: service_role already bypasses RLS, and cash_player_session is revoked from clients, so a mistaken grant of this function leaks nothing.';

-- ---------------------------------------------------------------------------
-- 3. The lobby reads it.
-- ---------------------------------------------------------------------------
-- Asserted substitution on the live body. If the anchor is not found exactly
-- once - because another writer has since changed this function - the whole
-- transaction refuses rather than guessing.

DO $patch$
DECLARE
  v_old text;
  v_new text;
  v_find text;
  v_repl text;
  v_hits integer;
BEGIN
  v_old := pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure);

  IF position('fn_cash_cluster_lightning_state' in v_old) > 0 THEN
    RAISE NOTICE 'fn_cash_game_lobby already reads the Lightning state; leaving it alone';
    RETURN;
  END IF;

  v_find := '    ''tables'', v_tables,';
  v_repl := '    -- ONE DEFINITION OF THE MODE (Lightning Phase 1 remediation).'   || chr(10)
         || '    -- The lobby represents one Cluster, so it answers for the'       || chr(10)
         || '    -- Cluster''s mode too - through the single reader, never through' || chr(10)
         || '    -- its own copy of the rule.'                                     || chr(10)
         || '    ''lightning'', public.fn_cash_cluster_lightning_state(g.id),'     || chr(10)
         || '    ''tables'', v_tables,';

  SELECT count(*) INTO v_hits
    FROM regexp_matches(v_old, regexp_replace(v_find, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g'), 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one tables key in fn_cash_game_lobby, found %', v_hits;
  END IF;

  v_new := replace(v_old, v_find, v_repl);
  IF v_new = v_old THEN RAISE EXCEPTION 'the substitution changed nothing'; END IF;
  EXECUTE v_new;

  IF position('fn_cash_cluster_lightning_state' in
              pg_get_functiondef('public.fn_cash_game_lobby(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_cash_game_lobby does not read the Lightning state after the patch';
  END IF;
END $patch$;

-- The patch replays the live definition verbatim, which restates its own ACL,
-- but check-definer-authorization models the FILE: say it here too.
REVOKE ALL ON FUNCTION public.fn_cash_game_lobby(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_lobby(uuid) TO authenticated, service_role;

COMMIT;
