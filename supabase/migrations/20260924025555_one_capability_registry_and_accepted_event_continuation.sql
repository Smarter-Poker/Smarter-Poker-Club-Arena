-- 20260924025555_one_capability_registry_and_accepted_event_continuation.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ===========================================================================
--  ONE CAPABILITY REGISTRY, AND AN ACCEPTED EVENT RUNS TO ITS CONCLUSION
--  2026-09-24 (Prompt 1 Phase 1.1 and 1.4; integration-owner design of
--  2026-09-22, docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md)
-- ===========================================================================
--
-- WHAT THIS ADDS.
--
--   1. public.platform_capabilities: one row per technical capability, with
--      the rule version its readiness refers to, and a readiness on one
--      ladder: excluded < planned < implemented < tested < deployed <
--      production_verified. "Available" means deployed or production_verified
--      and nothing else. Server-side validation asks fn_capability_available;
--      clients read fn_platform_capabilities (no evidence in it); readiness
--      moves only through fn_set_capability_readiness, which demands evidence
--      for the two available rungs and records every move in
--      public.platform_capability_events, an append-only history.
--
--   2. public.accepted_event_operations: the acceptance record of an event
--      (today: a tournament), written by an AFTER INSERT trigger in the same
--      transaction as the tournament row, and concluded by an AFTER UPDATE OF
--      status trigger when the status becomes COMPLETED or CANCELLED. Every
--      tournament that is not terminal at install time is backfilled with the
--      basis {"operator_access":"legacy_free"}. fn_event_continuation answers
--      whether an event (or its parent economic event) is still continuing.
--      These are acceptance records, not money: nothing here moves a chip or a
--      diamond, and nothing here authorizes a NEW event.
--
-- WHAT ALREADY EXISTED, AND WHY NONE OF IT IS REUSED (read from the live
-- manifests scripts/ci/supabase-schema-manifest.json and -columns-manifest).
--   club_entry_feature_flags (key, enabled, rollout_percent) is a boolean
--   rollout switch for three club-entry flows; platform_policies (key, value)
--   is an untyped key/value store; game_registry lists mini-games;
--   feature_pricing / premium_feature_access are diamond purchases. None
--   carries a rule version, a readiness ladder, evidence, a revision or a
--   history, and bending one of them into that shape would change what its
--   existing readers see. A new table is the smaller change.
--
-- TRIGGERS ON public.tournaments. The table carries ~50 triggers (migrations
-- 20260821 to 20260918). None is named trg_tournaments_record_acceptance or
-- trg_tournaments_record_conclusion. Both new triggers are AFTER ... FOR EACH
-- ROW, write only to the new table (which has no triggers and no foreign key
-- to tournaments - CLAUDE.md section 2 rule 7), and never modify the
-- tournament row, so no BEFORE guard sees a different NEW and no column is
-- added to tournaments (the frozen Spin row-image witness compares whole
-- rows). tournaments is one of the nine money tables, so both triggers are
-- declared in ca_declared_money_triggers below, in this migration.
--
-- ATOMICITY. The acceptance trigger swallows nothing: if the acceptance row
-- cannot be written, the tournament INSERT fails with it. ON CONFLICT DO
-- NOTHING covers only a row that already exists for the same event.
--
-- MULTI-FLIGHT. parent_event_id is copied from tournaments.parent_tournament_id
-- at acceptance. trg_tournaments_refuse_unbuilt_multi_day refuses a non-null
-- parent today, so in production this is NULL until multi-day ships; the
-- inheritance rule in fn_event_continuation is in place for that day.
--
-- LOCKING. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on tournaments until
-- COMMIT, so the triggers are created after every other object and are
-- followed only by the backfill (a short read of non-terminal rows), the
-- grants and the post-image checks. Trigger first, backfill second: a
-- tournament committed before the lock is backfilled, one inserted after it
-- fires the trigger, and ON CONFLICT makes the overlap harmless.
--
-- HOW A READER SEES THIS IS LIVE. The objects are found by name by
-- scripts/ci/check-migrations-are-live.mjs; the lines below prove the grants,
-- the owner's exclusion and the backfill, read-only.
-- @live-proof: (SELECT to_regclass('public.platform_capabilities') IS NOT NULL AND to_regclass('public.platform_capability_events') IS NOT NULL AND to_regclass('public.accepted_event_operations') IS NOT NULL AND to_regprocedure('public.fn_capability_available(text)') IS NOT NULL AND to_regprocedure('public.fn_platform_capabilities()') IS NOT NULL AND to_regprocedure('public.fn_set_capability_readiness(text,text,text,bigint,jsonb)') IS NOT NULL AND to_regprocedure('public.fn_event_continuation(text,uuid)') IS NOT NULL)
-- @live-proof: (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.tournaments'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgname IN ('trg_tournaments_record_acceptance','trg_tournaments_record_conclusion'))
-- @live-proof: (SELECT bool_and(NOT has_table_privilege(r, c, 'SELECT') AND NOT has_table_privilege(r, c, 'INSERT') AND NOT has_table_privilege(r, c, 'UPDATE') AND NOT has_table_privilege(r, c, 'DELETE')) FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest(ARRAY['public.platform_capabilities','public.platform_capability_events','public.accepted_event_operations']) c)
-- @live-proof: (SELECT has_function_privilege('anon','public.fn_platform_capabilities()','EXECUTE') AND has_function_privilege('authenticated','public.fn_platform_capabilities()','EXECUTE') AND NOT has_function_privilege('anon','public.fn_set_capability_readiness(text,text,text,bigint,jsonb)','EXECUTE') AND has_function_privilege('service_role','public.fn_set_capability_readiness(text,text,text,bigint,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_capability_available(text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_event_continuation(text,uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_event_continuation(text,uuid)','EXECUTE') AND has_function_privilege('service_role','public.fn_event_continuation(text,uuid)','EXECUTE'))
-- @live-proof: (SELECT readiness = 'excluded' AND NOT public.fn_capability_available('variant.ofc') FROM public.platform_capabilities WHERE capability_id = 'variant.ofc')
-- @live-proof: (SELECT count(*) = 0 FROM public.tournaments t WHERE t.status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING') AND NOT EXISTS (SELECT 1 FROM public.accepted_event_operations a WHERE a.event_kind = 'tournament' AND a.event_id = t.id))
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. PRECONDITIONS. The status vocabulary the triggers and the backfill
--    classify is exactly the one they were written against, the columns they
--    copy exist, and the one staff authority exists.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.fn_is_platform_admin()') IS NULL THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_STAFF_AUTHORITY_MISSING' USING ERRCODE = '55000';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid)
        FROM pg_constraint c
       WHERE c.conrelid = 'public.tournaments'::regclass
         AND c.conname = 'tournaments_status_check')
     IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''ANNOUNCED''::text, ''REGISTERING''::text, ''LATE_REG''::text, ''RUNNING''::text, ''COMPLETING''::text, ''COMPLETED''::text, ''CANCELLED''::text])))'
  THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_TOURNAMENT_STATUS_VOCABULARY_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.tournaments'::regclass AND NOT a.attisdropped
         AND (a.attname, format_type(a.atttypid, a.atttypmod)) IN
             (('id','uuid'),('status','text'),('club_id','uuid'),('union_id','uuid'),
              ('parent_tournament_id','uuid'),('created_at','timestamp with time zone'))) <> 6
  THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_TOURNAMENT_COLUMNS_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.tournaments'::regclass
                AND t.tgname IN ('trg_tournaments_record_acceptance','trg_tournaments_record_conclusion')) THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_TRIGGER_NAME_TAKEN' USING ERRCODE = '42710';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. THE REGISTRY.
