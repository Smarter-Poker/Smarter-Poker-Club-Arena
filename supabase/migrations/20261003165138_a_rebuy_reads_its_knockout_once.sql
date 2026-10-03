-- ============================================================================
-- A REBUY READS ITS KNOCKOUT ONCE
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-03 16:40-16:50 UTC
--
-- About 240 of the 270 "canceling statement due to statement timeout" errors
-- in those ten minutes were per-hand tournament calls queued on one MTT's
-- settlement lane: fn_ca_retain_hand_submission (135, shared lane),
-- fn_f06_allocate_hand_number / fn_f06_hand_number_state / fn_f06_begin_hand
-- (77, exclusive lane), fn_ca_commit_hand_submission (19). Live lock samples
-- (pg_blocking_pids, every 1.5 s) named the holder every time:
-- process_tournament_rebuy, running (no wait event), 18 to 29 s into its
-- transaction, with the lane held.
--
-- Why a rebuy ran for half a minute. process_tournament_rebuy reads its
-- knockout generation twice, both times as
--
--     SELECT * INTO v_candidate
--       FROM public.tournament_knockout_candidates c
--      WHERE c.id = public.fn_ca_latest_committed_knockout_candidate(
--        p_tournament_id, p_user_id);
--
-- fn_ca_latest_committed_knockout_candidate was VOLATILE (the plpgsql
-- default), and a volatile call cannot be an index key, so the planner chose
--
--     Seq Scan on tournament_knockout_candidates c   (~402,000 rows)
--       Filter: (id = fn_ca_latest_committed_knockout_candidate(...))
--
-- and called the function - three indexed reads, one of them on the 10 GB
-- hand_atomic_commits - once PER ROW of the table, twice per rebuy. The
-- rebuy's own statement timeouts are the same reads (fn_ca_latest_committed_
-- knockout_candidate line 41 / line 66, 13:00-16:50 UTC).
--
-- THE FIX
--
-- The function only reads (tournament_knockout_candidates,
-- hand_atomic_commits, settlement_idempotency_keys) and raises; it writes
-- nothing and returns the same answer for the same arguments within a
-- statement. That is STABLE. A stable call with constant arguments is an
-- index key, evaluated once:
--
--     Index Scan using tournament_knockout_candidates_pkey
--       Index Cond: (id = fn_ca_latest_committed_knockout_candidate(...))
--
-- (plan verified on production with an equivalent pg_temp stable function).
-- Nothing else changes: same body, same arguments, same refusals, same
-- owner, grants and search_path; every other caller assigns the result to a
-- variable and is unaffected. The rebuy still re-reads the latest generation
-- under its tournament/candidate locks exactly as before; the money path
-- (chips, cost, ledger) is untouched.
--
-- A later CREATE OR REPLACE of this function that omits STABLE silently makes
-- it VOLATILE again; tests/a-rebuy-reads-its-knockout-once.law.test.ts
-- refuses that.
-- ============================================================================

-- @live-proof: (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER FUNCTION public.fn_ca_latest_committed_knockout_candidate(uuid, uuid) STABLE;

DO $assert$
BEGIN
  IF (SELECT provolatile FROM pg_proc
       WHERE oid = 'public.fn_ca_latest_committed_knockout_candidate(uuid,uuid)'::regprocedure)
     IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'fn_ca_latest_committed_knockout_candidate is not STABLE after the alter';
  END IF;
END
$assert$;

COMMIT;
