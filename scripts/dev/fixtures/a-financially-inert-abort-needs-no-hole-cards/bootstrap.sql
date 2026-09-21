-- The minimum schema smarter_private.f06_retired_origin_snapshot(jsonb) and
-- smarter_private.f06_retained_mtt_abort_snapshot(jsonb) read, with
-- production's column types for every column either function compares or
-- aggregates. Nothing here is a copy of production data: the identifiers of
-- the Noon cohort are reproduced because
-- smarter_private.f06_retired_origin_cohort(uuid) is IMMUTABLE and carries
-- them as a literal, so the retired-origin branch cannot be exercised under
-- any other id. No card, stack, hand or player value is taken from production.
\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA smarter_private;
GRANT USAGE ON SCHEMA auth, extensions, smarter_private TO anon, authenticated, service_role;

-- Supabase's auth.role(), driven by a GUC so a scenario can run as the wrong
-- caller and still be refused by the functions' own first assertion.
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT coalesce(current_setting('request.jwt.claim.role', true), 'service_role') $$;
-- Reached only from the accepted_zeros loop, which every scenario leaves empty.
CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea LANGUAGE sql IMMUTABLE
AS $$ SELECT sha256($1) $$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'probe', status text NOT NULL,
  format_contract text);
CREATE TABLE public.tables (
  id uuid PRIMARY KEY, tournament_id uuid, status text, is_deleted boolean,
  f06_lifecycle bigint NOT NULL);
CREATE TABLE public.tournament_players (
  id uuid PRIMARY KEY, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
  chips integer, status text, table_id uuid, seat_number integer,
  terminal_closed_at timestamptz);
CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY, table_id uuid NOT NULL, seat_number integer NOT NULL,
  user_id uuid, stack numeric, joined_at timestamptz, left_at timestamptz,
  occupancy_id uuid NOT NULL, terminal_closed_at timestamptz);
CREATE TABLE public.hand_state_snapshots (
  id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number integer NOT NULL,
  state_json jsonb NOT NULL, config_json jsonb NOT NULL DEFAULT '{}',
  dealer_seat integer NOT NULL DEFAULT 0, players_json jsonb NOT NULL DEFAULT '[]',
  stage text NOT NULL, is_complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  pending_deadlines jsonb NOT NULL DEFAULT '{}', disconnect_states jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT hand_state_snapshots_table_hand_key UNIQUE (table_id, hand_number));
CREATE TABLE public.table_hole_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid NOT NULL,
  hand_number bigint NOT NULL, user_id uuid NOT NULL, seat_number integer NOT NULL,
  cards jsonb NOT NULL DEFAULT '[]', created_at timestamptz DEFAULT now(),
  CONSTRAINT table_hole_cards_table_hand_user_unique UNIQUE (table_id, hand_number, user_id));
CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL,
  payload_hash text NOT NULL DEFAULT repeat('0',64), stack_result jsonb NOT NULL DEFAULT '{}',
  committed_at timestamptz NOT NULL DEFAULT now(), post_commit_payload jsonb,
  post_commit_request_hash text, post_commit_payload_hash text,
  post_commit_completed_at timestamptz, post_commit_result jsonb,
  PRIMARY KEY (table_id, hand_number));
CREATE TABLE public.hand_history (
  id uuid PRIMARY KEY, table_id uuid, tournament_id uuid, hand_number integer);
CREATE TABLE public.hand_private_state (
  id uuid PRIMARY KEY, hand_id uuid NOT NULL, player_id uuid NOT NULL,
  table_id uuid, hand_number integer);