-- ---------------------------------------------------------------------------
CREATE TABLE public.platform_capabilities (
  capability_id      text PRIMARY KEY
                     CHECK (capability_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  rule_version       text NOT NULL CHECK (btrim(rule_version) <> ''),
  title              text NOT NULL CHECK (btrim(title) <> '' AND strpos(title, chr(8212)) = 0),
  scope              text NOT NULL
                     CHECK (scope IN ('platform','club','union','cash_table','tournament')),
  supported_variants text[] NOT NULL DEFAULT '{}',
  compatibility      jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(compatibility) = 'object'),
  readiness          text NOT NULL
                     CHECK (readiness IN ('excluded','planned','implemented','tested','deployed','production_verified')),
  readiness_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(readiness_evidence) = 'object'),
  revision           bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- An available rung is a claim about what is running; it carries its proof.
  CONSTRAINT platform_capabilities_available_carries_evidence
    CHECK (readiness NOT IN ('deployed','production_verified') OR readiness_evidence <> '{}'::jsonb)
);

CREATE TABLE public.platform_capability_events (
  id             bigserial PRIMARY KEY,
  capability_id  text NOT NULL REFERENCES public.platform_capabilities(capability_id),
  revision       bigint NOT NULL,
  from_readiness text NULL,
  to_readiness   text NOT NULL,
  rule_version   text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor          uuid NULL,
  actor_role     text NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT platform_capability_events_one_per_revision UNIQUE (capability_id, revision)
);

