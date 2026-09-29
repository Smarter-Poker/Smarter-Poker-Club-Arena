-- 20260924043217_multi_day_stage_foundation_tables.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  MULTI-DAY TOURNAMENTS, RELEASE R1: THE STAGE RECORDS
--  Design: docs/handoffs/club-arena-product-completion/MULTI-DAY-DESIGN.md
--  (sections 2 to 5; same tournament row across days, status BAGGED between
--  stages, all new state in new tables).
-- ===========================================================================
--
-- WHAT THIS ADDS. Eight private tables and nothing else. No column is added to
-- public.tournaments or public.tournament_players: the frozen Spin row-image
-- witness (20260918122532) compares whole rows of both.
--
--   tournament_stage_plans            one sealed plan per multi-day event
--   tournament_stages                 one row per day; the only mutable rows
--   tournament_stage_transitions      append-only receipts (seal, day_end,
--                                     bag, reschedule, resume_begin,
--                                     resume_complete)
--   tournament_stage_clock_snapshots  the stopped blind clock at a bag
--   tournament_stage_bag_watermarks   per table: the last accepted hand a bag
--                                     was taken over (provenance watermark)
--   tournament_stage_bags             per player: the stack moved off the felt
--   tournament_qualification_entitlements
--                                     per player: the right to one seat in the
--                                     next stage, consumed exactly once
--   tournament_stage_resume_receipts  one resume per stage, completed once
--
-- WHO WRITES THEM. Nobody directly. Every row is written by the lease-fenced
-- RPCs of 20260924043239, which set the transaction-local marker
-- app.multi_day_stage_writer to the tournament id. A write without the marker
-- is refused (55000) whatever the role, and DELETE / TRUNCATE are refused
-- always. Receipts are append-only; the three rows that legitimately change
-- (a stage's state and schedule, an entitlement being consumed, a resume
-- receipt being completed or adopted by a successor lease) each have their
-- own narrow update rule below.
--
-- UNREACHABLE UNTIL R6. Nothing here is written until an RPC of
-- 20260924043239 runs, and every one of those refuses unless
-- fn_capability_available('tournament.multi_day.single_flight') is true.
-- trg_tournaments_refuse_unbuilt_multi_day is untouched and keeps refusing all
-- seven legacy multi-day columns; this design never uses them.
--
-- NO MONEY. No chip, escrow, obligation, rake or ledger row is created,
-- changed or read for settlement here.
--
-- LOCKING. The only foreign key to a hot table is tournament_stage_plans ->
-- tournaments(id); CREATE TABLE with it takes SHARE ROW EXCLUSIVE on
-- tournaments until COMMIT, so the transaction is short and lock_timeout
-- bounds the wait. bags.registration_id and the seat ids are deliberately NOT
-- foreign keys (CLAUDE.md section 2 rule 7): they are validated by the RPC that
-- writes them.
--
-- ROLLBACK: DROP TABLE of the eight tables and their two trigger functions,
-- only while tournament_stage_plans is empty.
--
-- @live-proof: (SELECT count(*) = 8 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relname IN ('tournament_stage_plans','tournament_stages','tournament_stage_transitions','tournament_stage_clock_snapshots','tournament_stage_bag_watermarks','tournament_stage_bags','tournament_qualification_entitlements','tournament_stage_resume_receipts'))
-- @live-proof: (SELECT bool_and(NOT has_table_privilege(r, 'public.' || t, 'INSERT') AND NOT has_table_privilege(r, 'public.' || t, 'UPDATE') AND NOT has_table_privilege(r, 'public.' || t, 'DELETE')) FROM unnest(ARRAY['anon','authenticated','service_role']) r CROSS JOIN unnest(ARRAY['tournament_stage_plans','tournament_stages','tournament_stage_transitions','tournament_stage_clock_snapshots','tournament_stage_bag_watermarks','tournament_stage_bags','tournament_qualification_entitlements','tournament_stage_resume_receipts']) t)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regclass('public.tournaments') IS NULL THEN
    RAISE EXCEPTION 'MULTI_DAY_TOURNAMENTS_TABLE_MISSING' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.fn_capability_available(text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.platform_capabilities
                     WHERE capability_id = 'tournament.multi_day.single_flight') THEN
    RAISE EXCEPTION 'MULTI_DAY_REQUIRES_THE_CAPABILITY_REGISTRY (20260924025555)'
      USING ERRCODE = '55000';
  END IF;
  IF to_regclass('public.tournament_stage_plans') IS NOT NULL
     OR to_regclass('public.tournament_stages') IS NOT NULL
     OR to_regclass('public.tournament_stage_transitions') IS NOT NULL
     OR to_regclass('public.tournament_stage_clock_snapshots') IS NOT NULL
     OR to_regclass('public.tournament_stage_bag_watermarks') IS NOT NULL
     OR to_regclass('public.tournament_stage_bags') IS NOT NULL
     OR to_regclass('public.tournament_qualification_entitlements') IS NOT NULL
     OR to_regclass('public.tournament_stage_resume_receipts') IS NOT NULL THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_TABLE_NAME_TAKEN' USING ERRCODE = '42P07';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE PLAN AND ITS STAGES.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tournament_stage_plans (
  tournament_id  uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  capability_id  text NOT NULL CHECK (capability_id = 'tournament.multi_day.single_flight'),
  rule_version   text NOT NULL CHECK (rule_version = 'multi-day-v1'),
  time_zone      text NOT NULL CHECK (btrim(time_zone) <> ''),
  stage_count    integer NOT NULL CHECK (stage_count BETWEEN 2 AND 14),
  plan           jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  plan_hash      text NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{32}$'),
  sealed_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);

