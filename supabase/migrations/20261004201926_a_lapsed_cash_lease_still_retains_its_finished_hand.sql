-- 20261004201926_a_lapsed_cash_lease_still_retains_its_finished_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A LAPSED CASH LEASE STILL RETAINS ITS FINISHED HAND
--
-- WHAT HAPPENED (2026-10-03, read from rows and logs)
--
--   23:43:08-23:43:44 UTC the database host stalled. hand_atomic_commits
--   recorded nothing between 23:43:07 and 23:43:45 (normally 15-30 a
--   second), edge requests that completed at 23:43:12-23:43:28 had waited
--   23-32 s inside Postgres, and Postgres itself logged almost nothing. It
--   was the onset of the memory exhaustion that stopped Postgres at 23:44:27
--   (docs/changelog/2026-10-03-the-database-keeps-memory-headroom.md); the
--   compute was moved to 4XL at 00:06 on 2026-10-04. Not a cutover (the
--   23:05 release cut over at 23:55) and not the maintenance break.
--
--   No lease heartbeat could be answered for longer than the 30 s stale
--   window, so every cash generation's 20 s local proof lapsed (engine
--   diagnostics: last kept renewal sent ~23:43:09, first expiry 23:43:29).
--   85 cash hands on 85 tables had FINISHED and were inside their settlement
--   when that happened. The 30 that had already been retained
--   (smarter_private.hand_submissions) were settled by their successor
--   through fn_ca_resume_hand_submission and their alerts closed on the exact
--   original receipt. The other 55 never reached the table: their retention
--   was refused - locally by the lapsed proof, and for hand #22120571 on
--   table 19e033d0 (`submission_retention_refused`) here, by the
--   stale-heartbeat check below - so the successor found nothing to settle
--   and the hand was disposed. Every one of those 55 hands had been dealt, played and shown to
--   the table under a valid lease. No chips moved: a refused hand leaves
--   every seat at its pre-hand stack (55 disposals, zero hand_atomic_commits,
--   zero unaccounted seat exits).
--
-- WHY RETENTION MAY OUTLIVE THE HEARTBEAT
--
--   Retention moves no money. It stores the exact original request so that
--   fn_ca_resume_hand_submission can settle it under a SUCCESSOR's own fresh
--   lease, and that door already proves, under the table's locks, that the
--   original never settled the hand, that the lease now names the successor
--   and not the original, that every chair and before-stack is unchanged and
--   that no later hand or permit consumed the starting state. The original
--   itself still cannot commit: fn_ca_commit_hand_settlement keeps its own
--   lease and heartbeat fence, and the engine never asks once its proof has
--   lapsed.
--
--   So for a cash table the stale-heartbeat condition is dropped from
--   retention only. The lease row must still name this exact instance,
--   generation and protocol: a lease that was taken, released or re-claimed
--   still refuses (HAND_SUBMISSION_LEASE_UNPROVEN), and that hand is disposed
--   exactly as before. In this engine a stale same-instance lease is released
--   only after the generation's settlement has been joined (stop() has no
--   timeout), so the original's retention always lands before its successor
--   claims and reads the table. A tournament retention keeps the fresh
--   heartbeat requirement (its F06 permits and the manager data fence decide
--   that path).
--
-- The engine half is server/src/services/supabase/handHistory.ts
-- (retainLapsedOriginalForSuccessor) and the `retainWhenLeaseLapses` flag set
-- for verified cash generations in ServerTableEngineSettlement.postHandTasks.
--
-- @live-proof: position('A LAPSED CASH LEASE STILL RETAINS ITS FINISHED HAND' in pg_get_functiondef('public.fn_ca_retain_hand_submission(jsonb)'::regprocedure)) > 0
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $mig$
DECLARE
  v_fn constant regprocedure := 'public.fn_ca_retain_hand_submission(jsonb)'::regprocedure;
  v_marker constant text := 'A LAPSED CASH LEASE STILL RETAINS ITS FINISHED HAND';
  v_anchor constant text := $a$ IF holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;$a$;
  v_with constant text := $w$ -- A LAPSED CASH LEASE STILL RETAINS ITS FINISHED HAND (2026-10-04). Retention
 -- moves no money: fn_ca_resume_hand_submission settles the request only under
 -- a successor's own fresh lease, after proving the original never settled it
 -- and that every chair, before-stack and hand number is unchanged. A cash
 -- original whose heartbeat went stale while its finished hand was in flight
 -- may therefore still retain it while the lease names its exact instance and
 -- generation. Taken, released or re-claimed still refuses. A tournament
 -- retention keeps the fresh-heartbeat requirement.
 IF holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR (tour IS NOT NULL
   AND beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds())) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;$w$;
  v_src text; v_new text; v_n int;
BEGIN
  IF NOT (current_user IN ('postgres','supabase_admin')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;
  v_src := pg_get_functiondef(v_fn);
  IF position(v_marker in v_src) > 0 THEN
    RAISE NOTICE 'fn_ca_retain_hand_submission already admits a lapsed cash lease; skipping';
    RETURN;
  END IF;
  IF md5(v_src) <> '02a6c278f4b004d4160484e37d6e698d' THEN
    RAISE EXCEPTION 'fn_ca_retain_hand_submission changed since it was measured (md5 %) - re-read it before editing', md5(v_src);
  END IF;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'retention lease anchor appears % times, expected exactly 1', v_n;
  END IF;
  v_new := replace(v_src, v_anchor, v_with);
  IF md5(v_new) <> '20fdb0a14573226812367b4b870b8f7c' THEN
    RAISE EXCEPTION 'retention substitution produced an unexpected definition (md5 %)', md5(v_new);
  END IF;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> '20fdb0a14573226812367b4b870b8f7c' THEN
    RAISE EXCEPTION 'fn_ca_retain_hand_submission did not install as written (md5 %)', md5(pg_get_functiondef(v_fn));
  END IF;
END
$mig$;

DO $prove$
DECLARE
  v_fn constant regprocedure := 'public.fn_ca_retain_hand_submission(jsonb)'::regprocedure;
  p record;
  v_src text;
BEGIN
  SELECT pg_get_userbyid(proowner) AS owner, proacl::text AS acl, proconfig::text AS cfg,
         prosecdef, provolatile
    INTO p FROM pg_proc WHERE oid = v_fn;
  IF p.owner <> 'postgres'
     OR p.acl <> '{postgres=X/postgres,service_role=X/postgres}'
     OR p.cfg <> '{"search_path=pg_catalog, public, extensions"}'
     OR NOT p.prosecdef
     OR p.provolatile <> 'v' THEN
    RAISE EXCEPTION 'retention owner/acl/config changed (owner %, acl %, cfg %)', p.owner, p.acl, p.cfg;
  END IF;
  v_src := pg_get_functiondef(v_fn);
  -- The cash branch no longer reads the heartbeat age; the tournament branch,
  -- the exact holder/generation/protocol check and every other refusal stay.
  IF md5(v_src) <> '20fdb0a14573226812367b4b870b8f7c'
     OR position('OR beat IS NULL OR (tour IS NOT NULL' in v_src) = 0
     OR position('holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2' in v_src) = 0
     OR position('HAND_SUBMISSION_PERMIT_FENCED' in v_src) = 0
     OR position('HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' in v_src) = 0
     OR position('HAND_SUBMISSION_PERMIT_DISPOSED' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_retain_hand_submission is not the reviewed definition (md5 %)', md5(v_src);
  END IF;
END
$prove$;

COMMIT;
