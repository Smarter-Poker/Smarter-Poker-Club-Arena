-- @live-proof: (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_tournament_conservation_delta(uuid)'::regprocedure)='e796dbcb9eff1be639d23b2526c98228' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_tournament_conservation_deltas(timestamptz,timestamptz)'::regprocedure)='42ba1e0ca23edb232eae99433b152bfd'
-- 20261015100003_a_ticket_paid_in_cash_never_arrives_at_its_target.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT HAPPENED
--
-- At 03:25 UTC on 2026-10-15 the deep money-conservation pass (cron 274)
-- raised 56 warnings at once, "Tournament retained money it never paid out",
-- on 56 completed freezeout targets, 55,120.00 in all. Example: Sunday Funday
-- Main Event (1c4e59cf, 2026-09-15) at +6,700.00.
--
-- CAUSE (read from rows)
--
-- 20261012054804 made a closed target pay its unused entry-only satellite
-- tickets in cash: fn_ca_pay_closed_target_ticket_in_cash moves the value
-- escrow -> the holder's wallet under idempotency key
-- 'ticket:<id>:closed-target-cash' (category ticket_redeem, no tournament on
-- the leg) and moves the ticket issued -> redeemed. The five settlement
-- migrations that followed paid the 928 stranded tickets (55,120.00, 460
-- holders) in one transaction at 2026-10-14 23:33:05 UTC. Every holder was
-- paid exactly once; the money is right.
--
-- fn_tournament_conservation_delta and fn_tournament_conservation_deltas
-- count a ticket as a seat ARRIVING at its target when its status is
-- 'redeemed', because until 2026-10-12 redeeming was the only way out of
-- 'issued' and it meant the holder entered. A ticket paid in cash is also
-- 'redeemed' now, but nothing arrived: on the Sunday Funday target 61 of the
-- 67 redeemed tickets belong to holders who never entered it. Each such
-- ticket read as 100.00 the target collected and never paid out.
--
-- FIX
--
-- Both readings exclude, from the seat a target receives, a ticket whose
-- redemption is the cash door's own leg (looked up by its unique idempotency
-- key, ux_chip_ledger_idempotency_key). The satellite side is untouched: the
-- satellite still paid that seat out, from its pool into the ticket escrow,
-- and the escrow paid the holder.
--
-- Proved in production with a self-aborting pg_temp trial: all 56 flagged
-- targets read 0.00 (within the 1.00 tolerance), and the whole 45-day deep
-- window flags nothing, so no other event's reading moves. The next hourly
-- pass (cron 144) resolves the 56 open alerts through its own pass 1.
--
-- The patch replaces exactly one gate in each body (asserted), keeps owner,
-- grants, config, security definer and volatility (asserted), and writes no
-- row or money.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

DO $migration$
DECLARE
  old_gate constant text := $g$AND (k.id IS NULL OR k.status = 'redeemed')$g$;
  new_gate constant text := $g$AND (k.id IS NULL OR (k.status = 'redeemed' AND NOT EXISTS (SELECT 1 FROM public.chip_ledger cl WHERE cl.idempotency_key = 'ticket:' || k.id::text || ':closed-target-cash' AND cl.category = 'ticket_redeem')))$g$;
  sigs  constant regprocedure[] := ARRAY[
    'public.fn_tournament_conservation_delta(uuid)'::regprocedure,
    'public.fn_tournament_conservation_deltas(timestamptz,timestamptz)'::regprocedure];
  pre   constant text[] := ARRAY['bbe59c17ba9d79308f2c5077e0940183','e14f6d4bf9e85ac6679d1120139f4fdf'];
  post  constant text[] := ARRAY['e796dbcb9eff1be639d23b2526c98228','42ba1e0ca23edb232eae99433b152bfd'];
  i int; src text; def text; meta_before text; meta_after text;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ticket_cash_conservation_operator_refused' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(current_setting('ca.break_window_migration_override', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'ticket_cash_conservation_override_refused';
  END IF;
  IF public.fn_platform_frozen() IS DISTINCT FROM false
     OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'ticket_cash_conservation_freeze_refused';
  END IF;
  IF EXISTS (SELECT FROM supabase_migrations.schema_migrations WHERE version = '20261015100003') THEN
    RAISE EXCEPTION 'ticket_cash_conservation_history_replay';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_chip_ledger_idempotency_key'
       AND indexdef = 'CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL)') THEN
    RAISE EXCEPTION 'ticket_cash_conservation_key_index_refused';
  END IF;

  FOR i IN 1 .. 2 LOOP
    SELECT p.prosrc, format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
      INTO src, meta_before FROM pg_proc p WHERE p.oid = sigs[i];
    IF md5(src) <> pre[i] THEN
      RAISE EXCEPTION 'ticket_cash_conservation_preimage_refused: %', sigs[i];
    END IF;
    IF (length(src) - length(replace(src, old_gate, ''))) / length(old_gate) <> 1 THEN
      RAISE EXCEPTION 'ticket_cash_conservation_gate_count_refused: %', sigs[i];
    END IF;
    def := pg_get_functiondef(sigs[i]);
    EXECUTE replace(def, old_gate, new_gate);
    SELECT md5(p.prosrc), format('%s|%s|%s|%s|%s', p.proowner::regrole, p.proacl, p.proconfig, p.prosecdef, p.provolatile)
      INTO src, meta_after FROM pg_proc p WHERE p.oid = sigs[i];
    IF src <> post[i] THEN
      RAISE EXCEPTION 'ticket_cash_conservation_postimage_refused: %', sigs[i];
    END IF;
    IF meta_after IS DISTINCT FROM meta_before
       OR meta_after <> 'postgres|{postgres=X/postgres,service_role=X/postgres}|{search_path=public}|t|s' THEN
      RAISE EXCEPTION 'ticket_cash_conservation_security_refused: %', sigs[i];
    END IF;
  END LOOP;
END
$migration$;

COMMIT;
