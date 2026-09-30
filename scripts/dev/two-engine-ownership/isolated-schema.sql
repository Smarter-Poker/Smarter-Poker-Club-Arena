-- The isolated ownership database for probe-two-engine-ownership-pg17.py.
--
-- The three ownership tables are declared with the exact live shape (the
-- runner compares columns, constraints and indexes with
-- live-doors.manifest.json). Every door the engines call is loaded from
-- live-doors.sql, byte-for-byte what production runs (the runner compares
-- md5(pg_get_functiondef) with the manifest). Only what the doors READ but do
-- not own is stood in for here, and each stand-in says what it replaces.
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA smarter_private;

-- Stand-ins for the fleet the leases name. Production keeps the asset on the
-- club; here it sits on the row so the report can say chip or Diamond. The
-- doors read only tables.id and tables.tournament_id.
CREATE TABLE public.tournaments (id uuid PRIMARY KEY, asset text NOT NULL);
CREATE TABLE public.tables (
  id uuid PRIMARY KEY,
  tournament_id uuid REFERENCES public.tournaments(id),
  asset text NOT NULL
);

-- The live ownership tables.
CREATE TABLE public.engine_leader (
  id boolean NOT NULL DEFAULT true,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_leader_pkey PRIMARY KEY (id),
  CONSTRAINT engine_leader_id_check CHECK (id)
);
CREATE TABLE public.engine_table_leases (
  table_id uuid NOT NULL,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1,
  CONSTRAINT engine_table_leases_pkey PRIMARY KEY (table_id),
  CONSTRAINT engine_table_leases_protocol_version_check CHECK ((protocol_version = ANY (ARRAY[1, 2])))
);
CREATE INDEX engine_table_leases_instance_idx ON public.engine_table_leases USING btree (instance_id);
CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid NOT NULL,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1,
  CONSTRAINT engine_tournament_leases_pkey PRIMARY KEY (tournament_id),
  CONSTRAINT engine_tournament_leases_protocol_version_check CHECK ((protocol_version = ANY (ARRAY[1, 2]))),
  CONSTRAINT engine_tournament_leases_tournament_id_fkey FOREIGN KEY (tournament_id)
    REFERENCES public.tournaments(id) ON DELETE CASCADE
);
CREATE INDEX idx_engine_tournament_leases_heartbeat ON public.engine_tournament_leases USING btree (heartbeat_at);

-- The three abort registers the live f06_generation_aborted reads. Empty:
-- no event in this fleet was ever aborted.
CREATE TABLE smarter_private.f06_unsettled_hand_aborts (
  tournament_id uuid, generation uuid, retired_lease_generation uuid);
CREATE TABLE smarter_private.f06_generation_aborts (tournament_id uuid, generation uuid);
CREATE TABLE smarter_private.f06_mixed_abort_generations (tournament_id uuid, generation uuid);

-- Stand-in for the unchanged settlement core the exact door hands over to.
-- It records the hand under the lock the door took, and refuses a hand
-- number that was already committed for the table, so a second dealer
-- reusing a hand number is visible rather than silently merged.
CREATE TABLE public.isolated_hand_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  ref text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (table_id, hand_number)
);
CREATE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric,
  p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF (p_hand_row ->> 'hold_seconds') IS NOT NULL THEN
    PERFORM pg_sleep((p_hand_row ->> 'hold_seconds')::numeric);
  END IF;
  INSERT INTO public.isolated_hand_commits (table_id, hand_number, ref)
  VALUES (p_table_id, p_hand_number, p_ref)
  ON CONFLICT (table_id, hand_number) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'hand_number_already_committed');
  END IF;
  RETURN jsonb_build_object('success', true, 'atomic_hand_commit', true);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb) FROM PUBLIC;

-- Every lease row change, as the database saw it, for the analysis.
CREATE TABLE public.isolated_lease_history (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  scope text NOT NULL,
  subject text NOT NULL,
  op text NOT NULL,
  instance_id text,
  lease_generation uuid,
  heartbeat_at timestamptz,
  acquired_at timestamptz
);
CREATE FUNCTION public.isolated_record_lease() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  INSERT INTO public.isolated_lease_history (scope, subject, op, instance_id, lease_generation, heartbeat_at, acquired_at)
  VALUES (TG_TABLE_NAME,
          COALESCE(r ->> 'table_id', r ->> 'tournament_id', 'leader'),
          TG_OP, r ->> 'instance_id', (r ->> 'lease_generation')::uuid,
          (r ->> 'heartbeat_at')::timestamptz, (r ->> 'acquired_at')::timestamptz);
  RETURN NULL;
END $$;
CREATE TRIGGER zz_isolated_record AFTER INSERT OR UPDATE OR DELETE ON public.engine_leader
  FOR EACH ROW EXECUTE FUNCTION public.isolated_record_lease();
CREATE TRIGGER zz_isolated_record AFTER INSERT OR UPDATE OR DELETE ON public.engine_table_leases
  FOR EACH ROW EXECUTE FUNCTION public.isolated_record_lease();
CREATE TRIGGER zz_isolated_record AFTER INSERT OR UPDATE OR DELETE ON public.engine_tournament_leases
  FOR EACH ROW EXECUTE FUNCTION public.isolated_record_lease();
