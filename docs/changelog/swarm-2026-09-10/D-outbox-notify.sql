-- ============================================================================
-- Workstream D: hand_projection_outbox wake via NOTIFY instead of Realtime WAL
-- Project kuklfnapbkmacvwxktbh (Postgres 17). Orchestrator applies. No BEGIN/COMMIT.
--
-- STEP 1 (apply any time, before or with the engine deploy): NOTIFY trigger.
--   Behaviour on every existing path: pg_notify() never raises, never touches a
--   row, never takes a table lock. Notifications are queued transaction-locally
--   and published only at COMMIT of the top-level transaction; the INSERT lives
--   inside fn_ca_commit_hand_settlement_before_lease_generation's
--   BEGIN ... EXCEPTION WHEN OTHERS block, so a rolled-back subtransaction
--   discards its notification with the row. With no LISTENer connected the
--   notification is dropped at commit at zero cost. Payload is 73 bytes
--   (uuid ':' uuid), far below the 8000-byte limit.
--   The existing BEFORE DELETE trigger a0_finish_hand_post_commit_obligations
--   is untouched; this is an AFTER INSERT trigger, so the two never fire in the
--   same statement.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_notify_hand_projection_outbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The engine treats this as a wake-up only: it re-reads the outbox ordered
  -- by hand_number (see server/src/services/supabase/handProjection.ts
  -- runDrain). hand_id:table_id is carried for logging/metrics, not consumed.
  PERFORM pg_notify('hand_projection_outbox', NEW.hand_id::text || ':' || NEW.table_id::text);
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_notify_hand_projection_outbox() IS
  'Workstream D 2026-09-10: per-hand wake for the engine projection worker over LISTEN/NOTIFY. Replaces the Realtime postgres_changes subscription on hand_projection_outbox (WAL decoding was 5-7% of DB time).';

-- Name sorts after a0_* so any future BEFORE/AFTER ordering concern stays obvious.
CREATE TRIGGER z9_notify_hand_projection_outbox
  AFTER INSERT ON public.hand_projection_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_notify_hand_projection_outbox();

-- Only the owner (postgres) executes this via the trigger; no other role needs it.
REVOKE EXECUTE ON FUNCTION public.trg_notify_hand_projection_outbox() FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- OPTIONAL STEP 1b (recommended, least privilege): a LISTEN-only login role for
-- the engine's dedicated connection. LISTEN requires no object privileges, so
-- this role can read nothing. Password is set out of band (never in this file).
-- Supavisor session mode authenticates any LOGIN role of the project.
-- ----------------------------------------------------------------------------
-- CREATE ROLE engine_outbox_listener LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS
--   CONNECTION LIMIT 3;
-- -- \password engine_outbox_listener   (set interactively, never paste)
-- REVOKE ALL ON SCHEMA public FROM engine_outbox_listener;
-- -- Verify it can do nothing but LISTEN:
-- --   SET ROLE engine_outbox_listener; SELECT 1 FROM public.hand_projection_outbox;  -> permission denied

-- ============================================================================
-- STEP 2 - ONLY after the engine cutover is verified (see D-outbox-notify.md,
-- "Cutover"): one full :55 restart cycle with BOTH paths live and
-- poker_hand_projection_wakes_total{source="listen"} >= {source="realtime"}
-- and poker_hand_outbox_listener_connected == 1 on /metrics.
-- This is what actually removes the WAL-decoding cost. Realtime's poller keeps
-- running for club_members / notifications / tournament_* subscribers, but the
-- outbox's ~95% share of published-table changes is no longer decoded or
-- RLS-checked.
-- ============================================================================
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.hand_projection_outbox;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- Step 2 rollback (restores the Realtime path; the engine code keeps working
-- with both until the channel code is deleted):
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.hand_projection_outbox;
--
-- Step 1 rollback (nothing else references these objects):
--   DROP TRIGGER IF EXISTS z9_notify_hand_projection_outbox ON public.hand_projection_outbox;
--   DROP FUNCTION IF EXISTS public.trg_notify_hand_projection_outbox();
--   -- DROP ROLE IF EXISTS engine_outbox_listener;   (only if 1b was applied)
--
-- ORIGINAL DEFINITIONS replaced by this file: none. Nothing existing is
-- redefined. For reference, the pre-existing trigger set on the table was
-- exactly one trigger:
--   CREATE TRIGGER a0_finish_hand_post_commit_obligations BEFORE DELETE ON public.hand_projection_outbox
--     FOR EACH ROW EXECUTE FUNCTION trg_finish_hand_post_commit_obligations()
-- and the publication membership (pg_publication_tables, supabase_realtime) was:
--   public.club_members, public.hand_projection_outbox, public.notifications,
--   public.tournament_bounty_obligations, public.tournament_deal_votes,
--   public.tournament_manager_wakes