CREATE FUNCTION public.fn_platform_capability_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'CAPABILITY_HISTORY_IS_APPEND_ONLY: % refused', TG_OP USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER trg_platform_capability_events_append_only
  BEFORE UPDATE OR DELETE ON public.platform_capability_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_platform_capability_events_append_only();
CREATE TRIGGER trg_platform_capability_events_no_truncate
  BEFORE TRUNCATE ON public.platform_capability_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_platform_capability_events_append_only();

-- Seed, as of this work. From here on readiness moves only through
-- fn_set_capability_readiness, never by hand.
--
-- cash.insurance_ev_cashout: the design listed this as a tournament feature;
-- it is not. ServerTableEngineBase.applyRunItTwiceConfig enables insurance
-- only when insurance_enabled AND the table is not a tournament table, so its
-- id and scope are cash. supported_variants is EMPTY on purpose: the engine
-- has no variant allow-list for insurance. Its gates are cash table,
-- insurance_enabled, a single-board hand (no double-board bomb pot), fewer
-- than five board cards and at least two all-in players; Omaha and short deck
-- are priced by the equity worker (isOmahaVariant / isShortDeckVariant).
-- Readiness is deployed, not production_verified: the repository records the
-- engine and database halves merged and applied (#1603, #1613, #1624; the
-- three 20260828 insurance migrations, reconciliation "insurance_bank ok"
-- read live), but no observed live EV cashout, and the 2026-09-04 sweep
-- measured zero insurance transactions in 24 hours.
--
-- cash.fixed_limit.kill_pots: flh and flo8 are exactly FIXED_LIMIT_VARIANTS in
-- server/src/engine/BettingStructure.ts.
--
-- variant.ofc: owner decision, NO OFC. Excluded is not a readiness rung the
-- writer can enter or leave.
INSERT INTO public.platform_capabilities
  (capability_id, rule_version, title, scope, supported_variants, compatibility, readiness, readiness_evidence)
