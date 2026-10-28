-- 20261028150435_snapshot_retention_traverses_bounded_candidates_before_eligi.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure)) = 'b192cde11e809c4477e9b009a353178a' AND to_regclass('smarter_private.snapshot_retention_scan') IS NOT NULL
BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

-- October 27 job119 repeatedly timed out inside horse_snapshot_disposable.
-- LIMIT after that predicate bounds deletions, not eligibility work. Retained
-- witnesses must not make the original retention transaction scan forever.
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_state_snapshots(integer)'::regprocedure))
    IS DISTINCT FROM '9796fd7b8fba97bf4fe0481740397f9e' THEN
  RAISE EXCEPTION 'snapshot retention preimage changed; inspect before installation';
 END IF;
END $guard$;

-- Private scan position only: no foreign key or lock on a live game table.
-- Cursor and deletions commit together. Failed calls cannot skip candidates.
CREATE TABLE smarter_private.snapshot_retention_scan (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 through_at timestamptz NOT NULL DEFAULT '-infinity',
 after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 examined bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smarter_private.snapshot_retention_scan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.snapshot_retention_scan FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO smarter_private.snapshot_retention_scan(singleton) VALUES (true);

CREATE OR REPLACE FUNCTION public.sp_prune_hand_state_snapshots(p_batch integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
 v_cursor smarter_private.snapshot_retention_scan;
 v_row record;
 v_seen integer := 0;
 v_n integer;
 v_deleted integer := 0;
 v_limit integer := LEAST(10000, GREATEST(COALESCE(p_batch,5000),1));
 v_deadline timestamptz := clock_timestamp() + interval '20 seconds';
BEGIN
 -- The cron already takes its advisory lock. Other callers must not race
 -- the same scan position or wait behind a long retention transaction.
 SELECT * INTO v_cursor FROM smarter_private.snapshot_retention_scan
  WHERE singleton FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN 0; END IF;
 FOR v_row IN
  -- MATERIALIZED is the work boundary: eligibility runs only after LIMIT.
  WITH candidates AS MATERIALIZED (
   SELECT s.id,s.created_at FROM public.hand_state_snapshots s
    WHERE s.created_at >= v_cursor.through_at
      AND (s.created_at,s.id) > (v_cursor.through_at,v_cursor.after_id)
      AND s.created_at < statement_timestamp()-interval '8 days'
    ORDER BY s.created_at,s.id LIMIT v_limit
  ) SELECT * FROM candidates ORDER BY created_at,id
 LOOP
  EXIT WHEN clock_timestamp() >= v_deadline;
  -- Same authoritative eligibility function, certificate and interrupted
  -- hand holds, rechecked by the DELETE. No human/BBJ/escrow witness relaxed.
  DELETE FROM public.hand_state_snapshots h WHERE h.id=v_row.id
   AND h.updated_at < statement_timestamp()-interval '8 days'
   AND EXISTS (SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates c
                WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)
   AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits p
                    WHERE p.table_id=h.table_id AND p.hand_number=h.hand_number AND p.state='reserved')
   AND smarter_private.horse_snapshot_disposable(h.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted+v_n;
  v_seen := v_seen+1;
  v_cursor.through_at := v_row.created_at;
  v_cursor.after_id := v_row.id;
 END LOOP;
 IF v_seen=0 THEN
  -- End of pass: revisit refused witnesses on the next existing cron call.
  -- They may become disposable after their original owning hand completes.
  v_cursor.through_at := '-infinity';
  v_cursor.after_id := '00000000-0000-0000-0000-000000000000';
 END IF;
 UPDATE smarter_private.snapshot_retention_scan
  SET through_at=v_cursor.through_at,after_id=v_cursor.after_id,
      examined=examined+v_seen,updated_at=clock_timestamp() WHERE singleton;
 RETURN v_deleted;
END
$function$;

-- CREATE OR REPLACE preserves the existing function identity and ACL.
-- No cron, timeout, retention duration, payout or disposal predicate changes.

COMMIT;