CREATE TABLE public.hand_projection_outbox (
  hand_id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.ca_settlements (
  id uuid PRIMARY KEY, settlement_type text NOT NULL, external_ref text NOT NULL DEFAULT '',
  state text NOT NULL, table_id uuid, tournament_id uuid, hand_id uuid,
  totals jsonb NOT NULL DEFAULT '{}', error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.settlement_idempotency_keys (
  table_id uuid NOT NULL, hand_id uuid NOT NULL, status text NOT NULL, result jsonb,
  error text, attempt_count integer NOT NULL DEFAULT 1,
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY (table_id, hand_id));
CREATE TABLE public.tournament_seat_move_receipts (
  request_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, user_id uuid NOT NULL,
  source_table_id uuid NOT NULL, destination_table_id uuid NOT NULL,
  source_seat_id uuid NOT NULL, destination_seat_id uuid NOT NULL,
  source_seat_number integer NOT NULL, destination_seat_number integer NOT NULL,
  source_mode text NOT NULL DEFAULT 'break', stack numeric NOT NULL,
  moved_at timestamptz NOT NULL);
CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY, instance_id text NOT NULL, engine_version text,
  acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL,
  lease_generation uuid NOT NULL, protocol_version integer NOT NULL);
CREATE TABLE public.engine_leader (
  id boolean PRIMARY KEY, instance_id text NOT NULL, engine_version text,
  acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL);
CREATE TABLE public.engine_maintenance_break (
  id boolean PRIMARY KEY, enforce_freeze boolean NOT NULL DEFAULT false,
  announced_at timestamptz, phase text, break_started_at timestamptz, break_ends_at timestamptz);

CREATE TABLE smarter_private.f06_hand_permits (
  permit_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, table_id uuid NOT NULL,
  lifecycle bigint NOT NULL, hand_number bigint NOT NULL, custody_id uuid NOT NULL,
  generation uuid NOT NULL, state text NOT NULL DEFAULT 'reserved', evidence_id uuid,
  CONSTRAINT f06_hand_permits_state_check CHECK (state = ANY (ARRAY['reserved'::text,'accepted'::text,'never_started'::text,'aborted_unsettled'::text])),
  CONSTRAINT f06_hand_permits_table_id_hand_number_key UNIQUE (table_id, hand_number));
CREATE TABLE smarter_private.f06_hand_dispatch (permit_id uuid PRIMARY KEY, xid bigint NOT NULL);
CREATE TABLE smarter_private.f06_operations (
  break_id uuid PRIMARY KEY, ordinal bigint NOT NULL DEFAULT 1, tournament_id uuid NOT NULL,
  source_table_id uuid NOT NULL, lifecycle bigint NOT NULL, boundary_id uuid NOT NULL,
  origin_generation uuid NOT NULL, state text NOT NULL, manifest jsonb,
  revision bigint NOT NULL DEFAULT 1, custody_id uuid, custody_generation uuid,
  cleanup_kind text, close_receipt jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  abort_receipt_id uuid);
CREATE TABLE smarter_private.f06_members (
  break_id uuid NOT NULL, user_id uuid NOT NULL, source_seat_id uuid NOT NULL,
  source_seat_number integer NOT NULL, occupancy_id uuid NOT NULL,
  PRIMARY KEY (break_id, user_id));
CREATE TABLE smarter_private.f06_attempts (
  request_id uuid PRIMARY KEY, break_id uuid NOT NULL, user_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1, predecessor uuid, amendment_id uuid,
  amendment_payload jsonb, destination_table_id uuid NOT NULL,
  destination_seat_number integer NOT NULL, generation uuid NOT NULL,
  state text NOT NULL, receipt jsonb);
CREATE TABLE smarter_private.f06_dispatch (
  request_id uuid PRIMARY KEY, xid bigint NOT NULL, occupancy_id uuid NOT NULL,
  source_seat_id uuid NOT NULL, lifecycle bigint NOT NULL);
CREATE TABLE smarter_private.hand_submissions (
  submission_id uuid PRIMARY KEY, table_id uuid NOT NULL, hand_number bigint NOT NULL,
  instance_id text NOT NULL, lease_generation uuid NOT NULL, request jsonb NOT NULL,
  request_hash text NOT NULL, retained_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE smarter_private.f06_unsettled_hand_aborts (
  receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, table_id uuid NOT NULL,
  generation uuid NOT NULL, permit_id uuid NOT NULL, hand_number bigint NOT NULL,
  break_id uuid NOT NULL, expected jsonb NOT NULL, outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), retired_lease_generation uuid);
CREATE TABLE smarter_private.f06_generation_aborts (
  receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, generation uuid NOT NULL,
  expected jsonb NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE smarter_private.f06_mixed_abort_generations (
  tournament_id uuid NOT NULL, generation uuid NOT NULL, receipt_id uuid NOT NULL,
  PRIMARY KEY (tournament_id, generation));
CREATE TABLE smarter_private.f06_retired_manager_origins (
  receipt_id uuid PRIMARY KEY, tournament_id uuid NOT NULL, origin_generation uuid NOT NULL,
  physical_proof jsonb NOT NULL, canonical_proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

-- Live definitions, verbatim.
CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public','pg_temp'
AS $function$
  SELECT 30;
$function$;
CREATE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS timestamptz
 LANGUAGE sql SET search_path TO 'public','pg_temp'
AS $function$ SELECT NULL::timestamptz $function$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean
 LANGUAGE sql SET search_path TO 'public','pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;
CREATE FUNCTION smarter_private.f06_retired_origin_lock(t uuid) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:retired-origin:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETIRED_CLAIM_BUSY' USING ERRCODE='40001'; END IF;
END $function$;
CREATE FUNCTION smarter_private.f06_try_lane(t uuid) RETURNS void
 LANGUAGE plpgsql SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF t IS NOT NULL AND (NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0))) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
END $function$;
CREATE FUNCTION smarter_private.f06_generation_aborted(t uuid, g uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','smarter_private'
AS $function$
BEGIN
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=t AND generation=g);
END $function$;
-- Reached only from the prior_commit_plus_inbound_moves branch, which no
-- scenario here takes; present so the function body resolves.
CREATE FUNCTION smarter_private.f06_prior_committed_stacks(p uuid, q jsonb, r jsonb) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path TO 'pg_catalog' AS $function$ SELECT q $function$;

-- smarter_private.f06_retired_origin_cohort(uuid) and
-- smarter_private.f06_retired_origin_begin(jsonb), verbatim from
-- supabase/migrations/20260919024642 (lines 11 and 41-98), which is the
-- migration that installed the live bodies. The cohort is IMMUTABLE and
-- carries the retired-origin identifiers as a literal, so the branch under
-- test cannot be reached with any other tournament, table or permit id.
CREATE FUNCTION smarter_private.f06_retired_origin_cohort(t uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $cohort$ SELECT $data${"5a387a75-754a-416e-8fee-b85b15fc2702":{"engines":{"09f5e9eb-df66-4e55-a3c8-4385d27631e2":"771c20b5-a303-43fe-a6a8-fda2012ac4eb","12482d21-a767-474f-aa1e-6b78ba368968":"5e7ef136-a773-4e0b-b0e5-7c311693f50b","2c621856-e728-4e8b-bf08-4c56746a8649":"71ad1853-ab7c-4b29-9170-9e35819e665b","49a444ac-553a-4f44-a36f-92781d10a646":"10a16e4e-c347-4e59-b04c-4c6341ba2e5c","623b526d-0901-4c59-aec5-f8e459af7a6c":"2c4582be-ad47-4d17-b41f-d0524a021983","6d8512e3-899d-442b-8d6c-7c57a5f4a1f1":"28fd7b0c-70bc-4d95-a423-0940518f3e7c","7af8a050-53da-4094-8d8d-5c38565eedfc":"42985b85-213e-47e4-a0f2-8288fc3f0462","815d35dd-a6d5-4469-b0aa-e386cc2145b9":"2ffa5273-5a36-4fac-b4e4-c9deb8c6b783","98232ade-1f3d-4541-902f-cd13697bc0b8":"831836ee-98eb-46cd-bec2-50b35a288c28","9bf11d84-684d-4069-916c-c7b5bb397d21":"a75b056b-4e70-440a-9c34-5a44e1f78856","cde664d1-8c53-49dd-9534-bc298ed25a76":"a73e4809-548f-485d-b25e-4bbb0dd73c73","dbd8b7ea-1a99-494f-b564-f86d412dc764":"ab05c24a-69f2-4194-b822-5a934a8a423b","dfe93cf3-157c-45ea-b16b-6c27ab9ad3fe":"bcd61ad8-8a57-47bc-92c5-65dfe56d9261","fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16":"4e4fd230-30a1-4244-9ca6-eb64655f251b"},"generation":"66291622-e7d1-4816-8c33-26ff1f092446","manager_id":"d55415ea-1306-410b-a336-bc6f7ea83944","permit":{"custody_id":"37815b8d-668b-472d-bc0c-3c5ae0da55b3","evidence_id":null,"generation":"66291622-e7d1-4816-8c33-26ff1f092446","hand_number":12942021,"lifecycle":283878,"permit_id":"098c0945-54f9-4c48-a600-3b8845da267b","state":"reserved","table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","tournament_id":"5a387a75-754a-416e-8fee-b85b15fc2702"},"receipt_id":"7d0f56e9-10ce-4c2f-b337-101b75924257"},"615783bf-15e3-40b7-9368-75f21b6ac53b":{"engines":{"383aa2c7-79f1-4937-9d7e-8c49126fce8b":"72688412-7be5-4ebc-afed-2fba5ad8d747","5973d7f6-5a52-4d78-aa92-cba86e19d4ea":"0e362019-a967-4d15-b50e-68dbbe787dfd","737b1a84-da46-459c-b0e3-bba5b23171c0":"48f0243d-176c-4209-b692-076edd23b339","9e18dc43-a81a-4a4f-a360-4f624c60699b":"d4e2be78-93f4-408a-a9ea-3ea199158312","9f30d335-8262-4872-8926-3ddf1fefe75c":"99065d93-c07d-42fa-bda9-74edd2e04a6e","9fdd5393-6fd9-4497-85b2-f98b89cf168d":"f9a26fe0-1f69-4f8e-bf67-d5cc72f600d4","ac93f9eb-d288-400a-b626-b3331a1de466":"31a7dfa8-bdbc-4b8c-aad8-9a57b2d0e2b1","d6199e5e-7c40-4560-afd9-f1a135031097":"4c9965d7-a041-4628-a319-f81e4e709c62","f6bd2252-5c11-40df-b842-cdf99a1e8323":"31bac5c5-cafc-4aca-a4e6-50693e3dace5"},"generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","manager_id":"bf78d180-dacc-41c8-80dd-765b6fe6d9c4","permit":{"custody_id":"49542b5a-a662-4d79-b035-c82e9ecdbc88","evidence_id":null,"generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","hand_number":12943630,"lifecycle":289478,"permit_id":"14cddb92-cf9d-46fd-80f7-6379695c0032","state":"reserved","table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","tournament_id":"615783bf-15e3-40b7-9368-75f21b6ac53b"},"receipt_id":"16268739-c7c3-4d38-8a8f-e8f08ac0591b"}}$data$::jsonb->t::text $cohort$;
CREATE FUNCTION smarter_private.f06_retired_origin_begin(p_input jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE t uuid:=(p_input->>'tournament_id')::uuid; g uuid:=(p_input->>'generation')::uuid;
 cohort jsonb:=smarter_private.f06_retired_origin_cohort(t); physical jsonb:=p_input->'physical';
 leader jsonb; item jsonb; pairs jsonb; instant timestamptz:=clock_timestamp();
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF cohort IS NULL OR cohort->>'generation' IS DISTINCT FROM g::text
 OR p_input->'lease' IS DISTINCT FROM 'null'::jsonb
 OR p_input#>'{hands,0,permit}' IS DISTINCT FROM cohort->'permit' THEN
 RAISE EXCEPTION 'F06_RETIRED_ORIGIN_SCOPE_CHANGED'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
 RAISE EXCEPTION 'F06_RETRY_MAINTENANCE_LANE' USING ERRCODE='40001'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 PERFORM smarter_private.f06_retired_origin_lock(t);
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t FOR UPDATE;
 IF FOUND THEN RAISE EXCEPTION 'F06_RETIRED_COMPETING_LEASE'; END IF;
 SELECT to_jsonb(e) INTO leader FROM public.engine_leader e WHERE id=true FOR SHARE;
 IF leader IS NULL OR leader->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR leader->>'engine_version' IS DISTINCT FROM '8825af51'
 OR (leader->>'heartbeat_at')::timestamptz IS NULL OR NOT isfinite((leader->>'heartbeat_at')::timestamptz)
 OR NOT (instant-(leader->>'heartbeat_at')::timestamptz BETWEEN interval '-30 seconds' AND interval '60 seconds') THEN
 RAISE EXCEPTION 'F06_RETIRED_PROCESS_CHANGED'; END IF;
 IF physical->>'source' IS DISTINCT FROM '8825af51817f379c4261658ca29ecc9d8d81932d'
 OR physical->>'instance_id' IS DISTINCT FROM '1-3846b8bb'
 OR physical->>'process_id' IS DISTINCT FROM '1231816'
 OR physical->>'application_pid' IS DISTINCT FROM '1'
 OR physical->>'container_id' IS DISTINCT FROM 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66'
 OR physical->>'image' IS DISTINCT FROM 'sha256:7973b0cd170e7ea00a948f6376b17a201485c3e03ae47c06f0248b17a4bfae1c'
 OR physical->>'manager_id' IS DISTINCT FROM cohort->>'manager_id'
 OR physical->>'generation' IS DISTINCT FROM g::text
 OR physical->'all_processes_accounted' IS DISTINCT FROM 'true'::jsonb
 OR physical->'all_owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR physical->'original_stop_completed' IS DISTINCT FROM 'true'::jsonb
 OR physical->'owner_index_complete' IS DISTINCT FROM 'true'::jsonb
 OR physical->'scheduler_pending' IS DISTINCT FROM '0'::jsonb
 OR physical->'lifecycle_pending' IS DISTINCT FROM '0'::jsonb
 OR jsonb_typeof(physical->'engines') IS DISTINCT FROM 'array'
 OR physical->>'engine_id' IS DISTINCT FROM cohort->'engines'->>(physical->>'table_id')
 OR COALESCE(physical->>'evidence_sha256','') !~ '^[0-9a-f]{64}$' THEN
 RAISE EXCEPTION 'F06_RETIRED_PHYSICAL_PROOF_REQUIRED'; END IF;
 SELECT jsonb_object_agg(e->>'table_id',e->'engine_id') INTO pairs FROM jsonb_array_elements(physical->'engines') e;
 IF pairs IS DISTINCT FROM cohort->'engines'
 OR jsonb_array_length(physical->'engines')<>(SELECT count(*) FROM jsonb_object_keys(cohort->'engines')) THEN
 RAISE EXCEPTION 'F06_RETIRED_WHOLE_OWNER_REQUIRED'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(physical->'engines') LOOP
 IF item->>'generation' IS DISTINCT FROM g::text OR item->'terminal' IS DISTINCT FROM 'true'::jsonb
 OR item->'running' IS DISTINCT FROM 'false'::jsonb OR item->>'last_event' IS DISTINCT FROM 'stop_completed'
 OR item->'owned_work_joined' IS DISTINCT FROM 'true'::jsonb
 OR item->'diagnostic_write_failures' IS DISTINCT FROM '0'::jsonb
 OR item->'dropped_records' IS DISTINCT FROM '0'::jsonb
 OR item->'dealing_loop' IS DISTINCT FROM 'false'::jsonb OR item->'settlements' IS DISTINCT FROM '0'::jsonb
 OR item->'post_hand_tasks' IS DISTINCT FROM 'false'::jsonb OR item->'tournament_moves' IS DISTINCT FROM '0'::jsonb
 OR item->>'read_continuation_proof' IS DISTINCT FROM '8825_stop_completed_joins_fixed_point'
 THEN RAISE EXCEPTION 'F06_RETIRED_ORIGINAL_NOT_DRAINED'; END IF;
 END LOOP;
END $$;