VALUES
  ('club.membership_cap', 'club-membership-v2', 'Club Membership Cap', 'club',
   '{}', '{}', 'implemented', '{}'),
  ('tournament.discovery.trait_filters', 'trait-filters-v1', 'Tournament Trait Filters', 'tournament',
   '{}', '{}', 'tested', '{}'),
  ('cash.fixed_limit.kill_pots', 'kill-v1', 'Fixed Limit Kill Pots', 'cash_table',
   '{flh,flo8}', '{}', 'planned', '{}'),
  ('tournament.multi_day.single_flight', 'multi-day-v1', 'Multi-Day Tournaments', 'tournament',
   '{}', '{}', 'planned', '{}'),
  ('tournament.multi_day.multi_flight', 'multi-flight-v1', 'Multi-Flight Tournaments', 'tournament',
   '{}', '{"requires":["tournament.multi_day.single_flight"]}', 'planned', '{}'),
  ('cash.insurance_ev_cashout', 'insurance-v1', 'Insurance And EV Cashout', 'cash_table',
   '{}', '{}', 'deployed',
   jsonb_build_object(
     'pull_requests', jsonb_build_array(1603, 1613, 1624),
     'commits', jsonb_build_array('fb4021532', '8779077e9', '41e2c5910'),
     'installed_migrations', jsonb_build_array(
       '20260828120000_insurance_kind_offer_events',
       '20260828120500_insurance_reconciliation_and_views',
       '20260828121000_insurance_bank_entity_type_in_reconcile_check'),
     'record', 'docs/changelog/2026-08-28-insurance-round2-cashout-sidepots-observability.md',
     'engine_gate', 'server/src/engine/ServerTableEngineBase.ts applyRunItTwiceConfig: insurance_enabled and not a tournament table',
     'not_production_verified_because', 'no observed live EV cashout is recorded; docs/changelog/2026-09-04-chip-std-verification-sweep.md measured zero insurance transactions in 24 hours')),
  ('variant.ofc', 'retired', 'Open Face Chinese', 'platform',
   '{}', '{}', 'excluded',
   '{"owner_decision":"No OFC. Never surfaced as available.","decided":"2026-09-22"}');

INSERT INTO public.platform_capability_events
  (capability_id, revision, from_readiness, to_readiness, rule_version, evidence, actor, actor_role)
SELECT c.capability_id, c.revision, NULL, c.readiness, c.rule_version, c.readiness_evidence, NULL, 'migration'
  FROM public.platform_capabilities c;

CREATE FUNCTION public.fn_capability_available(p_capability_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(
    (SELECT c.readiness IN ('deployed','production_verified')
       FROM public.platform_capabilities c
      WHERE c.capability_id = p_capability_id),
    false);
$fn$;

-- The public projection. Capabilities are not secret; their evidence is not
-- part of what a client needs, so it is not in here.
CREATE FUNCTION public.fn_platform_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.capability_id,
        'version', c.rule_version,
        'title', c.title,
        'scope', c.scope,
        'variants', to_jsonb(c.supported_variants),
        'compatibility', c.compatibility,
        'readiness', c.readiness,
        'available', c.readiness IN ('deployed','production_verified'))
      ORDER BY c.capability_id),
    '[]'::jsonb)
  FROM public.platform_capabilities c;
$fn$;

