-- 20260910052523_hand_projection_outbox_notifies_its_listener.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (2026-09-10, workstream D/H):
--
-- The engine's hand projection worker (server/src/services/supabase/
-- handProjection.ts) was woken by a Supabase Realtime postgres_changes
-- subscription on public.hand_projection_outbox. That table takes one INSERT
-- and one DELETE per hand - 95.5% of every change in the supabase_realtime
-- publication - and Realtime's poller logically decodes and RLS-checks every
-- one of those WAL records to deliver a callback whose payload the worker
-- never read. Measured after the 2026-09-10 02:34 pg_stat reset: 8,589 poller
-- calls, 57 ms mean, 5.16% of all database time (7% over the prior 17 h).
--
-- This trigger sends the same "a row was inserted" signal as a NOTIFY on the
-- channel hand_projection_outbox, delivered at COMMIT of the settlement
-- transaction that inserts the row. The engine LISTENs on one dedicated
-- session (server/src/services/supabase/handOutboxListener.ts) and calls the
-- same wake the Realtime callback did. Payload is hand_id:table_id (73 bytes,
-- limit 8000) and is carried for logs and metrics only: the drain re-reads
-- the outbox ordered by hand_number, which preserves the per-table predecessor
-- order the database enforces.
--
-- SAFETY ON EVERY EXISTING PATH:
--   * pg_notify() raises only for an invalid channel name or a payload over
--     8000 bytes. It takes no row lock and no table lock and cannot fail the
--     settlement. It costs one notification-queue write at commit; with no
--     LISTENer connected the notification is dropped at commit for free.
--   * Notifications are transactional. The INSERT lives inside
--     fn_ca_commit_hand_settlement_before_lease_generation's
--     BEGIN ... EXCEPTION WHEN OTHERS block, so a rolled-back subtransaction
--     discards its notification together with the row.
--   * The existing BEFORE DELETE trigger a0_finish_hand_post_commit_obligations
--     is untouched; this is an AFTER INSERT trigger, so the two never fire in
--     the same statement. The trigger name sorts after a0_* so any future
--     ordering question stays obvious.
--   * The function is NOT SECURITY DEFINER and runs as the inserting role
--     (service_role via the RPC's owner). EXECUTE is revoked from browser roles;
--     only the trigger calls it.
--
-- STEP 2 (NOT in this file; the orchestrator runs it by hand ONLY after the
-- engine cutover is verified - see docs/changelog/
-- 2026-09-10-hand-projection-wakes-by-notify-with-a-poll-net.md): dropping the
-- table from the publication is what actually removes the WAL-decoding cost.
-- It is DDL (one ~28 s PostgREST schema-cache reload), so it belongs at a :55
-- or another quiet moment, and it must not run before /metrics shows
-- poker_hand_outbox_listener_connected 1 and
-- poker_hand_projection_wakes_total{source="listen"} >= {source="realtime"}
-- over one full restart cycle:
--
--   -- ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;
--
-- ROLLBACK (nothing existing is redefined by this file):
--   DROP TRIGGER IF EXISTS z9_notify_hand_projection_outbox ON public.hand_projection_outbox;
--   DROP FUNCTION IF EXISTS public.trg_notify_hand_projection_outbox();
-- Step 2 rollback, if step 2 was run:
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;
-- Engine rollback needs no database change: unset ENGINE_PG_LISTEN_URL (the
-- listener disables itself and warns once) or redeploy the previous image;
-- the 5 s poll and the local commit wakes alone keep hands flowing.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_notify_hand_projection_outbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The engine treats this as a wake-up only: it re-reads the outbox ordered
  -- by hand_number (server/src/services/supabase/handProjection.ts runDrain).
  -- hand_id:table_id is carried for logging and metrics, never consumed.
  PERFORM pg_notify('hand_projection_outbox', NEW.hand_id::text || ':' || coalesce(NEW.table_id::text, ''));
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_notify_hand_projection_outbox() IS
  '2026-09-10: per-hand wake for the engine projection worker over LISTEN/NOTIFY (channel hand_projection_outbox). Replaces the Realtime postgres_changes subscription on hand_projection_outbox, whose WAL decoding was 5-7% of database time. Wake only; the worker re-reads the outbox.';

CREATE TRIGGER z9_notify_hand_projection_outbox
  AFTER INSERT ON public.hand_projection_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_notify_hand_projection_outbox();

-- Only the trigger calls this; no browser role and no RPC needs EXECUTE.
REVOKE ALL ON FUNCTION public.trg_notify_hand_projection_outbox() FROM PUBLIC, anon, authenticated;

COMMIT;