CREATE TABLE public.tournament_stages (
  tournament_id       uuid NOT NULL REFERENCES public.tournament_stage_plans(tournament_id) ON DELETE RESTRICT,
  stage_no            integer NOT NULL CHECK (stage_no >= 1),
  kind                text NOT NULL CHECK (kind = 'day'),
  day_no              integer NOT NULL CHECK (day_no = stage_no),
  -- The published level whose END ends this stage. NULL only on the final
  -- stage, which ends when the event completes.
  end_after_level     integer CHECK (end_after_level IS NULL OR end_after_level >= 1),
  -- NULL on stage 1 (tournaments.start_time governs the launch).
  scheduled_start_utc timestamptz,
  schedule_generation bigint NOT NULL DEFAULT 1 CHECK (schedule_generation >= 1),
  state               text NOT NULL DEFAULT 'planned'
                      CHECK (state IN ('planned','running','day_ending','bagged',
                                       'scheduled','resuming','closed')),
  state_changed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tournament_id, stage_no),
  CHECK (stage_no = 1 OR scheduled_start_utc IS NOT NULL)
);
CREATE INDEX tournament_stages_due_idx
  ON public.tournament_stages (scheduled_start_utc)
  WHERE state = 'scheduled';

-- ---------------------------------------------------------------------------
-- 2. RECEIPTS.
-- ---------------------------------------------------------------------------
CREATE TABLE public.tournament_stage_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id       uuid NOT NULL,
  stage_no            integer NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('seal','day_end','bag','reschedule',
                                                    'resume_begin','resume_complete')),
  idempotency_key     text NOT NULL UNIQUE,
  lease_generation    uuid,
  schedule_generation bigint,
  facts               jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  transaction_id      xid8 NOT NULL DEFAULT pg_current_xact_id(),
  FOREIGN KEY (tournament_id, stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);
CREATE INDEX tournament_stage_transitions_stage_idx
  ON public.tournament_stage_transitions (tournament_id, stage_no, created_at);

CREATE TABLE public.tournament_stage_clock_snapshots (
  tournament_id        uuid NOT NULL,
  stage_no             integer NOT NULL,
  bag_id               uuid NOT NULL UNIQUE
                       REFERENCES public.tournament_stage_transitions(id) ON DELETE RESTRICT,
  rule_version         text NOT NULL,
  level_index          integer NOT NULL CHECK (level_index >= 0),
  small_blind          numeric,
  big_blind            numeric,
  ante                 numeric,
  blind_level_state    jsonb,
  remaining_level_ms   bigint NOT NULL CHECK (remaining_level_ms >= 0),
  next_level_index     integer NOT NULL CHECK (next_level_index = level_index + 1),
  break_state          jsonb NOT NULL CHECK (jsonb_typeof(break_state) = 'object'),
  next_stage_no        integer NOT NULL CHECK (next_stage_no = stage_no + 1),
  next_stage_start_utc timestamptz NOT NULL,
  next_stage_zone      text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tournament_id, stage_no),
  FOREIGN KEY (tournament_id, stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);