CREATE FUNCTION public.fn_set_capability_readiness(
  p_capability_id text,
  p_readiness text,
  p_rule_version text,
  p_expected_revision bigint,
  p_evidence jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_actor_role text;
  v_evidence jsonb := COALESCE(p_evidence, '{}'::jsonb);
  v_row public.platform_capabilities;
  v_from text;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor_role := 'service_role';
  ELSIF public.fn_is_platform_admin() THEN
    v_actor_role := 'platform_admin';
  ELSE
    RAISE EXCEPTION 'CAPABILITY_WRITER_REQUIRES_SERVICE_ROLE_OR_PLATFORM_STAFF' USING ERRCODE = '42501';
  END IF;

  IF p_readiness IS NULL OR p_readiness NOT IN
       ('excluded','planned','implemented','tested','deployed','production_verified') THEN
    RAISE EXCEPTION 'CAPABILITY_READINESS_UNKNOWN: %', p_readiness USING ERRCODE = '22023';
  END IF;
  IF p_rule_version IS NULL OR btrim(p_rule_version) = '' THEN
    RAISE EXCEPTION 'CAPABILITY_RULE_VERSION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'CAPABILITY_EXPECTED_REVISION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'CAPABILITY_EVIDENCE_MUST_BE_AN_OBJECT' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM public.platform_capabilities
   WHERE capability_id = p_capability_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPABILITY_UNKNOWN: %', p_capability_id USING ERRCODE = 'P0002';
  END IF;

  -- Exclusion is an owner decision taken in a migration, not a readiness step.
  IF v_row.readiness = 'excluded' OR p_readiness = 'excluded' THEN
    RAISE EXCEPTION 'CAPABILITY_EXCLUSION_IS_AN_OWNER_DECISION: %', p_capability_id USING ERRCODE = '55000';
  END IF;

  -- Replay of the transition that produced the current row: same target, same
  -- expected revision, same evidence. Return it; record nothing twice.
  IF v_row.revision = p_expected_revision + 1
     AND v_row.readiness = p_readiness
     AND v_row.rule_version = p_rule_version
     AND v_row.readiness_evidence = v_evidence
     AND EXISTS (SELECT 1 FROM public.platform_capability_events e
                  WHERE e.capability_id = p_capability_id
                    AND e.revision = v_row.revision
                    AND e.to_readiness = p_readiness
                    AND e.rule_version = p_rule_version
                    AND e.evidence = v_evidence) THEN
    RETURN to_jsonb(v_row) || jsonb_build_object('event_recorded', false);
  END IF;

  IF v_row.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'CAPABILITY_REVISION_STALE: % expected revision %, current %',
      p_capability_id, p_expected_revision, v_row.revision USING ERRCODE = '40001';
  END IF;

  IF p_readiness IN ('deployed','production_verified') AND v_evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'CAPABILITY_EVIDENCE_REQUIRED: % needs evidence to become %',
      p_capability_id, p_readiness USING ERRCODE = '22023';
  END IF;

  -- Asking for exactly what is already there is not a transition.
  IF v_row.readiness = p_readiness
     AND v_row.rule_version = p_rule_version
     AND v_row.readiness_evidence = v_evidence THEN
    RETURN to_jsonb(v_row) || jsonb_build_object('event_recorded', false);
  END IF;

  v_from := v_row.readiness;
  UPDATE public.platform_capabilities
     SET readiness = p_readiness,
         rule_version = p_rule_version,
         readiness_evidence = v_evidence,
         revision = revision + 1,
         updated_at = clock_timestamp()
   WHERE capability_id = p_capability_id
  RETURNING * INTO v_row;

  INSERT INTO public.platform_capability_events
    (capability_id, revision, from_readiness, to_readiness, rule_version, evidence, actor, actor_role)
  VALUES
    (p_capability_id, v_row.revision, v_from, p_readiness, p_rule_version, v_evidence, auth.uid(), v_actor_role);

  RETURN to_jsonb(v_row) || jsonb_build_object('event_recorded', true);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. ACCEPTED-EVENT CONTINUATION. No foreign key to tournaments, by rule
--    (CLAUDE.md section 2 rule 7): an orphan acceptance row is harmless, a
--    lock on tournaments is not.
-- ---------------------------------------------------------------------------
CREATE TABLE public.accepted_event_operations (
  event_kind          text NOT NULL CHECK (event_kind IN ('tournament')),
  event_id            uuid NOT NULL,
  parent_event_id     uuid NULL,
  club_id             uuid NULL,
  union_id            uuid NULL,
  accepted_at         timestamptz NOT NULL,
  accepted_by         uuid NULL,
  authorization_basis jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(authorization_basis) = 'object'),
  capability_versions jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(capability_versions) = 'object'),
  continuation        text NOT NULL DEFAULT 'through_conclusion'
                      CHECK (continuation IN ('through_conclusion')),
  concluded_at        timestamptz NULL,
  conclusion          text NULL CHECK (conclusion IN ('completed','cancelled')),
  PRIMARY KEY (event_kind, event_id),
  CONSTRAINT accepted_event_operations_conclusion_is_whole
    CHECK ((concluded_at IS NULL) = (conclusion IS NULL))
);

CREATE INDEX accepted_event_operations_parent_idx
  ON public.accepted_event_operations (event_kind, parent_event_id)
  WHERE parent_event_id IS NOT NULL;

-- Kept tiny: one insert, no exception handler. A failure here fails the
-- tournament insert, which is the point.
CREATE FUNCTION public.fn_tournament_record_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.accepted_event_operations
    (event_kind, event_id, parent_event_id, club_id, union_id, accepted_at, accepted_by,
     authorization_basis, capability_versions, concluded_at, conclusion)
  VALUES
    ('tournament', NEW.id, NEW.parent_tournament_id, NEW.club_id, NEW.union_id, now(), auth.uid(),
     '{"operator_access":"legacy_free","recorded_by":"acceptance_trigger"}'::jsonb,
     COALESCE((SELECT jsonb_object_agg(c.capability_id, c.rule_version)
                 FROM public.platform_capabilities c
                WHERE c.readiness IN ('deployed','production_verified')), '{}'::jsonb),
     CASE WHEN NEW.status IN ('COMPLETED','CANCELLED') THEN now() END,
     CASE NEW.status WHEN 'COMPLETED' THEN 'completed' WHEN 'CANCELLED' THEN 'cancelled' END)
  ON CONFLICT (event_kind, event_id) DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE FUNCTION public.fn_tournament_record_conclusion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  UPDATE public.accepted_event_operations
     SET concluded_at = now(),
         conclusion = CASE NEW.status WHEN 'COMPLETED' THEN 'completed' ELSE 'cancelled' END
   WHERE event_kind = 'tournament'
     AND event_id = NEW.id
     AND concluded_at IS NULL;
  RETURN NULL;
END
$fn$;