CREATE TABLE public.tournament_stage_bag_watermarks (
  tournament_id    uuid NOT NULL,
  stage_no         integer NOT NULL,
  table_id         uuid NOT NULL,
  bag_id           uuid NOT NULL REFERENCES public.tournament_stage_transitions(id) ON DELETE RESTRICT,
  last_hand_number bigint,
  last_hand_id     uuid,
  seat_count       integer NOT NULL CHECK (seat_count >= 0),
  seat_stack_sum   numeric NOT NULL CHECK (seat_stack_sum >= 0),
  PRIMARY KEY (tournament_id, stage_no, table_id),
  FOREIGN KEY (tournament_id, stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);

CREATE TABLE public.tournament_stage_bags (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id          uuid NOT NULL,
  stage_no               integer NOT NULL,
  bag_id                 uuid NOT NULL REFERENCES public.tournament_stage_transitions(id) ON DELETE RESTRICT,
  registration_id        uuid NOT NULL,
  user_id                uuid NOT NULL,
  stack                  numeric NOT NULL CHECK (stack > 0 AND stack = trunc(stack)),
  bounty_head            numeric NOT NULL CHECK (bounty_head >= 0),
  source_table_id        uuid NOT NULL,
  source_seat_id         uuid NOT NULL,
  source_seat_number     integer NOT NULL,
  seat_club_id           uuid,
  seat_horse_id          uuid,
  watermark_hand_number  bigint,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tournament_id, stage_no, registration_id),
  UNIQUE (tournament_id, stage_no, user_id),
  FOREIGN KEY (tournament_id, stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);

CREATE TABLE public.tournament_qualification_entitlements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id          uuid NOT NULL,
  user_id                uuid NOT NULL,
  source_stage_no        integer NOT NULL,
  source_registration_id uuid NOT NULL,
  source_bag_row_id      uuid NOT NULL UNIQUE
                         REFERENCES public.tournament_stage_bags(id) ON DELETE RESTRICT,
  stack                  numeric NOT NULL CHECK (stack > 0 AND stack = trunc(stack)),
  bounty_head            numeric NOT NULL CHECK (bounty_head >= 0),
  target_stage_no        integer NOT NULL,
  state                  text NOT NULL DEFAULT 'active' CHECK (state IN ('active','consumed')),
  consumed_by_resume_id  uuid,
  consumed_seat_id       uuid,
  consumed_table_id      uuid,
  consumed_seat_number   integer,
  consumed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One seat per player per stage: never a second seat, never an aggregate.
  UNIQUE (tournament_id, user_id, target_stage_no),
  CHECK (target_stage_no = source_stage_no + 1),
  CHECK ((state = 'active' AND consumed_by_resume_id IS NULL AND consumed_seat_id IS NULL
          AND consumed_table_id IS NULL AND consumed_seat_number IS NULL AND consumed_at IS NULL)
      OR (state = 'consumed' AND consumed_by_resume_id IS NOT NULL AND consumed_seat_id IS NOT NULL
          AND consumed_table_id IS NOT NULL AND consumed_seat_number IS NOT NULL
          AND consumed_at IS NOT NULL)),
  FOREIGN KEY (tournament_id, target_stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);
CREATE INDEX tournament_qualification_entitlements_target_idx
  ON public.tournament_qualification_entitlements (tournament_id, target_stage_no, state);

CREATE TABLE public.tournament_stage_resume_receipts (
  tournament_id       uuid NOT NULL,
  stage_no            integer NOT NULL,
  resume_id           uuid NOT NULL UNIQUE,
  lease_generation    uuid NOT NULL,
  schedule_generation bigint NOT NULL,
  first_level         jsonb NOT NULL CHECK (jsonb_typeof(first_level) = 'object'),
  claimed_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at        timestamptz,
  PRIMARY KEY (tournament_id, stage_no),
  FOREIGN KEY (tournament_id, stage_no)
    REFERENCES public.tournament_stages(tournament_id, stage_no) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 3. THE WRITER RULES.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_tournament uuid;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_RECORD_IS_PERMANENT: % on % refused', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  v_tournament := NEW.tournament_id;
  IF current_setting('app.multi_day_stage_writer', true) IS DISTINCT FROM v_tournament::text THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_WRITER_REQUIRED: % on % belongs to the stage RPCs', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'tournament_stages' THEN
    IF (NEW.tournament_id, NEW.stage_no, NEW.kind, NEW.day_no, NEW.end_after_level)
       IS DISTINCT FROM (OLD.tournament_id, OLD.stage_no, OLD.kind, OLD.day_no, OLD.end_after_level)
       OR NEW.schedule_generation < OLD.schedule_generation THEN
      RAISE EXCEPTION 'MULTI_DAY_STAGE_STRUCTURE_IS_SEALED' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME = 'tournament_qualification_entitlements' THEN
    IF OLD.state = 'active' AND NEW.state = 'consumed'
       AND (NEW.id, NEW.tournament_id, NEW.user_id, NEW.source_stage_no, NEW.source_registration_id,
            NEW.source_bag_row_id, NEW.stack, NEW.bounty_head, NEW.target_stage_no, NEW.created_at)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.tournament_id, OLD.user_id, OLD.source_stage_no, OLD.source_registration_id,
            OLD.source_bag_row_id, OLD.stack, OLD.bounty_head, OLD.target_stage_no, OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MULTI_DAY_ENTITLEMENT_IS_CONSUMED_ONCE' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'tournament_stage_resume_receipts' THEN
    IF (NEW.tournament_id, NEW.stage_no, NEW.resume_id, NEW.schedule_generation, NEW.first_level, NEW.claimed_at)
       IS DISTINCT FROM
       (OLD.tournament_id, OLD.stage_no, OLD.resume_id, OLD.schedule_generation, OLD.first_level, OLD.claimed_at)
       OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'MULTI_DAY_RESUME_RECEIPT_IS_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    -- Exactly one of: completion, or a successor lease adopting it.
    IF (NEW.completed_at IS NOT NULL AND NEW.lease_generation = OLD.lease_generation)
       OR (NEW.completed_at IS NULL AND NEW.lease_generation IS DISTINCT FROM OLD.lease_generation) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MULTI_DAY_RESUME_RECEIPT_IS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MULTI_DAY_STAGE_RECEIPT_IS_APPEND_ONLY: UPDATE on % refused', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$fn$;

CREATE FUNCTION public.fn_multi_day_stage_rows_never_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'MULTI_DAY_STAGE_RECORD_IS_PERMANENT: TRUNCATE on % refused', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$fn$;

DO $attach$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['tournament_stage_plans','tournament_stages',
    'tournament_stage_transitions','tournament_stage_clock_snapshots',
    'tournament_stage_bag_watermarks','tournament_stage_bags',
    'tournament_qualification_entitlements','tournament_stage_resume_receipts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned()',
                   v_table || '_rpc_owned', v_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.fn_multi_day_stage_rows_never_truncate()',
                   v_table || '_no_truncate', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', v_table);
  END LOOP;
END
$attach$;

REVOKE ALL ON FUNCTION public.fn_multi_day_stage_rows_are_rpc_owned() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_multi_day_stage_rows_never_truncate() FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
         AND c.relname IN ('tournament_stage_plans','tournament_stages',
           'tournament_stage_transitions','tournament_stage_clock_snapshots',
           'tournament_stage_bag_watermarks','tournament_stage_bags',
           'tournament_qualification_entitlements','tournament_stage_resume_receipts')) <> 16 THEN
    RAISE EXCEPTION 'MULTI_DAY_STAGE_WRITER_RULES_NOT_ATTACHED' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