-- Reader for the commerce workstream. continuation_active is true while the
-- event, or any economic ancestor through parent_event_id, is accepted and not
-- concluded. It never answers for an event that was never accepted.
CREATE FUNCTION public.fn_event_continuation(p_event_kind text, p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  WITH RECURSIVE chain AS (
    SELECT a.event_kind, a.event_id, a.parent_event_id, a.concluded_at, 0 AS depth
      FROM public.accepted_event_operations a
     WHERE a.event_kind = p_event_kind AND a.event_id = p_event_id
    UNION ALL
    SELECT p.event_kind, p.event_id, p.parent_event_id, p.concluded_at, c.depth + 1
      FROM chain c
      JOIN public.accepted_event_operations p
        ON p.event_kind = c.event_kind AND p.event_id = c.parent_event_id
     WHERE c.depth < 16
  ),
  via AS (
    SELECT ch.event_id FROM chain ch WHERE ch.concluded_at IS NULL ORDER BY ch.depth LIMIT 1
  )
  SELECT jsonb_build_object(
           'accepted', a.event_id IS NOT NULL,
           'continuation_active', (SELECT count(*) FROM via) > 0,
           'continuation_via', (SELECT v.event_id FROM via v),
           'accepted_at', a.accepted_at,
           'club_id', a.club_id,
           'union_id', a.union_id,
           'parent_event_id', a.parent_event_id,
           'concluded_at', a.concluded_at,
           'conclusion', a.conclusion,
           'capability_versions', COALESCE(a.capability_versions, '{}'::jsonb))
    FROM (SELECT 1) AS one
    LEFT JOIN public.accepted_event_operations a
      ON a.event_kind = p_event_kind AND a.event_id = p_event_id;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. PRIVILEGES. Supabase grants anon and authenticated on every new object
--    by default, so every grant here is explicit. Tables: SELECT for
--    service_role only; writes go through the definer functions and triggers.
-- ---------------------------------------------------------------------------
ALTER TABLE public.platform_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_capability_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accepted_event_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.platform_capabilities FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.platform_capability_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accepted_event_operations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.platform_capability_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.platform_capabilities TO service_role;
GRANT SELECT ON TABLE public.platform_capability_events TO service_role;
GRANT SELECT ON TABLE public.accepted_event_operations TO service_role;

REVOKE ALL ON FUNCTION public.fn_platform_capability_events_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_record_acceptance() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_tournament_record_conclusion() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_capability_available(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_platform_capabilities() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_set_capability_readiness(text,text,text,bigint,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_event_continuation(text,uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_capability_available(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_platform_capabilities() TO anon, authenticated, service_role;
-- authenticated reaches the writer only to be asked fn_is_platform_admin().
GRANT EXECUTE ON FUNCTION public.fn_set_capability_readiness(text,text,text,bigint,jsonb) TO authenticated, service_role;
-- service_role only: the answer carries club_id/union_id for any event id, and
-- tournaments' own SELECT policy hides those from non-members.
GRANT EXECUTE ON FUNCTION public.fn_event_continuation(text,uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. THE TWO TRIGGERS ON tournaments, then the backfill. Last, because
--    CREATE TRIGGER holds SHARE ROW EXCLUSIVE on tournaments until COMMIT.
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_tournaments_record_acceptance
  AFTER INSERT ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_record_acceptance();

CREATE TRIGGER trg_tournaments_record_conclusion
  AFTER UPDATE OF status ON public.tournaments
  FOR EACH ROW
  WHEN (NEW.status IN ('COMPLETED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.fn_tournament_record_conclusion();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
  ('tournaments', 'trg_tournaments_record_acceptance',
   'AFTER INSERT. Writes the acceptance row for the new tournament into accepted_event_operations (ON CONFLICT DO NOTHING) and nothing else. Never modifies the tournament row, moves no chips or diamonds; a failure fails the insert. 20260924025555.'),
  ('tournaments', 'trg_tournaments_record_conclusion',
   'AFTER UPDATE OF status, only when status becomes COMPLETED or CANCELLED. Stamps concluded_at/conclusion on the event''s accepted_event_operations row and nothing else. Never modifies the tournament row, moves no chips or diamonds. 20260924025555.');

-- Every tournament that is not terminal at install time is an event already
-- accepted under free operator access. The rules in force when each was
-- accepted were never recorded, so capability_versions stays empty rather
-- than claim today's versions for yesterday's events.
INSERT INTO public.accepted_event_operations
  (event_kind, event_id, parent_event_id, club_id, union_id, accepted_at, accepted_by,
   authorization_basis, capability_versions)
SELECT 'tournament', t.id, t.parent_tournament_id, t.club_id, t.union_id,
       COALESCE(t.created_at, now()), NULL,
       '{"operator_access":"legacy_free","recorded_by":"install_backfill"}'::jsonb,
       '{}'::jsonb
  FROM public.tournaments t
 WHERE t.status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING')
ON CONFLICT (event_kind, event_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. POST-IMAGE. What this migration claims, checked before COMMIT.
-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  v_bad bigint;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tournaments t
   WHERE t.status IN ('ANNOUNCED','REGISTERING','LATE_REG','RUNNING','COMPLETING')
     AND NOT EXISTS (SELECT 1 FROM public.accepted_event_operations a
                      WHERE a.event_kind = 'tournament' AND a.event_id = t.id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_BACKFILL_INCOMPLETE: % tournaments', v_bad USING ERRCODE = '55000';
  END IF;

  IF (SELECT count(*) FROM public.platform_capabilities) <> 7
     OR (SELECT count(*) FROM public.platform_capability_events) <> 7 THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_SEED_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  IF public.fn_capability_available('variant.ofc') THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_OFC_AVAILABLE' USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['anon','authenticated']) r
     CROSS JOIN unnest(ARRAY['public.platform_capabilities','public.platform_capability_events',
                             'public.accepted_event_operations']) c
     WHERE has_table_privilege(r, c, 'SELECT') OR has_table_privilege(r, c, 'INSERT')
        OR has_table_privilege(r, c, 'UPDATE') OR has_table_privilege(r, c, 'DELETE'))
     OR has_function_privilege('anon', 'public.fn_set_capability_readiness(text,text,text,bigint,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_capability_available(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_event_continuation(text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_event_continuation(text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_record_acceptance()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_record_conclusion()', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.fn_platform_capabilities()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'CAPABILITY_REGISTRY_GRANTS_NOT_AS_DECLARED' USING ERRCODE = '42501';
  END IF;
END
$post$;

COMMIT;
