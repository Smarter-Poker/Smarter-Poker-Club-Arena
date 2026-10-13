BEGIN;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_unsettled_hand_aborts"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_unsettled_hand_aborts"("receipt_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"table_id" uuid NOT NULL,"generation" uuid NOT NULL,"permit_id" uuid NOT NULL,"hand_number" bigint NOT NULL,"break_id" uuid NOT NULL,"expected" jsonb NOT NULL,"outcome" text DEFAULT 'aborted_unsettled'::text NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,"retired_lease_generation" uuid);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_abort_successor_distinct" CHECK (((retired_lease_generation IS NULL) OR (retired_lease_generation <> generation)));
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_break_id_key" UNIQUE (break_id);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_outcome_check" CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_permit_id_key" UNIQUE (permit_id);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_pkey" PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_table_id_hand_number_key" UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ADD CONSTRAINT "f06_unsettled_hand_aborts_tournament_id_generation_key" UNIQUE (tournament_id, generation);
CREATE UNIQUE INDEX f06_abort_retired_lease_generation ON smarter_private.f06_unsettled_hand_aborts USING btree (tournament_id, retired_lease_generation) WHERE (retired_lease_generation IS NOT NULL);
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_unsettled_hand_aborts" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_unsettled_hand_aborts" TO "postgres";
ALTER TABLE smarter_private."f06_unsettled_hand_aborts" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_generation_aborts"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_generation_aborts"("receipt_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"generation" uuid NOT NULL,"expected" jsonb NOT NULL,"outcome" text DEFAULT 'aborted_unsettled'::text NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL);
ALTER TABLE smarter_private."f06_generation_aborts" ADD CONSTRAINT "f06_generation_aborts_outcome_check" CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private."f06_generation_aborts" ADD CONSTRAINT "f06_generation_aborts_pkey" PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private."f06_generation_aborts" ADD CONSTRAINT "f06_generation_aborts_receipt_id_tournament_id_generation_key" UNIQUE (receipt_id, tournament_id, generation);
ALTER TABLE smarter_private."f06_generation_aborts" ADD CONSTRAINT "f06_generation_aborts_tournament_id_generation_key" UNIQUE (tournament_id, generation);
ALTER TABLE smarter_private."f06_generation_aborts" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_generation_aborts" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_generation_aborts" TO "postgres";
ALTER TABLE smarter_private."f06_generation_aborts" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_generation_abort_hands"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_generation_abort_hands"("permit_id" uuid NOT NULL,"receipt_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"generation" uuid NOT NULL,"table_id" uuid NOT NULL,"hand_number" bigint NOT NULL,"snapshot_id" uuid NOT NULL,"break_id" uuid,"expected" jsonb NOT NULL);
ALTER TABLE smarter_private."f06_generation_abort_hands" ADD CONSTRAINT "f06_generation_abort_hands_break_id_key" UNIQUE (break_id);
ALTER TABLE smarter_private."f06_generation_abort_hands" ADD CONSTRAINT "f06_generation_abort_hands_pkey" PRIMARY KEY (permit_id);
ALTER TABLE smarter_private."f06_generation_abort_hands" ADD CONSTRAINT "f06_generation_abort_hands_table_id_hand_number_key" UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private."f06_generation_abort_hands" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_generation_abort_hands" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_generation_abort_hands" TO "postgres";
ALTER TABLE smarter_private."f06_generation_abort_hands" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_mixed_aborts"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_mixed_aborts"("receipt_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"expected" jsonb NOT NULL,"outcome" text DEFAULT 'aborted_unsettled'::text NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL);
ALTER TABLE smarter_private."f06_mixed_aborts" ADD CONSTRAINT "f06_mixed_aborts_outcome_check" CHECK ((outcome = 'aborted_unsettled'::text));
ALTER TABLE smarter_private."f06_mixed_aborts" ADD CONSTRAINT "f06_mixed_aborts_pkey" PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private."f06_mixed_aborts" ADD CONSTRAINT "f06_mixed_aborts_receipt_id_tournament_id_key" UNIQUE (receipt_id, tournament_id);
ALTER TABLE smarter_private."f06_mixed_aborts" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_mixed_aborts" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_mixed_aborts" TO "postgres";
ALTER TABLE smarter_private."f06_mixed_aborts" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_mixed_abort_generations"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_mixed_abort_generations"("tournament_id" uuid NOT NULL,"generation" uuid NOT NULL,"receipt_id" uuid NOT NULL);
ALTER TABLE smarter_private."f06_mixed_abort_generations" ADD CONSTRAINT "f06_mixed_abort_generations_pkey" PRIMARY KEY (tournament_id, generation);
ALTER TABLE smarter_private."f06_mixed_abort_generations" ADD CONSTRAINT "f06_mixed_abort_generations_receipt_id_tournament_id_genera_key" UNIQUE (receipt_id, tournament_id, generation);
ALTER TABLE smarter_private."f06_mixed_abort_generations" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_mixed_abort_generations" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_mixed_abort_generations" TO "postgres";
ALTER TABLE smarter_private."f06_mixed_abort_generations" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_mixed_abort_hands"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_mixed_abort_hands"("permit_id" uuid NOT NULL,"receipt_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"generation" uuid NOT NULL,"table_id" uuid NOT NULL,"hand_number" bigint NOT NULL,"snapshot_id" uuid,"break_id" uuid,"prior_hand_id" uuid,"prior_abort_receipt_id" uuid,"expected" jsonb NOT NULL);
ALTER TABLE smarter_private."f06_mixed_abort_hands" ADD CONSTRAINT "f06_mixed_abort_hands_break_id_key" UNIQUE (break_id);
ALTER TABLE smarter_private."f06_mixed_abort_hands" ADD CONSTRAINT "f06_mixed_abort_hands_check" CHECK ((((((snapshot_id IS NOT NULL))::integer + ((prior_hand_id IS NOT NULL))::integer) + ((prior_abort_receipt_id IS NOT NULL))::integer) = 1));
ALTER TABLE smarter_private."f06_mixed_abort_hands" ADD CONSTRAINT "f06_mixed_abort_hands_pkey" PRIMARY KEY (permit_id);
ALTER TABLE smarter_private."f06_mixed_abort_hands" ADD CONSTRAINT "f06_mixed_abort_hands_table_id_hand_number_key" UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private."f06_mixed_abort_hands" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_mixed_abort_hands" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_mixed_abort_hands" TO "postgres";
ALTER TABLE smarter_private."f06_mixed_abort_hands" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_prepared_hand_cancellations"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_prepared_hand_cancellations"("permit_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"generation" uuid NOT NULL,"table_id" uuid NOT NULL,"lifecycle" bigint NOT NULL,"hand_number" bigint NOT NULL,"custody_id" uuid NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL);
ALTER TABLE smarter_private."f06_prepared_hand_cancellations" ADD CONSTRAINT "f06_prepared_hand_cancellations_pkey" PRIMARY KEY (permit_id);
ALTER TABLE smarter_private."f06_prepared_hand_cancellations" ADD CONSTRAINT "f06_prepared_hand_cancellations_table_id_hand_number_key" UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private."f06_prepared_hand_cancellations" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_prepared_hand_cancellations" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_prepared_hand_cancellations" TO "postgres";
ALTER TABLE smarter_private."f06_prepared_hand_cancellations" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('public."hand_state_snapshots"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE public."hand_state_snapshots"("id" uuid DEFAULT gen_random_uuid() NOT NULL,"table_id" uuid NOT NULL,"hand_number" integer NOT NULL,"state_json" jsonb NOT NULL,"config_json" jsonb NOT NULL,"dealer_seat" integer NOT NULL,"players_json" jsonb NOT NULL,"stage" text DEFAULT 'preflop'::text NOT NULL,"is_complete" boolean DEFAULT false NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"pending_deadlines" jsonb DEFAULT '[]'::jsonb NOT NULL,"disconnect_states" jsonb DEFAULT '{}'::jsonb NOT NULL);
ALTER TABLE public."hand_state_snapshots" ADD CONSTRAINT "hand_state_snapshots_pkey" PRIMARY KEY (id);
CREATE UNIQUE INDEX idx_hand_snapshots_one_active_per_table ON public.hand_state_snapshots USING btree (table_id) WHERE (is_complete = false);
CREATE INDEX idx_hand_state_snapshots_created_at ON public.hand_state_snapshots USING btree (created_at DESC);
ALTER TABLE public."hand_state_snapshots" OWNER TO "postgres";
REVOKE ALL ON TABLE public."hand_state_snapshots" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT INSERT ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT MAINTAIN ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT REFERENCES ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT SELECT ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT TRIGGER ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT TRUNCATE ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT UPDATE ON TABLE public."hand_state_snapshots" TO "postgres";
GRANT DELETE ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT INSERT ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT MAINTAIN ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT REFERENCES ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT SELECT ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT TRIGGER ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT TRUNCATE ON TABLE public."hand_state_snapshots" TO "service_role";
GRANT UPDATE ON TABLE public."hand_state_snapshots" TO "service_role";
CREATE POLICY "hand_state_snapshots_service_only" ON public."hand_state_snapshots" AS PERMISSIVE FOR ALL TO "service_role" USING (true) WITH CHECK (true);
ALTER TABLE public."hand_state_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."hand_state_snapshots" FORCE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('public."hand_projection_outbox"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE public."hand_projection_outbox"("hand_id" uuid NOT NULL,"table_id" uuid NOT NULL,"hand_number" bigint NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL);
ALTER TABLE public."hand_projection_outbox" ADD CONSTRAINT "hand_projection_outbox_hand_number_check" CHECK ((hand_number >= 1000000));
ALTER TABLE public."hand_projection_outbox" ADD CONSTRAINT "hand_projection_outbox_hand_number_key" UNIQUE (hand_number);
ALTER TABLE public."hand_projection_outbox" ADD CONSTRAINT "hand_projection_outbox_pkey" PRIMARY KEY (hand_id);
CREATE INDEX idx_hand_projection_outbox_table_hand ON public.hand_projection_outbox USING btree (table_id, hand_number);
ALTER TABLE public."hand_projection_outbox" OWNER TO "postgres";
REVOKE ALL ON TABLE public."hand_projection_outbox" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT INSERT ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT MAINTAIN ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT REFERENCES ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT SELECT ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT TRIGGER ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT TRUNCATE ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT UPDATE ON TABLE public."hand_projection_outbox" TO "postgres";
GRANT SELECT ON TABLE public."hand_projection_outbox" TO "service_role";
ALTER TABLE public."hand_projection_outbox" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('public."table_pending_addons"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE public."table_pending_addons"("id" uuid DEFAULT gen_random_uuid() NOT NULL,"table_id" uuid NOT NULL,"user_id" uuid NOT NULL,"amount" numeric NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"resolved_at" timestamp with time zone,"applied_to_stack" numeric,"refunded" numeric,"kind" text DEFAULT 'addon'::text NOT NULL);
ALTER TABLE public."table_pending_addons" ADD CONSTRAINT "table_pending_addons_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public."table_pending_addons" ADD CONSTRAINT "table_pending_addons_kind_check" CHECK ((kind = ANY (ARRAY['addon'::text, 'rebuy'::text])));
ALTER TABLE public."table_pending_addons" ADD CONSTRAINT "table_pending_addons_pkey" PRIMARY KEY (id);
CREATE INDEX idx_table_pending_addons_unresolved_all ON public.table_pending_addons USING btree (created_at) WHERE (resolved_at IS NULL);
ALTER TABLE public."table_pending_addons" OWNER TO "postgres";
REVOKE ALL ON TABLE public."table_pending_addons" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT REFERENCES ON TABLE public."table_pending_addons" TO "anon";
GRANT SELECT ON TABLE public."table_pending_addons" TO "anon";
GRANT TRIGGER ON TABLE public."table_pending_addons" TO "anon";
GRANT REFERENCES ON TABLE public."table_pending_addons" TO "authenticated";
GRANT SELECT ON TABLE public."table_pending_addons" TO "authenticated";
GRANT TRIGGER ON TABLE public."table_pending_addons" TO "authenticated";
GRANT DELETE ON TABLE public."table_pending_addons" TO "postgres";
GRANT INSERT ON TABLE public."table_pending_addons" TO "postgres";
GRANT MAINTAIN ON TABLE public."table_pending_addons" TO "postgres";
GRANT REFERENCES ON TABLE public."table_pending_addons" TO "postgres";
GRANT SELECT ON TABLE public."table_pending_addons" TO "postgres";
GRANT TRIGGER ON TABLE public."table_pending_addons" TO "postgres";
GRANT TRUNCATE ON TABLE public."table_pending_addons" TO "postgres";
GRANT UPDATE ON TABLE public."table_pending_addons" TO "postgres";
GRANT DELETE ON TABLE public."table_pending_addons" TO "service_role";
GRANT INSERT ON TABLE public."table_pending_addons" TO "service_role";
GRANT MAINTAIN ON TABLE public."table_pending_addons" TO "service_role";
GRANT REFERENCES ON TABLE public."table_pending_addons" TO "service_role";
GRANT SELECT ON TABLE public."table_pending_addons" TO "service_role";
GRANT TRIGGER ON TABLE public."table_pending_addons" TO "service_role";
GRANT TRUNCATE ON TABLE public."table_pending_addons" TO "service_role";
GRANT UPDATE ON TABLE public."table_pending_addons" TO "service_role";
ALTER TABLE public."table_pending_addons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.table_pending_addons ADD CONSTRAINT table_pending_addons_amount_is_cents CHECK (((amount IS NULL) OR (((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount = round(amount, 2))))) NOT VALID;
ALTER TABLE public.table_pending_addons ADD CONSTRAINT table_pending_addons_applied_is_cents CHECK (((applied_to_stack IS NULL) OR (((applied_to_stack)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (applied_to_stack = round(applied_to_stack, 2))))) NOT VALID;
ALTER TABLE public.table_pending_addons ADD CONSTRAINT table_pending_addons_refunded_is_cents CHECK (((refunded IS NULL) OR (((refunded)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refunded = round(refunded, 2))))) NOT VALID;
DO $absent$ BEGIN IF to_regclass('public."engine_table_leases"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE public."engine_table_leases"("table_id" uuid NOT NULL,"instance_id" text NOT NULL,"engine_version" text,"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,"lease_generation" uuid DEFAULT gen_random_uuid() NOT NULL,"protocol_version" integer DEFAULT 1 NOT NULL);
ALTER TABLE public."engine_table_leases" ADD CONSTRAINT "engine_table_leases_pkey" PRIMARY KEY (table_id);
ALTER TABLE public."engine_table_leases" ADD CONSTRAINT "engine_table_leases_protocol_version_check" CHECK ((protocol_version = ANY (ARRAY[1, 2])));
CREATE INDEX engine_table_leases_instance_idx ON public.engine_table_leases USING btree (instance_id);
ALTER TABLE public."engine_table_leases" OWNER TO "postgres";
REVOKE ALL ON TABLE public."engine_table_leases" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT REFERENCES ON TABLE public."engine_table_leases" TO "anon";
GRANT SELECT ON TABLE public."engine_table_leases" TO "anon";
GRANT TRIGGER ON TABLE public."engine_table_leases" TO "anon";
GRANT REFERENCES ON TABLE public."engine_table_leases" TO "authenticated";
GRANT SELECT ON TABLE public."engine_table_leases" TO "authenticated";
GRANT TRIGGER ON TABLE public."engine_table_leases" TO "authenticated";
GRANT DELETE ON TABLE public."engine_table_leases" TO "postgres";
GRANT INSERT ON TABLE public."engine_table_leases" TO "postgres";
GRANT MAINTAIN ON TABLE public."engine_table_leases" TO "postgres";
GRANT REFERENCES ON TABLE public."engine_table_leases" TO "postgres";
GRANT SELECT ON TABLE public."engine_table_leases" TO "postgres";
GRANT TRIGGER ON TABLE public."engine_table_leases" TO "postgres";
GRANT TRUNCATE ON TABLE public."engine_table_leases" TO "postgres";
GRANT UPDATE ON TABLE public."engine_table_leases" TO "postgres";
GRANT MAINTAIN ON TABLE public."engine_table_leases" TO "service_role";
GRANT REFERENCES ON TABLE public."engine_table_leases" TO "service_role";
GRANT SELECT ON TABLE public."engine_table_leases" TO "service_role";
GRANT TRIGGER ON TABLE public."engine_table_leases" TO "service_role";
ALTER TABLE public."engine_table_leases" ENABLE ROW LEVEL SECURITY;
DO $absent$ BEGIN IF to_regclass('smarter_private."f06_no_start_continuations"') IS NOT NULL THEN RAISE EXCEPTION 'captured accounting table must be absent'; END IF; END $absent$;
CREATE TABLE smarter_private."f06_no_start_continuations"("receipt_id" uuid DEFAULT gen_random_uuid() NOT NULL,"break_id" uuid NOT NULL,"permit_id" uuid NOT NULL,"tournament_id" uuid NOT NULL,"table_id" uuid NOT NULL,"lifecycle" bigint NOT NULL,"hand_number" bigint NOT NULL,"original_generation" uuid NOT NULL,"current_generation" uuid NOT NULL,"park" jsonb NOT NULL,"permit" jsonb NOT NULL,"roster" jsonb NOT NULL,"prior_committed" jsonb NOT NULL,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL);
ALTER TABLE smarter_private."f06_no_start_continuations" ADD CONSTRAINT "f06_no_start_continuations_break_id_key" UNIQUE (break_id);
ALTER TABLE smarter_private."f06_no_start_continuations" ADD CONSTRAINT "f06_no_start_continuations_permit_id_key" UNIQUE (permit_id);
ALTER TABLE smarter_private."f06_no_start_continuations" ADD CONSTRAINT "f06_no_start_continuations_pkey" PRIMARY KEY (receipt_id);
ALTER TABLE smarter_private."f06_no_start_continuations" ADD CONSTRAINT "f06_no_start_continuations_table_id_hand_number_key" UNIQUE (table_id, hand_number);
ALTER TABLE smarter_private."f06_no_start_continuations" OWNER TO "postgres";
REVOKE ALL ON TABLE smarter_private."f06_no_start_continuations" FROM PUBLIC,anon,authenticated,service_role,postgres;
GRANT DELETE ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT INSERT ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT MAINTAIN ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT REFERENCES ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT SELECT ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT TRIGGER ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT TRUNCATE ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
GRANT UPDATE ON TABLE smarter_private."f06_no_start_continuations" TO "postgres";
ALTER TABLE smarter_private."f06_no_start_continuations" ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.cash_participant_funding_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 operation_kind text NOT NULL CHECK(operation_kind IN ('buyin','rebuy','addon','horse_funding')),
 operation_key text,
 user_id uuid NOT NULL, table_id uuid NOT NULL, seat_id uuid NOT NULL,
 occupancy_id uuid NOT NULL, seat_joined_at timestamptz NOT NULL,
 source_ledger_id uuid NOT NULL UNIQUE,
 wallet_transaction_id uuid,
 account_type text NOT NULL CHECK(account_type IN ('player_wallet','club_treasury')),
 account_entity_id uuid NOT NULL, funding_club_id uuid NOT NULL,
 funding_union_id uuid, asset text NOT NULL CHECK(asset='chips'),
 unit_scale integer NOT NULL DEFAULT 2 CHECK(unit_scale=2),
 amount numeric NOT NULL CHECK(amount>0 AND amount=round(amount,2) AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 balance_before numeric NOT NULL, balance_after numeric NOT NULL,
 pending_addon_id uuid UNIQUE,
 CHECK(balance_before-balance_after=amount),
 UNIQUE(operation_kind,operation_key)
);
CREATE INDEX cash_participant_funding_occupancy ON public.cash_participant_funding_receipts(occupancy_id,recorded_at,id);
CREATE TABLE public.cash_funding_application_receipts (
 pending_addon_id uuid PRIMARY KEY, funding_receipt_id uuid NOT NULL UNIQUE,
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 original_occupancy_id uuid NOT NULL, applied_occupancy_id uuid,
 applied numeric NOT NULL CHECK(applied>=0), refunded numeric NOT NULL CHECK(refunded>=0)
);
CREATE TABLE public.cash_hand_participant_manifests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid NOT NULL,
 hand_number bigint NOT NULL, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_instance_id text NOT NULL, lease_generation uuid NOT NULL,
 request jsonb NOT NULL, game_scope jsonb NOT NULL, participants jsonb NOT NULL,
 issues jsonb NOT NULL, funding_provenance_complete boolean NOT NULL,
 UNIQUE(table_id,hand_number)
);
CREATE TABLE public.cash_hand_provenance_receipts (
 table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payload_hash text NOT NULL, accepted_request jsonb NOT NULL, manifest_id uuid,
 atomic_receipt jsonb NOT NULL, stack_claim jsonb NOT NULL, stack_settlement jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version=1),
 status text NOT NULL CHECK(status IN ('captured','uncertified')),
 game_scope jsonb, participants jsonb NOT NULL,
 signed_external_net numeric, rake numeric, bbj numeric,
 all_players_included boolean NOT NULL, funding_provenance_complete boolean NOT NULL,
 issues jsonb NOT NULL,
 PRIMARY KEY(table_id,hand_number), UNIQUE(hand_id)
);
CREATE INDEX cash_hand_provenance_time ON public.cash_hand_provenance_receipts(accepted_at,table_id,hand_number);

CREATE FUNCTION public.fn_cash_provenance_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Original cash provenance is immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER cash_funding_immutable BEFORE UPDATE OR DELETE ON public.cash_participant_funding_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_manifest_immutable BEFORE UPDATE OR DELETE ON public.cash_hand_participant_manifests
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_provenance_immutable BEFORE UPDATE OR DELETE ON public.cash_hand_provenance_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_application_immutable BEFORE UPDATE OR DELETE ON public.cash_funding_application_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_participant_funding_receipts_no_truncate BEFORE TRUNCATE ON public.cash_participant_funding_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_funding_application_receipts_no_truncate BEFORE TRUNCATE ON public.cash_funding_application_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_participant_manifests_no_truncate BEFORE TRUNCATE ON public.cash_hand_participant_manifests
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
CREATE TRIGGER cash_hand_provenance_receipts_no_truncate BEFORE TRUNCATE ON public.cash_hand_provenance_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cash_provenance_immutable();
ALTER TABLE public.cash_funding_application_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_funding_application_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.cash_funding_application_receipts TO service_role;
ALTER TABLE public.cash_participant_funding_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_hand_participant_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_hand_provenance_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_participant_funding_receipts,public.cash_hand_participant_manifests,public.cash_hand_provenance_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.cash_participant_funding_receipts,public.cash_hand_participant_manifests,public.cash_hand_provenance_receipts TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_provenance_immutable() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_cash_accept_hand_provenance(p_table uuid,p_number bigint,p_hand uuid,
 p_stacks jsonb,p_rake numeric,p_bbj numeric,p_inflow numeric,p_hash text,p_request jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.cash_hand_participant_manifests%ROWTYPE; x jsonb; y jsonb; v_id uuid;
 v_atomic jsonb; v_claim jsonb; v_settlement jsonb; v_stack_hand uuid;
 v_n integer; v_count integer; v_delta numeric:=0; v_people jsonb:='[]'; v_issues jsonb:='[]'; v_tournament uuid;
BEGIN
 IF p_request IS NULL OR p_request->'stacks' IS DISTINCT FROM p_stacks
  OR p_request->>'table_id' IS DISTINCT FROM p_table::text
  OR p_request->>'hand_number' IS DISTINCT FROM p_number::text
  OR encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM p_hash THEN
  RAISE EXCEPTION 'Original cash accepted request hash mismatch' USING ERRCODE='23514'; END IF;
 SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table;
 IF v_tournament IS NOT NULL THEN RETURN; END IF;
 -- Keep original accounting proof independently of the seven-day game-history retention.
 SELECT to_jsonb(a) INTO STRICT v_atomic FROM public.hand_atomic_commits a
  WHERE a.table_id=p_table AND a.hand_number=p_number AND a.hand_id=p_hand AND a.payload_hash=p_hash;
 v_stack_hand:=(v_atomic->'stack_result'->>'hand_id')::uuid;
 SELECT to_jsonb(k) INTO STRICT v_claim FROM public.settlement_idempotency_keys k
  WHERE k.table_id=p_table AND k.hand_id=v_stack_hand AND k.status='succeeded'
   AND k.completed_at IS NOT NULL AND k.result=v_atomic->'stack_result';
 SELECT to_jsonb(c) INTO STRICT v_settlement FROM public.ca_settlements c
  WHERE c.table_id=p_table AND c.hand_id=v_stack_hand AND c.settlement_type='hand_stacks' AND c.state='final';
 SELECT count(DISTINCT value->>'funding_manifest_id'),count(*) FILTER(WHERE value->>'funding_manifest_id' IS NOT NULL)
 INTO v_n,v_count FROM jsonb_array_elements(p_stacks);
 IF v_count=0 THEN
  INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,status,participants,
   signed_external_net,rake,bbj,all_players_included,funding_provenance_complete,issues)
  VALUES(p_table,p_number,p_hand,p_hash,p_request,v_atomic,v_claim,v_settlement,'uncertified',p_stacks,p_inflow,p_rake,p_bbj,false,false,
   '["original_dealt_manifest_missing"]');
  RETURN;
 END IF;
 IF v_n<>1 OR v_count<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Incomplete or conflicting cash manifest references' USING ERRCODE='23514'; END IF;
 v_id:=(p_stacks->0->>'funding_manifest_id')::uuid;
 SELECT * INTO STRICT m FROM public.cash_hand_participant_manifests WHERE id=v_id AND table_id=p_table AND hand_number=p_number;
 IF jsonb_array_length(m.participants)<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Cash manifest participant set mismatch' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT value->>'user_id') FROM jsonb_array_elements(p_stacks))<>jsonb_array_length(p_stacks) THEN
  RAISE EXCEPTION 'Duplicate cash manifest participant' USING ERRCODE='23514'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(m.participants) LOOP
  SELECT value INTO y FROM jsonb_array_elements(p_stacks) WHERE value->>'user_id'=x->>'user_id';
  IF y IS NULL OR y->>'seat_id' IS DISTINCT FROM x->>'seat_id'
   OR (y->>'seat_joined_at')::timestamptz IS DISTINCT FROM (x->>'seat_joined_at')::timestamptz
   OR y->>'occupancy_id' IS DISTINCT FROM x->>'occupancy_id'
   OR (y->>'stack_before')::numeric IS DISTINCT FROM (x->>'stack_before')::numeric
   OR jsonb_typeof(y->'stack') IS DISTINCT FROM 'number'
   OR (y->>'stack')::numeric<0 OR (y->>'stack')::numeric<>round((y->>'stack')::numeric,2)
   OR y->>'stack' IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Cash manifest original participant mismatch' USING ERRCODE='23514'; END IF;
  v_delta:=v_delta+(y->>'stack')::numeric-(x->>'stack_before')::numeric;
  v_people:=v_people||jsonb_build_array(x||jsonb_build_object('stack_after',y->'stack',
   'poker_delta',(y->>'stack')::numeric-(x->>'stack_before')::numeric));
 END LOOP;
 IF coalesce(p_rake,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_bbj,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_inflow,0)::text IN ('NaN','Infinity','-Infinity')
  OR coalesce(p_rake,0)<>round(coalesce(p_rake,0),2)
  OR coalesce(p_bbj,0)<>round(coalesce(p_bbj,0),2)
  OR coalesce(p_inflow,0)<>round(coalesce(p_inflow,0),2)
  OR coalesce(p_rake,0)<0 OR coalesce(p_bbj,0)<0
  OR v_delta+coalesce(p_rake,0)+coalesce(p_bbj,0) IS DISTINCT FROM coalesce(p_inflow,0) THEN
  RAISE EXCEPTION 'Cash manifest signed conservation mismatch' USING ERRCODE='23514'; END IF;
 v_issues:=m.issues;
 -- A signed net is conserved, but external-bank linkage and commercial terms
 -- must still be proven separately. Captured funding is not whole-period PNL.
 IF coalesce(p_inflow,0)<>0 THEN v_issues:=v_issues||'"external_bank_receipt_not_certified"'::jsonb; END IF;
 INSERT INTO public.cash_hand_provenance_receipts(table_id,hand_number,hand_id,payload_hash,accepted_request,atomic_receipt,stack_claim,stack_settlement,manifest_id,status,
  game_scope,participants,signed_external_net,rake,bbj,all_players_included,funding_provenance_complete,issues)
 VALUES(p_table,p_number,p_hand,p_hash,p_request,v_atomic,v_claim,v_settlement,v_id,CASE WHEN jsonb_array_length(v_issues)=0 THEN 'captured' ELSE 'uncertified' END,
  m.game_scope,v_people,coalesce(p_inflow,0),coalesce(p_rake,0),coalesce(p_bbj,0),true,m.funding_provenance_complete,v_issues);
END $$;
REVOKE ALL ON FUNCTION public.fn_cash_accept_hand_provenance(uuid,bigint,uuid,jsonb,numeric,numeric,numeric,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;CREATE OR REPLACE FUNCTION public.fn_ca_insert_hand_with_awards(p_row jsonb, p_units jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id   uuid;
  v_cols text;
BEGIN
  /* Only the columns the caller named. Anything absent keeps its DEFAULT,
     which is the entire point - see the header. */
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND c.table_name   = 'hand_history'
     AND p_row ? c.column_name;

  IF v_cols IS NULL THEN
    RAISE EXCEPTION
      'fn_ca_insert_hand_with_awards: p_row names no hand_history column - refusing to insert a row of pure defaults';
  END IF;

  EXECUTE format(
    'INSERT INTO public.hand_history (%1$s) '
    'SELECT %1$s FROM jsonb_populate_record(null::public.hand_history, $1) '
    'RETURNING id', v_cols)
    USING p_row
     INTO v_id;

  IF jsonb_array_length(COALESCE(p_units, '[]'::jsonb)) > 0 THEN
    INSERT INTO public.bomb_pot_award_units
      (hand_history_id, table_id, hand_number, pot_index, board, side, user_id, amount, hand_name)
    SELECT v_id,
           (u->>'table_id')::uuid,
           (u->>'hand_number')::bigint,
           (u->>'pot_index')::int,
           COALESCE((u->>'board')::int, 1),
           COALESCE(u->>'side', 'high'),
           (u->>'user_id')::uuid,
           (u->>'amount')::numeric,
           NULLIF(u->>'hand_name', '')
      FROM jsonb_array_elements(p_units) u
    ON CONFLICT (hand_history_id, pot_index, board, side, user_id) DO NOTHING;
  END IF;

  RETURN v_id;
END $function$;
ALTER FUNCTION public.fn_ca_insert_hand_with_awards(jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_insert_hand_with_awards(jsonb,jsonb) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_insert_hand_with_awards(jsonb,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='e7f05bb7d61360be7424c5f429066047' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.trg_finish_hand_post_commit_obligations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.fn_ca_process_hand_post_commit_obligations(OLD.hand_id);
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     AND v_result->>'reason' <> 'legacy_no_obligations' THEN
    RAISE EXCEPTION 'hand post-commit obligations remain pending for %: %',
      OLD.hand_id, v_result;
  END IF;
  RETURN OLD;
END;
$function$;
ALTER FUNCTION public.trg_finish_hand_post_commit_obligations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_finish_hand_post_commit_obligations() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.trg_finish_hand_post_commit_obligations() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_finish_hand_post_commit_obligations()'::regprocedure AND md5(pg_get_functiondef(oid))='66d5a81792f64fc5ec1ab33ced6a05ba' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
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
ALTER FUNCTION public.trg_notify_hand_projection_outbox() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_notify_hand_projection_outbox() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.trg_notify_hand_projection_outbox() TO postgres;
GRANT EXECUTE ON FUNCTION public.trg_notify_hand_projection_outbox() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_notify_hand_projection_outbox()'::regprocedure AND md5(pg_get_functiondef(oid))='57069a33071dbb02460486310802be90' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_abort_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_ABORT_RECEIPT_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_abort_receipt_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_abort_receipt_immutable() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_abort_receipt_immutable() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_abort_receipt_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='811127b67caea34bd7d3e5bc6c41ed94' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_prepared_cancellation_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_PREPARED_CANCELLATION_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_prepared_cancellation_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_prepared_cancellation_immutable() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_prepared_cancellation_immutable() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prepared_cancellation_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='02bf681ff7ba388c19cbdebb9efe42ac' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_f06_cancel_prepared_hand(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_permit_id uuid, p_hand_number bigint, p_custody_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits; r smarter_private.f06_prepared_hand_cancellations;
BEGIN
 IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_table_id IS NULL
 OR p_lifecycle IS NULL OR p_permit_id IS NULL OR p_hand_number IS NULL
 OR p_hand_number<1 OR p_custody_id IS NULL THEN
 RAISE EXCEPTION 'F06_PREPARED_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 -- Unchanged protocol-2 admission and canonical lease/lane/physical-row order.
 -- A successor lease cannot certify the original process's local non-actuation.
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[p_table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.generation,h.table_id,h.lifecycle,h.hand_number,h.custody_id)
 IS DISTINCT FROM(p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id) THEN
 RAISE EXCEPTION 'F06_PREPARED_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT * INTO r FROM smarter_private.f06_prepared_hand_cancellations WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (r.tournament_id,r.generation,r.table_id,r.lifecycle,r.hand_number,r.custody_id)
 IS DISTINCT FROM(p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id)
 OR h.state<>'never_started' OR h.evidence_id IS DISTINCT FROM p_permit_id THEN
 RAISE EXCEPTION 'F06_PREPARED_RECEIPT_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 IF h.state<>'reserved' OR h.evidence_id IS NOT NULL THEN
 RAISE EXCEPTION 'F06_PREPARED_NOT_RESERVED' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id
 WHERE tb.id=p_table_id AND tb.tournament_id=p_tournament_id AND tb.f06_lifecycle=p_lifecycle
 AND upper(t.status)='RUNNING' AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 -- Durable witnesses only REFUSE a claimed no-start; their absence cannot grant it.
 -- The active snapshot uses its maintained partial index. Completed snapshot
 -- history is not scanned or inferred absent: positive original-process start
 -- exclusion (not a successor reconstruction) is the authority for this receipt.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND NOT is_complete AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RAISE EXCEPTION 'F06_PREPARED_START_EVIDENCE' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_prepared_hand_cancellations
 (permit_id,tournament_id,generation,table_id,lifecycle,hand_number,custody_id)
 VALUES(p_permit_id,p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_hand_number,p_custody_id);
 UPDATE smarter_private.f06_hand_permits SET state='never_started',evidence_id=p_permit_id
 WHERE permit_id=p_permit_id RETURNING * INTO h;
 END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$;
ALTER FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='2eaabb545cbc3251be0cef438b08f989' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_immutable_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_immutable_identity() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_immutable_identity() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure AND md5(pg_get_functiondef(oid))='7695bc107f6575c01836bb3a130d73f1' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE t uuid;
BEGIN
 -- Resolve the table even before BEGIN is visible; an absent permit cannot
 -- let an already-started writer cross cancellation's exclusive lane.
 SELECT tournament_id INTO t FROM public.tables WHERE id=NEW.table_id;
 IF t IS NOT NULL THEN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_CANCELLED_PREPARATION_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='cd947083b57a48ed45b7590dbec66be3' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute(p_table_id uuid, p_hand_number bigint, p_stacks jsonb DEFAULT '[]'::jsonb, p_rake numeric DEFAULT NULL::numeric, p_bbj numeric DEFAULT NULL::numeric, p_ref text DEFAULT NULL::text, p_inflow numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_request jsonb;
  v_canonical jsonb;
  v_hand uuid; v_claimed integer; v_prior record; v_ca_id uuid;
  e jsonb; v_uid uuid; v_new numeric; v_old numeric; v_before numeric; v_target numeric;
  v_delta_sum numeric := 0; v_expected numeric;
  v_n integer := 0; v_updated integer; v_err text; v_result jsonb;
  v_delta_mode boolean;
  -- Exact seat identity is the row id plus the join instant. A vacated row can
  -- be reused in place, so neither user_id, chair number, nor row id is enough.
  v_exact_seat_generation boolean;
  v_exact_seat_id uuid;
  v_exact_seat_joined_at timestamptz;
  v_exact_seat_left_at timestamptz;
  v_exact_seat_club uuid;
  v_exact_seat_found boolean;
  v_targets jsonb := '{}'::jsonb;      -- user_id -> stack to write
  v_rebased jsonb := '{}'::jsonb;      -- user_id -> db_before - engine_before (delta mode only)
  v_rebase_rows jsonb := '[]'::jsonb;  -- rows for ca_seat_stack_rebases
  v_rebase_count integer := 0;
  -- 2026-09-04 (verification sweep): a seat that LEFT during the hand
  v_departed jsonb := '[]'::jsonb;   -- [{user_id, delta, club_id}]
  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;
  -- chip-std Lane F (2026-09-02): tournament conservation (absolute mode)
  v_tournament_id uuid;
  -- The hand result is also the durable final-stack boundary for a tournament.
  v_tournament_status text;
  v_payload_stack_count integer := 0;
  v_target_user_count integer := 0;
  v_tournament_player_count integer := 0;
  v_tournament_player_user_ids uuid[] := ARRAY[]::uuid[];
  v_tournament_player_chips jsonb := '[]'::jsonb;
  v_zero_stack_seat_count integer := 0;
  v_zero_stack_seat_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_user_ids uuid[] := ARRAY[]::uuid[];
  v_zero_stack_seat_generations jsonb := '[]'::jsonb;
  v_zero_stack_vacated_at timestamptz;
  v_table_live_seat_count integer := 0;
  -- ONE SEAT WRITE PER HAND (2026-09-10): the accepted time-bank state the
  -- 12-argument door publishes for this exact table+hand, carried on the
  -- stack write so each seat row is written once per hand instead of twice.
  v_tb_env_text text;
  v_tb_env jsonb;
  v_tb_map jsonb;   -- lower(user_id) -> time-bank item, or NULL (stack-only write)
  v_tb jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
             WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) THEN
    -- DIAMOND PHASE 8: a Diamond TOURNAMENT hand moves play units on the
    -- roster and the seat, exactly as a chip tournament hand does below.
    RETURN public.fn_poker_diamond_settle_cash_hand(
      p_table_id,p_hand_number,p_stacks,p_rake,p_bbj,p_ref,p_inflow);
  END IF;
  -- This implementation primitive is owner-only by ACL below. Do not inspect
  -- current_user inside a SECURITY DEFINER core: CREATE OR REPLACE preserves
  -- the production owner, so a valid call through the sole service wrapper
  -- may execute here as that owner rather than as postgres/service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_ids');
  END IF;
  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_stacks) = 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_stacks');
  END IF;


  -- One participant, one delta. Duplicates previously passed the sum check
  -- twice but wrote a single target, allowing a non-conserving final balance.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
                 OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
                 OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
                 OR (x ? 'stack_before' AND jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number')) THEN
    RAISE EXCEPTION 'Invalid hand settlement participant' USING ERRCODE = '22023';
  END IF;

  -- Rolling expansion accepts either a wholly legacy roster or a wholly exact
  -- roster. One-sided and mixed generations can otherwise create a request
  -- whose hash says one thing while individual rows are selected another way.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_stacks) x
     WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
        OR CASE WHEN x ? 'seat_id'
                THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                THEN (x->>'seat_id') !~*
                  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                ELSE false END
        OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                THEN NOT pg_input_is_valid(
                  x->>'seat_joined_at', 'timestamp with time zone'
                )
                ELSE false END
  ) THEN
    RAISE EXCEPTION 'Invalid hand settlement seat generation'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
    RAISE EXCEPTION 'Mixed legacy and exact hand settlement seat generations'
      USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
    INTO v_exact_seat_generation
    FROM jsonb_array_elements(p_stacks) x;

  IF (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid) FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'Duplicate hand settlement participant' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'stack_before')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'stack_before')) THEN
    RAISE EXCEPTION 'Mixed absolute and delta hand settlement' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('user_id', (x->>'user_id')::uuid,
      'stack', (x->>'stack')::numeric)
      || CASE WHEN x ? 'stack_before' THEN jsonb_build_object('stack_before', (x->>'stack_before')::numeric)
              ELSE '{}'::jsonb END
      || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', (x->>'seat_id')::uuid,
              'seat_joined_at', x->>'seat_joined_at')
              ELSE '{}'::jsonb END
      ORDER BY (x->>'user_id')::uuid) INTO v_canonical
    FROM jsonb_array_elements(p_stacks) x;
  v_request := jsonb_build_object('stacks', v_canonical, 'rake', p_rake,
    'bbj', p_bbj, 'inflow', p_inflow);

  /* DELTA MODE (chip standard 2026-09-04): the engine says what each stack
     WAS when it dealt and what it IS now; the database applies the difference
     to whatever the row holds. Every element must carry stack_before, or the
     whole call is absolute - a mixed payload would silently erase on the
     seats that lacked it. */
  SELECT bool_and(x ? 'stack_before' AND jsonb_typeof(x -> 'stack_before') = 'number')
    INTO v_delta_mode
    FROM jsonb_array_elements(p_stacks) x;
  v_delta_mode := COALESCE(v_delta_mode, false);

  -- stable hand id from (table, hand number[, ref])
  v_hand := md5('ca-hand:' || p_table_id::text || ':' || p_hand_number::text
                || CASE WHEN p_ref IS NULL OR p_ref = '' THEN '' ELSE ':' || p_ref END)::uuid;

  INSERT INTO public.settlement_idempotency_keys
    (table_id, hand_id, status, attempt_count, first_attempt_at, last_attempt_at)
  VALUES (p_table_id, v_hand, 'in_flight', 1, now(), now())
  ON CONFLICT (table_id, hand_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT status, result, last_attempt_at INTO v_prior
      FROM public.settlement_idempotency_keys
     WHERE table_id = p_table_id AND hand_id = v_hand FOR UPDATE;
    IF v_prior.status = 'succeeded' THEN
      -- Old receipts predate payload storage. New receipts bind the full request.
      IF v_prior.result ? 'request' AND v_prior.result->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'Hand settlement identity belongs to a different payload' USING ERRCODE = '22023';
      END IF;
      RETURN COALESCE(v_prior.result, '{}'::jsonb) || jsonb_build_object('replay', true);
    ELSIF v_prior.status = 'in_flight' AND v_prior.last_attempt_at > now() - interval '5 minutes' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'in_flight');
    ELSE
      UPDATE public.settlement_idempotency_keys
         SET status = 'in_flight', attempt_count = attempt_count + 1, last_attempt_at = now(), error = NULL
       WHERE table_id = p_table_id AND hand_id = v_hand;
    END IF;
  END IF;

  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, table_id, hand_id, idempotency_key)
  VALUES ('hand_stacks', p_table_id::text || ':' || v_hand::text, 'open', p_table_id, v_hand,
          'hand:' || p_table_id::text || ':' || v_hand::text)
  ON CONFLICT (settlement_type, external_ref) DO UPDATE
    SET state = CASE WHEN public.ca_settlements.state = 'failed' THEN 'open'
                     ELSE public.ca_settlements.state END,
        error_detail = NULL
  RETURNING id INTO v_ca_id;

  BEGIN
    UPDATE public.ca_settlements SET state='locked_for_calculation' WHERE id = v_ca_id AND state='open';

    -- ONE LOCK ORDER WITH TERMINAL CLOSE (20260908): tournament,
    -- target tournament players by user_id/id, then target seats by id. The
    -- terminal authority takes the same order. A hand that waited behind a
    -- terminal commit sees COMPLETED and is refused before touching a seat.
    SELECT tb.tournament_id INTO v_tournament_id
      FROM public.tables tb WHERE tb.id = p_table_id;
    IF v_tournament_id IS NOT NULL THEN
      SELECT upper(COALESCE(t.status::text,'')) INTO v_tournament_status
        FROM public.tournaments t
       WHERE t.id = v_tournament_id
       FOR SHARE;
      IF NOT FOUND OR v_tournament_status <> 'RUNNING' THEN
        RAISE EXCEPTION
          'tournament % is not RUNNING at the durable hand boundary',
          v_tournament_id USING ERRCODE = '55000';
      END IF;
      SELECT count(*),count(DISTINCT (x.value->>'user_id')::uuid)
        INTO v_payload_stack_count,v_target_user_count
        FROM jsonb_array_elements(v_canonical) AS x(value);
      IF v_target_user_count <> v_payload_stack_count THEN
        RAISE EXCEPTION 'tournament hand % contains duplicate player stacks',
          p_hand_number USING ERRCODE = '22023';
      END IF;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value))
       ORDER BY tp.user_id,tp.id
       FOR UPDATE;
      SELECT count(*) INTO v_tournament_player_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing'
         AND tp.user_id IN (
           SELECT (x.value->>'user_id')::uuid
             FROM jsonb_array_elements(v_canonical) AS x(value));
      IF v_tournament_player_count <> v_target_user_count THEN
        RAISE EXCEPTION
          'tournament % hand % does not map every stack to one playing player',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
      -- A zero-seat vacate fires the seat-first table count trigger. Own the
      -- table before the seats, matching terminal close, so that trigger only
      -- reacquires a row this transaction already holds.
      PERFORM 1 FROM public.tables tb
       WHERE tb.id = p_table_id AND tb.tournament_id = v_tournament_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'tournament table % changed while hand % was locking',
          p_table_id,p_hand_number USING ERRCODE = '40001';
      END IF;
    END IF;

    -- Acquire every live target seat once in durable row-id order before the
    -- original loop. The loop's individual SELECT FOR UPDATE calls then
    -- reacquire locks that this transaction already owns. v_canonical is also
    -- the immutable replay identity, so lock, write and receipt use one roster.
    PERFORM 1
      FROM public.table_seats ts
      JOIN (
        SELECT DISTINCT (x.value->>'user_id')::uuid AS user_id
          FROM jsonb_array_elements(v_canonical) AS x(value)
      ) target ON target.user_id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
     ORDER BY ts.id
     FOR UPDATE OF ts;

    -- lock seats, compute deltas / targets
    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      v_new := round((e->>'stack')::numeric, 2);
      IF v_new IS NULL OR v_new < 0 THEN
        RAISE EXCEPTION 'invalid stack for %: %', e->>'user_id', e->>'stack';
      END IF;
      v_exact_seat_id := NULL;
      v_exact_seat_joined_at := NULL;
      v_exact_seat_left_at := NULL;
      v_exact_seat_club := NULL;
      IF v_exact_seat_generation THEN
        v_exact_seat_id := (e->>'seat_id')::uuid;
        v_exact_seat_joined_at := (e->>'seat_joined_at')::timestamptz;
        SELECT ts.stack, ts.left_at, ts.club_id
          INTO v_old, v_exact_seat_left_at, v_exact_seat_club
          FROM public.table_seats ts
         WHERE ts.id = v_exact_seat_id
           AND ts.joined_at = v_exact_seat_joined_at
           AND ts.table_id = p_table_id
           AND ts.user_id = v_uid
         FOR UPDATE;
      ELSE
        SELECT ts.stack INTO v_old FROM public.table_seats ts
         WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
         FOR UPDATE;
      END IF;
      v_exact_seat_found := FOUND;
      IF NOT v_exact_seat_found
         OR (v_exact_seat_generation AND v_exact_seat_left_at IS NOT NULL) THEN
        -- If the exact row id was reused in place, joined_at no longer matches.
        -- There is no historical row left to settle, so fail the hand whole.
        IF v_exact_seat_generation AND NOT v_exact_seat_found THEN
          RAISE EXCEPTION
            'exact seat generation missing or replaced for % - hand write rejected whole',
            v_uid;
        END IF;
        /* A SEAT THAT LEFT DURING THE HAND (2026-09-04, verification sweep).
           In delta mode the player's own delta is settled against the club
           wallet the seat cashed out to, keyed on hand + user, and the players
           still seated get their deltas as usual. Refusing the whole hand here
           left the winner unpaid in the database and the leaver refunded the
           bet they had put in the pot (the exit cashes out the seat's stack
           as it stood BEFORE the hand). Measured before this: 3 cash hands in
           the first 40 minutes of delta mode, each a mid-hand leave_pending
           cash-out raced by a stale settlement step. Absolute mode still
           refuses: with no stack_before there is no delta to settle. */
        /* CASH TABLES ONLY. Tournament chips are play chips: a seat that a
           table balance moved or an elimination removed mid-hand has no
           wallet to settle against, and settling it debited 230 real chips
           from a player on 2026-09-04 13:04 (reversed in 20260904131500).
           The tournament conservation gate in the engine and the tournament
           branch below own that case; here it is refused whole, as before. */
        IF v_delta_mode AND NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = p_table_id AND tb.tournament_id IS NOT NULL) THEN
          v_before := round((e->>'stack_before')::numeric, 2);
          IF v_before IS NULL OR v_before < 0 THEN
            RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
          END IF;
          IF v_exact_seat_generation THEN
            -- Use the club captured on the exact departed generation. Looking
            -- up the latest departed row can cross a later rejoin or club move.
            v_dep_club := v_exact_seat_club;
          ELSE
            SELECT ts.club_id INTO v_dep_club FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC LIMIT 1;
          END IF;
          IF v_dep_club IS NULL AND NOT v_exact_seat_generation THEN
            SELECT t.club_id INTO v_dep_club FROM public.tables t WHERE t.id = p_table_id;
          END IF;
          /* SETTLING NOTHING NEEDS NO WALLET (2026-09-08). A seat that left
             having moved no chips has nothing to settle against a wallet, and
             the departed loop below already skips a zero delta. Demanding the
             wallet first refused whole hands over seats that owed nothing -
             hand 7903456, which nets to zero between two seated players, was
             refused because a third seat with a delta of 0.00 had gone. */
          IF round(v_new - v_before, 2) = 0 THEN
            v_n := v_n + 1;
            CONTINUE;
          END IF;
          IF v_dep_club IS NULL OR NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.user_id = v_uid AND m.club_id = v_dep_club) THEN
            RAISE EXCEPTION 'seat missing or left for % and no club wallet resolves for it - hand write rejected whole', v_uid;
          END IF;
          v_delta_sum := v_delta_sum + (v_new - v_before);
          v_departed := v_departed || jsonb_build_array(
            jsonb_build_object(
              'user_id', v_uid,
              'delta', round(v_new - v_before, 2),
              'club_id', v_dep_club
            ) || CASE WHEN v_exact_seat_generation THEN jsonb_build_object(
              'seat_id', v_exact_seat_id,
              'seat_joined_at', e->>'seat_joined_at'
            ) ELSE '{}'::jsonb END
          );
          v_n := v_n + 1;
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;
      END IF;
      v_old := COALESCE(v_old, 0);

      IF v_delta_mode THEN
        v_before := round((e->>'stack_before')::numeric, 2);
        IF v_before IS NULL OR v_before < 0 THEN
          RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
        END IF;
        v_target := round(v_old + (v_new - v_before), 2);
        IF v_target < 0 THEN
          RAISE EXCEPTION 'negative stack for % after applying delta % to the seat''s % (engine dealt from %) - hand write rejected whole',
            v_uid, round(v_new - v_before, 2), v_old, v_before;
        END IF;
        v_delta_sum := v_delta_sum + (v_new - v_before);
        IF round(v_old - v_before, 2) <> 0 THEN
          v_rebased := v_rebased || jsonb_build_object(v_uid::text, round(v_old - v_before, 2));
          v_rebase_rows := v_rebase_rows || jsonb_build_array(jsonb_build_object(
            'user_id', v_uid, 'engine_before', v_before, 'db_before', v_old,
            'engine_after', v_new, 'written', v_target));
          v_rebase_count := v_rebase_count + 1;
        END IF;
      ELSE
        v_target := v_new;
        v_delta_sum := v_delta_sum + (v_new - v_old);
      END IF;
      v_targets := v_targets || jsonb_build_object(v_uid::text, v_target);
      v_n := v_n + 1;
    END LOOP;

    UPDATE public.ca_settlements SET state='calculated',
      totals = jsonb_build_object('players', v_n, 'net_deltas', round(v_delta_sum,2),
                                  'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
                                  'rebased', v_rebased, 'ref', p_ref, 'departed', v_departed)
      WHERE id = v_ca_id AND state='locked_for_calculation';

    SELECT tb.tournament_id INTO v_tournament_id FROM public.tables tb WHERE tb.id = p_table_id;

    IF v_delta_mode THEN
      /* THE IDENTITY, ON THE ENGINE'S OWN ARITHMETIC: what the seats gained
         is what arrived from a declared pool, less what left as rake and
         jackpot drop. Checked on every table, cash or tournament, on every
         write. A credit that landed on the row is outside the identity by
         construction - it is in v_old, not in the delta - so it is preserved
         rather than "explained". */
      v_expected := COALESCE(p_inflow, 0) - COALESCE(p_rake, 0) - COALESCE(p_bbj, 0);
      IF round(v_delta_sum - v_expected, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas % != inflow % - rake % - bbj % (table % hand %) - write refused whole',
          round(v_delta_sum, 2), COALESCE(p_inflow, 0), COALESCE(p_rake, 0), COALESCE(p_bbj, 0),
          p_table_id, p_hand_number::text || COALESCE(':' || p_ref, '');
      END IF;
    ELSE
      -- ═══ TOURNAMENT CHIPS ARE CONSERVED HAND BY HAND (chip-std Lane F, 2026-09-02) ═══
      -- Absolute mode only. A tournament table has no rake and no BBJ drop,
      -- so the named seats must sum, after this write, to exactly what they
      -- summed to before it. A paid rebuy/re-entry/add-on commits its seat and
      -- roster under the accepted-hand table lock. The dealing loop reloads
      -- those authoritative rows before admitting the next hand. Therefore a
      -- non-zero delta is stale hand input, never permission to scan payment
      -- history and reconstruct chips. Refuse the whole hand at the boundary.
      IF v_tournament_id IS NOT NULL AND round(v_delta_sum, 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation (tournament %): stale accepted-hand stacks changed the table total by % across % seat(s) of table % hand % - paid seat/roster generations must be reloaded before dealing; write refused whole',
          v_tournament_id,round(v_delta_sum,2),v_n,p_table_id,p_hand_number;
      END IF;

      -- strict conservation only when rake is declared
      IF p_rake IS NOT NULL
         AND round(v_delta_sum + p_rake + COALESCE(p_bbj, 0), 2) <> 0 THEN
        RAISE EXCEPTION 'conservation violation: stack deltas %.2f + rake %.2f + bbj %.2f != 0',
          v_delta_sum, p_rake, COALESCE(p_bbj, 0);
      END IF;
    END IF;
    UPDATE public.ca_settlements SET state='validated' WHERE id = v_ca_id AND state='calculated';

    /* ONE SEAT WRITE PER HAND (2026-09-10). fn_ca_commit_hand_settlement (the
       12-argument door) validates the hand's time-bank obligations, publishes
       them in the transaction-local setting app.ca_hand_time_banks, and only
       then calls down to this core. When that envelope names this exact table
       and hand, the stack write below also sets the two time-bank columns,
       under the same seat guards, so the seat row is written once per hand
       instead of stack-then-time-bank (two full trigger passes plus the FK
       re-checks a second write of the same row costs). The door proves the
       resulting state before it counts it and still writes any seat this core
       did not carry. Any other caller leaves the setting unset and gets the
       unchanged stack-only write. Nothing here reaches the request hash,
       the receipt or the returned result. */
    v_tb_map := NULL;
    v_tb_env_text := current_setting('app.ca_hand_time_banks', true);
    IF v_tb_env_text IS NOT NULL AND v_tb_env_text <> ''
       AND pg_input_is_valid(v_tb_env_text, 'jsonb') THEN
      v_tb_env := v_tb_env_text::jsonb;
      IF jsonb_typeof(v_tb_env) = 'object'
         AND v_tb_env->>'table_id' = p_table_id::text
         AND v_tb_env->>'hand_number' = p_hand_number::text
         AND (v_tb_env->>'exact')::boolean IS NOT DISTINCT FROM v_exact_seat_generation
         AND jsonb_typeof(v_tb_env->'items') = 'array' THEN
        -- Every item well formed and one item per player, or no fold at all.
        SELECT CASE WHEN count(*) > 0
                     AND count(*) = count(*) FILTER (WHERE x.ok)
                     AND count(*) = count(DISTINCT x.uid)
                    THEN jsonb_object_agg(x.uid, x.item) END
          INTO v_tb_map
          FROM (
            SELECT i.value AS item,
                   COALESCE(lower(i.value->>'user_id'), '') AS uid,
                   jsonb_typeof(i.value) = 'object'
                   AND (i.value->>'user_id') ~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   AND CASE WHEN (i.value->>'uses_remaining') ~ '^[0-9]+$'
                            THEN (i.value->>'uses_remaining')::numeric <= 2147483647
                            ELSE false END
                   AND CASE WHEN (i.value->>'seconds_remaining') ~ '^[0-9]+$'
                            THEN (i.value->>'seconds_remaining')::numeric <= 2147483647
                            ELSE false END
                   AND (NOT v_exact_seat_generation OR (
                     (i.value->>'seat_id') ~*
                       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     AND pg_input_is_valid(i.value->>'seat_joined_at',
                                           'timestamp with time zone'))) AS ok
              FROM jsonb_array_elements(v_tb_env->'items') i
          ) x;
      END IF;
    END IF;

    FOR e IN SELECT * FROM jsonb_array_elements(v_canonical) LOOP
      v_uid := (e->>'user_id')::uuid;
      IF NOT (v_targets ? v_uid::text) THEN
        CONTINUE;  -- a departed seat: settled against the wallet below
      END IF;
      v_target := (v_targets->>(v_uid::text))::numeric;
      -- The time-bank item for this seat, only when it names this exact
      -- seat generation. Otherwise the write is stack-only, as before.
      v_tb := CASE WHEN v_tb_map IS NOT NULL THEN v_tb_map->(v_uid::text) END;
      IF v_tb IS NOT NULL AND v_exact_seat_generation
         AND ((v_tb->>'seat_id')::uuid IS DISTINCT FROM (e->>'seat_id')::uuid
              OR (v_tb->>'seat_joined_at')::timestamptz
                   IS DISTINCT FROM (e->>'seat_joined_at')::timestamptz) THEN
        v_tb := NULL;
      END IF;
      IF v_exact_seat_generation THEN
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.id = (e->>'seat_id')::uuid
             AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
             AND ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.left_at IS NULL;
        END IF;
      ELSE
        IF v_tb IS NOT NULL THEN
          UPDATE public.table_seats ts
             SET stack = v_target,
                 time_bank_uses_remaining = (v_tb->>'uses_remaining')::integer,
                 time_bank_remaining = (v_tb->>'seconds_remaining')::integer
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        ELSE
          UPDATE public.table_seats ts SET stack = v_target
           WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL;
        END IF;
      END IF;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> 1 THEN
        /* aaa_skip_noop_update returns NULL for a row that would not change,
           and ROW_COUNT then reads 0. The seat was locked and found above, so
           a zero-row update whose seat already holds the target is the trigger
           doing its job, not a failed write. Before 2026-09-04 this rejected
           8,645 hands an hour - every hand in which one player's stack did not
           move - and each of those was persisted by the engine's unchecked
           per-seat fallback instead. */
        IF NOT EXISTS (
          SELECT 1
            FROM public.table_seats ts
           WHERE ts.table_id = p_table_id
             AND ts.user_id = v_uid
             AND ts.stack = v_target
             AND (
               (v_exact_seat_generation
                 AND ts.id = (e->>'seat_id')::uuid
                 AND ts.joined_at = (e->>'seat_joined_at')::timestamptz
                 AND ts.left_at IS NULL)
               OR (NOT v_exact_seat_generation AND ts.left_at IS NULL)
             )
        ) THEN
          RAISE EXCEPTION 'seat write failed for % - hand write rejected whole', v_uid;
        END IF;
      END IF;
    END LOOP;

    -- A successful tournament hand has one durable stack source. Mirror the
    -- exact resulting/rebased live seat targets into the matching playing
    -- tournament_players rows while both sets are still locked. Any missing,
    -- duplicate or divergent row rejects the whole hand subtransaction.
    IF v_tournament_id IS NOT NULL THEN
      UPDATE public.tournament_players tp
         SET chips = target.stack
        FROM (
          SELECT x.key::uuid AS user_id,x.value::numeric AS stack
            FROM jsonb_each_text(v_targets) AS x(key,value)
        ) target
       WHERE tp.tournament_id = v_tournament_id
         AND tp.user_id = target.user_id
         AND tp.status::text = 'playing';

      SELECT count(*),
             COALESCE(array_agg(tp.user_id ORDER BY tp.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'user_id',tp.user_id,'chips',tp.chips)
               ORDER BY tp.user_id),'[]'::jsonb)
        INTO v_tournament_player_count,v_tournament_player_user_ids,
             v_tournament_player_chips
        FROM public.tournament_players tp
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = tp.user_id
       WHERE tp.tournament_id = v_tournament_id
         AND tp.status::text = 'playing';
      IF v_tournament_player_count <>
           (SELECT count(*) FROM jsonb_each(v_targets))
         OR EXISTS (
           SELECT 1
             FROM jsonb_each_text(v_targets) target
            WHERE NOT EXISTS (
              SELECT 1
                FROM public.tournament_players tp
                JOIN public.table_seats ts
                  ON ts.table_id = p_table_id
                 AND ts.user_id = tp.user_id
                 AND ts.left_at IS NULL
               WHERE tp.tournament_id = v_tournament_id
                 AND tp.status::text = 'playing'
                 AND tp.user_id = target.key::uuid
                 AND tp.chips IS NOT DISTINCT FROM target.value::numeric
                 AND ts.stack IS NOT DISTINCT FROM target.value::numeric)) THEN
        RAISE EXCEPTION
          'tournament % hand % did not durably sync every final seat stack',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      -- A named zero-stack tournament seat is finished on the felt at this
      -- same durable hand boundary. Keep tournament_players playing with
      -- chips=0 so the rebuy/elimination state machine can decide its life,
      -- but release the physical seat now. This replaces the former
      -- PostgREST vacate followed by a compensating chips-zero write.
      SELECT count(*),
             COALESCE(array_agg(ts.id ORDER BY ts.id),ARRAY[]::uuid[]),
             COALESCE(array_agg(ts.user_id ORDER BY ts.user_id),ARRAY[]::uuid[]),
             COALESCE(jsonb_agg(jsonb_build_object(
               'seat_id',ts.id,
               'user_id',ts.user_id,
               'seat_number',ts.seat_number,
               'joined_at',ts.joined_at)
               ORDER BY ts.id),'[]'::jsonb)
        INTO v_zero_stack_seat_count,v_zero_stack_seat_ids,
             v_zero_stack_user_ids,v_zero_stack_seat_generations
        FROM public.table_seats ts
        JOIN jsonb_each_text(v_targets) target
          ON target.key::uuid = ts.user_id
       WHERE ts.table_id = p_table_id
         AND ts.left_at IS NULL
         AND ts.stack = 0
         AND ts.user_id IS NOT NULL
         AND ts.joined_at IS NOT NULL
         AND target.value::numeric = 0;
      IF v_zero_stack_seat_count <>
           (SELECT count(*) FROM jsonb_each_text(v_targets) target
             WHERE target.value::numeric = 0) THEN
        RAISE EXCEPTION
          'tournament % hand % cannot identify every named zero-stack seat',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;

      IF v_zero_stack_seat_count > 0 THEN
        v_zero_stack_vacated_at := clock_timestamp();
        UPDATE public.table_seats ts
           SET left_at = v_zero_stack_vacated_at,
               status = 'left',
               leave_pending = false,
               is_sitting_out = false,
               is_away = false,
               sit_out_at = NULL,
               scheduled_leave_hands = NULL
         WHERE ts.id = ANY(v_zero_stack_seat_ids)
           AND ts.table_id = p_table_id
           AND ts.left_at IS NULL
           AND ts.stack = 0;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_zero_stack_seat_count
           OR EXISTS (
             SELECT 1
               FROM unnest(v_zero_stack_seat_ids) expected(id)
              WHERE NOT EXISTS (
                SELECT 1 FROM public.table_seats ts
                 WHERE ts.id = expected.id
                   AND ts.table_id = p_table_id
                   AND ts.stack = 0
                   AND ts.left_at = v_zero_stack_vacated_at
                   AND ts.status = 'left'
                   AND COALESCE(ts.leave_pending,false) IS FALSE
                   AND COALESCE(ts.is_sitting_out,false) IS FALSE
                   AND COALESCE(ts.is_away,false) IS FALSE
                   AND ts.sit_out_at IS NULL
                   AND ts.scheduled_leave_hands IS NULL))
           OR EXISTS (
             SELECT 1
               FROM public.table_seats ts
               JOIN jsonb_each_text(v_targets) target
                 ON target.key::uuid = ts.user_id
              WHERE ts.table_id = p_table_id
                AND ts.left_at IS NULL
                AND target.value::numeric = 0) THEN
          RAISE EXCEPTION
            'tournament % hand % did not atomically vacate every zero-stack seat',
            v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
        END IF;
      END IF;

      SELECT count(*) INTO v_table_live_seat_count
        FROM public.table_seats ts
       WHERE ts.table_id = p_table_id AND ts.left_at IS NULL;
      UPDATE public.tables tb
         SET current_players = v_table_live_seat_count,
             updated_at = now()
       WHERE tb.id = p_table_id
         AND tb.current_players IS DISTINCT FROM v_table_live_seat_count;
      IF NOT EXISTS (
        SELECT 1 FROM public.tables tb
         WHERE tb.id = p_table_id
           AND tb.tournament_id = v_tournament_id
           AND tb.current_players = v_table_live_seat_count) THEN
        RAISE EXCEPTION
          'tournament % hand % did not persist its exact live-seat count',
          v_tournament_id,p_hand_number USING ERRCODE = 'P0404';
      END IF;
    END IF;

    /* THE LEAVER STILL OWES WHAT THEY BET, AND IS STILL OWED WHAT THEY WON.
       The exit credited the seat's pre-hand stack to the club wallet, so a
       negative delta is chips the wallet holds that the pot (and now the
       winner's seat) also holds: debit the wallet, counterparty the felt.
       A positive delta is a pot they won after leaving: credit it. Keyed on
       hand + user in wallet_credit_idempotency, so a retry of this hand
       settles nothing twice. A wallet that cannot cover the debit refuses
       the whole hand, with the numbers, rather than going negative. */
    FOR v_dep IN SELECT (d->>'user_id')::uuid AS user_id, (d->>'delta')::numeric AS delta, (d->>'club_id')::uuid AS club_id
                   FROM jsonb_array_elements(v_departed) d LOOP
      IF v_dep.delta = 0 THEN CONTINUE; END IF;
      v_dep_key := 'late_seat_settle:' || v_hand::text || ':' || v_dep.user_id::text;
      INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
      VALUES (v_dep_key, v_dep.user_id, v_dep.delta)
      ON CONFLICT (key) DO NOTHING;
      GET DIAGNOSTICS v_dep_claimed = ROW_COUNT;
      IF v_dep_claimed = 0 THEN CONTINUE; END IF;  -- already settled by an earlier attempt
      PERFORM public.fn_ca_declare_ledger('settlement', 'table_stack', p_table_id, v_ca_id, v_dep_key, NULL);
      UPDATE public.club_members m
         SET chip_balance = COALESCE(m.chip_balance, 0) + v_dep.delta, updated_at = now()
       WHERE m.user_id = v_dep.user_id AND m.club_id = v_dep.club_id
         AND COALESCE(m.chip_balance, 0) + v_dep.delta >= 0
       RETURNING m.chip_balance INTO v_dep_after;
      PERFORM set_config('app.ledger_category', '', true);
      PERFORM set_config('app.ledger_counterparty', '', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      IF v_dep_after IS NULL THEN
        RAISE EXCEPTION 'seat missing or left for % and its club wallet cannot cover its delta of % - hand write rejected whole', v_dep.user_id, v_dep.delta;
      END IF;
      INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
      VALUES (v_dep.club_id, v_dep.user_id, abs(v_dep.delta),
              CASE WHEN v_dep.delta < 0 THEN 'late_seat_debit' ELSE 'late_seat_credit' END,
              CASE WHEN v_dep.delta < 0
                   THEN format('Hand #%s settled after you left the table: %s chips you had bet are taken from the club wallet the seat cashed out to', p_hand_number, abs(v_dep.delta))
                   ELSE format('Hand #%s settled after you left the table: %s chips you won are credited to your club wallet', p_hand_number, v_dep.delta) END,
              p_table_id, v_dep_after, jsonb_build_object('hand_id', v_hand, 'key', v_dep_key, 'delta', v_dep.delta));
    END LOOP;
    UPDATE public.ca_settlements SET state='ledger_posted' WHERE id = v_ca_id AND state='validated';

    IF v_rebase_count > 0 THEN
      INSERT INTO public.ca_seat_stack_rebases
        (settlement_id, table_id, hand_id, hand_number, user_id, engine_before, db_before, engine_after, written)
      SELECT v_ca_id, p_table_id, v_hand, p_hand_number,
             (r->>'user_id')::uuid, (r->>'engine_before')::numeric, (r->>'db_before')::numeric,
             (r->>'engine_after')::numeric, (r->>'written')::numeric
        FROM jsonb_array_elements(v_rebase_rows) r;
    END IF;
    UPDATE public.ca_settlements SET state='post_commit_verified' WHERE id = v_ca_id AND state='ledger_posted';

    v_result := jsonb_build_object('success', true, 'players', v_n,
      'table_id', p_table_id, 'hand_id', v_hand, 'hand_number', p_hand_number,
      'net_deltas', round(v_delta_sum, 2), 'rake', p_rake, 'bbj', p_bbj, 'inflow', p_inflow,
      'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END,
      'rebased', v_rebased, 'written', v_targets, 'departed', v_departed,
      'conservation_checked', v_delta_mode OR p_rake IS NOT NULL,
      'tournament_id', v_tournament_id,
      'tournament_players_synced', v_tournament_id IS NOT NULL,
      'tournament_player_count', v_tournament_player_count,
      'tournament_player_user_ids', to_jsonb(v_tournament_player_user_ids),
      'tournament_player_chips', v_tournament_player_chips,
      'tournament_zero_stack_seats_vacated', v_tournament_id IS NOT NULL,
      'tournament_zero_stack_seat_count', v_zero_stack_seat_count,
      'tournament_zero_stack_seat_ids', to_jsonb(v_zero_stack_seat_ids),
      'tournament_zero_stack_user_ids', to_jsonb(v_zero_stack_user_ids),
      'tournament_zero_stack_seat_generations', v_zero_stack_seat_generations,
      'tournament_zero_stack_vacated_at', v_zero_stack_vacated_at,
      'tournament_table_live_seat_count', v_table_live_seat_count,
      'request', v_request);

    UPDATE public.settlement_idempotency_keys
       SET status='succeeded', result=v_result, completed_at=now(), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='final' WHERE id = v_ca_id AND state='post_commit_verified';
    RETURN v_result;

  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    UPDATE public.settlement_idempotency_keys
       SET status='failed', error=left(v_err, 500), last_attempt_at=now()
     WHERE table_id = p_table_id AND hand_id = v_hand;
    UPDATE public.ca_settlements SET state='failed', error_detail=left(v_err, 2000) WHERE id = v_ca_id;
    IF v_err LIKE 'conservation violation%' OR v_err LIKE 'negative stack%' THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settle_hand_stacks_absolute', 'ledger_imbalance', 'warning',
        'hand-conservation:' || p_table_id::text,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2), 0,
        round(v_delta_sum + COALESCE(p_rake,0) + COALESCE(p_bbj,0) - COALESCE(p_inflow,0), 2),
        'settlement', 'table_seats', v_hand, NULL, NULL, p_table_id, NULL, v_hand,
        v_ca_id::text, NULL, NULL,
        'engine submitted a hand whose stack deltas do not conserve: ' || left(v_err, 200),
        false, jsonb_build_object('hand_number', p_hand_number, 'ref', p_ref,
                                  'mode', CASE WHEN v_delta_mode THEN 'delta' ELSE 'absolute' END));
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'rolled_back', 'error', v_err,
                              'table_id', p_table_id, 'hand_number', p_hand_number, 'ref', p_ref);
  END;
END $function$;
ALTER FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure AND md5(pg_get_functiondef(oid))='04e0218bf245c99a60b4d34f233c3b7a' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 30;
$function$;
ALTER FUNCTION public.fn_engine_lease_stale_seconds() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_engine_lease_stale_seconds() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_engine_lease_stale_seconds() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure AND md5(pg_get_functiondef(oid))='483a7e0ee940744fd557f1f2144d9eba' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.complete_hand_snapshot(p_table_id uuid, p_hand_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE hand_state_snapshots
  SET is_complete = TRUE, updated_at = NOW()
  WHERE table_id = p_table_id
    AND hand_number = p_hand_number
    AND is_complete = FALSE;
END;
$function$;
ALTER FUNCTION public.complete_hand_snapshot(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_hand_snapshot(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_hand_snapshot(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.complete_hand_snapshot(uuid,integer) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.complete_hand_snapshot(uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='dd69801c4d64338a2d20ce8b4b60641c' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_stack_result jsonb;
  v_hand_id uuid;
  v_existing public.hand_history%ROWTYPE;
  v_prior public.hand_atomic_commits%ROWTYPE;
  v_commit_hash text;
  v_normalized_stacks jsonb;
  v_normalized_units jsonb;
  v_stack jsonb;
  v_uid uuid;
  v_written numeric;
  v_before numeric;
  v_seat record;
  v_zero_generation jsonb;
  v_zero_generation_count integer;
  v_prompt_until timestamptz;
  v_rebuy_window jsonb;
  v_rebuy_offer_available boolean;
  v_n integer;
  v_distinct integer;
  v_changed integer;
  v_candidate_id uuid;
BEGIN
  -- External authority is the EXECUTE ACL on the lease-fenced public wrapper.
  -- This nested SECURITY DEFINER core is owner-only and must remain callable
  -- when its preserved production owner is neither postgres nor service_role.
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number<1000000
     OR jsonb_typeof(p_stacks)<>'array' OR jsonb_array_length(p_stacks)=0
     OR jsonb_typeof(p_hand_row)<>'object'
     OR jsonb_typeof(coalesce(p_units,'[]'::jsonb))<>'array'
     OR coalesce(p_hand_row->>'table_id','')<>p_table_id::text
     OR coalesce(p_hand_row->>'hand_number','')<>p_hand_number::text THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_atomic_hand_payload');
  END IF;

  SELECT count(*), count(DISTINCT x->>'user_id')
    INTO v_n, v_distinct
    FROM jsonb_array_elements(p_stacks) x
   WHERE jsonb_typeof(x)='object'
     AND coalesce(x->>'user_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND jsonb_typeof(x->'stack')='number'
     AND jsonb_typeof(x->'stack_before')='number'
     AND (x->>'stack')::numeric>=0
     AND (x->>'stack_before')::numeric>=0;
  IF v_n<>jsonb_array_length(p_stacks) OR v_distinct<>v_n THEN
    RETURN jsonb_build_object('success',false,'reason','invalid_or_duplicate_stack_rows');
  END IF;

  SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO v_normalized_stacks
    FROM jsonb_array_elements(p_stacks) x;
  SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_normalized_units
    FROM jsonb_array_elements(coalesce(p_units,'[]'::jsonb)) x;
  v_commit_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'table_id',p_table_id,'hand_number',p_hand_number,
    'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
    'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
    'units',v_normalized_units)::text,'UTF8'),'sha256'),'hex');

  -- Lock order is global tournament lifecycle -> table -> exact table hand.
  -- Paid admissions take the global root exclusively before the same table
  -- lock; unrelated hands share the lifecycle root and remain concurrent.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-table:'||p_table_id::text,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('atomic-hand:'||p_hand_number::text,0));

  SELECT * INTO v_prior
    FROM public.hand_atomic_commits c
   WHERE c.table_id=p_table_id
     AND c.hand_number=p_hand_number
   FOR UPDATE;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_commit_hash THEN
      RETURN jsonb_build_object(
        'success',false,'reason','atomic_hand_payload_conflict',
        'hand_number',p_hand_number,'existing_table_id',v_prior.table_id);
    END IF;
    RETURN v_prior.stack_result || jsonb_build_object(
      'success',true,'atomic_hand_commit',true,'replay',true,
      'history_id',v_prior.hand_id,'commit_hash',v_prior.payload_hash);
  END IF;

  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t WHERE t.id=p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'reason','table_not_found');
  END IF;

  IF (p_hand_row->>'tournament_id') IS DISTINCT FROM v_tournament_id::text THEN
    RETURN jsonb_build_object(
      'success',false,'reason','hand_tournament_mismatch',
      'table_tournament_id',v_tournament_id,
      'row_tournament_id',p_hand_row->>'tournament_id');
  END IF;

  BEGIN
    IF v_tournament_id IS NOT NULL THEN
      PERFORM 1 FROM public.tournaments t WHERE t.id=v_tournament_id FOR SHARE;
      PERFORM 1
        FROM public.tournament_players tp
       WHERE tp.tournament_id=v_tournament_id
         AND tp.user_id IN (
           SELECT (x->>'user_id')::uuid FROM jsonb_array_elements(p_stacks) x)
       ORDER BY tp.user_id
       FOR UPDATE;
    END IF;

    v_stack_result := public.fn_ca_settle_hand_stacks_absolute(
      p_table_id,p_hand_number,v_normalized_stacks,p_rake,p_bbj,p_ref,p_inflow);
    IF coalesce((v_stack_result->>'success')::boolean,false) IS NOT TRUE THEN
      RETURN v_stack_result || jsonb_build_object('atomic_hand_commit',false);
    END IF;
    IF coalesce((v_stack_result->>'replay')::boolean,false) IS TRUE THEN
      RAISE EXCEPTION 'legacy stack settlement exists for hand % without an atomic receipt',
        p_hand_number USING ERRCODE='integrity_constraint_violation';
    END IF;

    SELECT * INTO v_existing
      FROM public.hand_history h
     WHERE h.table_id=p_table_id AND h.hand_number=p_hand_number;
    IF FOUND THEN
      RAISE EXCEPTION 'hand % already exists without an atomic commit receipt',p_hand_number
        USING ERRCODE='integrity_constraint_violation';
    ELSE
      PERFORM set_config('app.atomic_hand_commit','on',true);
      v_hand_id := public.fn_ca_insert_hand_with_awards(p_hand_row,p_units);
    END IF;

    IF v_tournament_id IS NOT NULL THEN
      IF jsonb_typeof(
           v_stack_result->'tournament_zero_stack_seat_generations')
             IS DISTINCT FROM 'array'
         OR jsonb_array_length(
              v_stack_result->'tournament_zero_stack_seat_generations')
              IS DISTINCT FROM
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1)
         OR (
              COALESCE(
                (v_stack_result->>'tournament_zero_stack_seat_count')::integer,-1) > 0
              AND (v_stack_result->>'tournament_zero_stack_vacated_at') IS NULL
            ) THEN
        RAISE EXCEPTION
          'accepted tournament hand omitted exact zero-seat generation evidence';
      END IF;

      FOR v_stack IN SELECT value FROM jsonb_array_elements(p_stacks)
      LOOP
        v_uid := (v_stack->>'user_id')::uuid;
        v_before := round((v_stack->>'stack_before')::numeric,2);
        v_written := round((v_stack_result->'written'->>v_uid::text)::numeric,2);
        IF v_written IS NULL THEN
          RAISE EXCEPTION 'accepted tournament hand omitted written stack for %',v_uid;
        END IF;
        IF v_written<>trunc(v_written) THEN
          RAISE EXCEPTION 'accepted tournament hand produced fractional stack % for %',v_written,v_uid;
        END IF;

        IF v_written=0 THEN
          SELECT count(*) INTO v_zero_generation_count
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          IF v_zero_generation_count<>1 THEN
            RAISE EXCEPTION
              'accepted tournament hand has % zero-seat generations for %',
              v_zero_generation_count,v_uid USING ERRCODE='P0404';
          END IF;
          SELECT g.value INTO v_zero_generation
            FROM jsonb_array_elements(
                   v_stack_result->'tournament_zero_stack_seat_generations') g(value)
           WHERE g.value->>'user_id'=v_uid::text;
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.id=(v_zero_generation->>'seat_id')::uuid
             AND s.table_id=p_table_id
             AND s.user_id=v_uid
             AND s.seat_number=(v_zero_generation->>'seat_number')::integer
             AND s.joined_at=(v_zero_generation->>'joined_at')::timestamptz
             AND s.stack=0
             AND s.left_at=
                   (v_stack_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND lower(COALESCE(s.status,''))='left'
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost exact closed seat generation for %',v_uid
              USING ERRCODE='P0404';
          END IF;
        ELSE
          SELECT s.id,s.joined_at,s.seat_number
            INTO v_seat
            FROM public.table_seats s
           WHERE s.table_id=p_table_id AND s.user_id=v_uid AND s.left_at IS NULL
           FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'accepted tournament hand lost active seat for % before generation capture',v_uid;
          END IF;
        END IF;

        UPDATE public.tournament_players tp
           SET chips=greatest(v_written,0)::integer,
               table_id=p_table_id,
               seat_number=v_seat.seat_number
         WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
           AND tp.status='playing';
        GET DIAGNOSTICS v_changed=ROW_COUNT;
        IF v_changed<>1 AND NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing'
             AND tp.chips=greatest(v_written,0)::integer
             AND tp.table_id=p_table_id
             AND tp.seat_number=v_seat.seat_number) THEN
          RAISE EXCEPTION
            'accepted tournament hand could not mirror playing roster row for %',v_uid;
        END IF;

        IF v_before>0 AND v_written=0 THEN
          SELECT
            (coalesce(t.is_rebuy,false)
               AND (t.max_rebuys IS NULL OR coalesce(tp.rebuys,0)<t.max_rebuys))
            OR
            (coalesce(t.is_reentry,false)
               AND (t.max_reentries IS NULL OR coalesce(tp.rebuys,0)<t.max_reentries)),
            public.fn_ca_tournament_rebuy_window(v_tournament_id)
            INTO v_rebuy_offer_available,v_rebuy_window
            FROM public.tournaments t
            JOIN public.tournament_players tp
              ON tp.tournament_id=t.id AND tp.user_id=v_uid
           WHERE t.id=v_tournament_id;
          v_prompt_until:=CASE
            WHEN v_rebuy_offer_available
             AND coalesce((v_rebuy_window->>'open')::boolean,false)
            THEN (v_rebuy_window->>'prompt_until')::timestamptz
            ELSE NULL END;
          IF v_prompt_until IS NOT NULL
             AND v_prompt_until<=clock_timestamp() THEN
            RAISE EXCEPTION
              'authoritative rebuy window returned an expired prompt for tournament %',
              v_tournament_id USING ERRCODE='P0404';
          END IF;

          v_candidate_id := NULL;
          INSERT INTO public.tournament_knockout_candidates(
            tournament_id,eliminated_user_id,table_id,seat_id,seat_joined_at,
            hand_id,hand_number,stack_before,stack_after,rebuy_prompt_until)
          VALUES (
            v_tournament_id,v_uid,p_table_id,v_seat.id,v_seat.joined_at,
            v_hand_id,p_hand_number,v_before,0,v_prompt_until)
          -- One accepted hand is one immutable knockout generation. A rebuy can
          -- bust again in the same physical chair, so chair identity must never
          -- absorb that later hand.
          ON CONFLICT (tournament_id,hand_number,eliminated_user_id) DO NOTHING
          RETURNING id INTO v_candidate_id;
          IF v_candidate_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.tournament_knockout_candidates c
             WHERE c.tournament_id=v_tournament_id
               AND c.hand_number=p_hand_number
               AND c.eliminated_user_id=v_uid
               AND c.table_id=p_table_id
               AND c.seat_id=v_seat.id
               AND c.seat_joined_at=v_seat.joined_at
               AND c.hand_id=v_hand_id
               AND c.stack_before=v_before
               AND c.stack_after=0) THEN
            RAISE EXCEPTION
              'knockout candidate identity conflict for tournament %, hand %, user %',
              v_tournament_id,p_hand_number,v_uid;
          END IF;

          UPDATE public.tournament_players tp
             SET rebuy_prompt_until=v_prompt_until
           WHERE tp.tournament_id=v_tournament_id AND tp.user_id=v_uid
             AND tp.status='playing';
        END IF;
      END LOOP;
    END IF;

    INSERT INTO public.hand_projection_outbox(hand_id,table_id,hand_number)
    VALUES (v_hand_id,p_table_id,p_hand_number);

    INSERT INTO public.hand_atomic_commits(
      table_id,hand_number,hand_id,payload_hash,stack_result)
    VALUES (p_table_id,p_hand_number,v_hand_id,v_commit_hash,v_stack_result);

    PERFORM public.fn_cash_accept_hand_provenance(p_table_id,p_hand_number,v_hand_id,
      v_normalized_stacks,p_rake,p_bbj,p_inflow,v_commit_hash,
      jsonb_build_object(
        'table_id',p_table_id,'hand_number',p_hand_number,
        'stacks',v_normalized_stacks,'rake',p_rake,'bbj',p_bbj,
        'ref',p_ref,'inflow',p_inflow,'hand_row',p_hand_row,
        'units',v_normalized_units));

    RETURN v_stack_result || jsonb_build_object(
      'success',true,
      'atomic_hand_commit',true,
      'history_id',v_hand_id,
      'tournament_id',v_tournament_id,
      'commit_hash',v_commit_hash);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success',false,'atomic_hand_commit',false,'reason','atomic_hand_rolled_back',
      'error',SQLERRM,'sqlstate',SQLSTATE,'table_id',p_table_id,
      'hand_number',p_hand_number,'commit_hash',v_commit_hash);
  END;
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='b49192e78f472d7a931bcf20de46a702' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_locked_tournament_id uuid;
  v_holder text;
  v_generation uuid;
  v_protocol_version integer;
  v_heartbeat_at timestamptz;
  v_lease_found boolean;
  v_scope text;
BEGIN
  IF length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_lease_generation IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'invalid_hand_lease_authority'
    );
  END IF;

  /* This read is deliberately unlocked and is used only to choose one lease
     relation.  No mutation follows until the chosen lease is locked and the
     tables row is itself locked/re-read below. */
  SELECT t.tournament_id INTO v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;

  IF v_tournament_id IS NULL THEN
    v_scope := 'table';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_table_leases l
     WHERE l.table_id = p_table_id
     FOR KEY SHARE;
    v_lease_found := FOUND;
  ELSE
    v_scope := 'tournament';
    SELECT l.instance_id, l.lease_generation, l.protocol_version, l.heartbeat_at
      INTO v_holder, v_generation, v_protocol_version, v_heartbeat_at
      FROM public.engine_tournament_leases l
     WHERE l.tournament_id = v_tournament_id
     -- A HAND COMMIT DOES NOT HOLD THE LEASE AGAINST ITS OWN HEARTBEAT
     -- (2026-09-10): FOR KEY SHARE excludes a takeover (FOR UPDATE) and
     -- nothing else, so the heartbeat can still renew this row.
     FOR KEY SHARE;
    v_lease_found := FOUND;
  END IF;

  IF NOT v_lease_found
     OR v_protocol_version IS DISTINCT FROM 2
     OR v_holder IS DISTINCT FROM p_instance_id
     OR v_generation IS DISTINCT FROM p_lease_generation THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_lost',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  IF v_heartbeat_at < clock_timestamp() - make_interval(
       secs => public.fn_engine_lease_stale_seconds()
     ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_stale',
      'lease_scope', v_scope,
      'lease_generation', v_generation
    );
  END IF;

  /* Match the unchanged core and manager lock order before taking the mutable
     table row.  FOR SHARE excludes tournament lifecycle updates without
     serializing hands at distinct tables in the same event. */
  IF v_tournament_id IS NOT NULL THEN
    PERFORM 1
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'tournament_not_found');
    END IF;
  END IF;

  /* Cash uses lease -> table. Tournament settlement uses
     lease -> tournament parent -> table. Holding the exact lease now prevents
     takeover until the unchanged core has committed or rolled back. */
  SELECT t.tournament_id INTO v_locked_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'table_not_found');
  END IF;
  IF v_locked_tournament_id IS DISTINCT FROM v_tournament_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'atomic_hand_commit', false,
      'reason', 'hand_lease_scope_changed'
    );
  END IF;

  RETURN public.fn_ca_commit_hand_settlement_before_lease_generation(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units
  );
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='c555fb7b83c889312995bc0038c1b275' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    OR p_hand_row->>'game_variant' IS DISTINCT FROM 'nlh'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='8c0acda3b19e958ecd5bbbc07c845afe' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
BEGIN
  -- Acquire G before B and T; source custody guards also need G.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  -- B shared: yields to terminal authorities, concurrent with every other
  -- hand and with rolling authorities of OTHER tournaments.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));

  IF p_table_id IS NULL THEN
    RETURN;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
  FROM public.tables tb
  WHERE tb.id = p_table_id;

  IF v_tournament_id IS NOT NULL THEN
    -- T(id) shared: yields to this tournament's own rolling authorities.
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('ca:tournament-terminal-settlement:v1:' || v_tournament_id::text, 0));
  END IF;
END;
$function$;
ALTER FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='409b14ee72ce888d3b26524c52d49a68' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_hand_dispatch_guard(tid uuid, hn bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
 IF h.state IN ('never_started','aborted_unsettled') THEN RAISE EXCEPTION 'F06_HAND_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 IF h.state='reserved' THEN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 INSERT INTO smarter_private.f06_hand_dispatch VALUES(h.permit_id,txid_current()) ON CONFLICT(permit_id) DO UPDATE SET xid=EXCLUDED.xid;
 END IF;
 ELSIF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=tid AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RAISE EXCEPTION 'F06_UNPERMITTED_HAND' USING ERRCODE='55000';
 END IF;
END $function$;
ALTER FUNCTION smarter_private.f06_hand_dispatch_guard(uuid,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_hand_dispatch_guard(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_hand_dispatch_guard(uuid,bigint) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure AND md5(pg_get_functiondef(oid))='fa3b6cc670788a490c42f324ecf74a76' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_authority(t uuid, g uuid, take_lock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager'
 OR NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid IS DISTINCT FROM t
 OR NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid IS DISTINCT FROM g OR t IS NULL OR g IS NULL THEN
 RAISE EXCEPTION 'F06_PROTOCOL2_REQUIRED' USING ERRCODE='42501'; END IF;
 IF take_lock THEN
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 ELSE
 PERFORM 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND protocol_version=2 AND lease_generation=g
 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_LEASE_FENCED' USING ERRCODE='42501'; END IF;
END $function$;
ALTER FUNCTION smarter_private.f06_authority(uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_authority(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_authority(uuid,uuid,boolean) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure AND md5(pg_get_functiondef(oid))='848b06c8e958ad739e0a60b388430f38' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations(p_hand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_table_id uuid;
  v_commit public.hand_atomic_commits%ROWTYPE;
  v_payload jsonb;
  v_hash text;
  v_rake jsonb;
  v_bbj jsonb;
  v_pending jsonb;
  v_item jsonb;
  v_rake_result record;
  v_promo_result jsonb;
  v_pool_id uuid;
  v_union_id uuid;
  v_contribution_id uuid;
  v_insurance_id uuid;
  v_addon_result record;
  v_addon public.table_pending_addons%ROWTYPE;
  v_time_bank_count integer := 0;
  v_promo_count integer := 0;
  v_insurance_count integer := 0;
  v_addon_count integer := 0;
  v_result jsonb;
BEGIN
  /* Read only the scope, then take the per-table mutex before the row lock.
     This gives every hand at one table the same lock order. */
  SELECT c.table_id INTO v_table_id
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('hand-post-commit:' || v_table_id::text, 0)
  );

  SELECT c.* INTO v_commit
    FROM public.hand_atomic_commits c
   WHERE c.hand_id = p_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found', 'hand_id', p_hand_id);
  END IF;
  IF v_commit.post_commit_payload IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'legacy_no_obligations',
      'hand_id', p_hand_id
    );
  END IF;
  IF v_commit.post_commit_completed_at IS NOT NULL THEN
    RETURN COALESCE(v_commit.post_commit_result, '{}'::jsonb) || jsonb_build_object(
      'ok', true,
      'already_completed', true,
      'hand_id', p_hand_id,
      'completed_at', v_commit.post_commit_completed_at
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.hand_atomic_commits earlier
     WHERE earlier.table_id = v_commit.table_id
       AND earlier.hand_number < v_commit.hand_number
       AND earlier.post_commit_payload IS NOT NULL
       AND earlier.post_commit_completed_at IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'predecessor_pending',
      'hand_id', p_hand_id
    );
  END IF;

  v_payload := v_commit.post_commit_payload;
  v_hash := encode(
    extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );
  IF v_commit.post_commit_payload_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'post-commit obligation payload hash mismatch for hand %', p_hand_id;
  END IF;

  /* Time banks were stamped inside the accepted-hand transaction while the
     exact lease and seat locks were held. A delayed consumer must never apply
     those older values again after hand N+1, a table break, or a seat move. */
  IF jsonb_typeof(v_payload->'time_banks') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid time-bank audit payload for hand %', p_hand_id;
  END IF;
  v_time_bank_count := jsonb_array_length(v_payload->'time_banks');

  IF EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=v_table_id AND c.asset='diamonds') AND (
    v_payload->'rake' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'bbj_contribution' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'pending_addons' IS DISTINCT FROM 'null'::jsonb
    OR v_payload->'promo_playthrough' IS DISTINCT FROM '[]'::jsonb
    OR v_payload->'insurance' IS DISTINCT FROM '[]'::jsonb
  ) THEN
    RAISE EXCEPTION 'diamond_hand_has_chip_obligations';
  END IF;
  v_rake := v_payload->'rake';
  IF v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null' THEN
    IF jsonb_typeof(v_rake) <> 'object'
       OR COALESCE((v_rake->>'amount')::numeric, 0) <= 0
       OR (v_rake->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid rake obligation for hand %', p_hand_id;
    END IF;
    IF v_commit.hand_number > 2147483647 THEN
      RAISE EXCEPTION 'rake hand number exceeds downstream integer contract: %',
        v_commit.hand_number;
    END IF;

    SELECT * INTO v_rake_result
      FROM public.atomic_distribute_rake(
        v_commit.table_id,
        (v_rake->>'club_id')::uuid,
        v_commit.hand_id,
        v_commit.hand_number::integer,
        (v_rake->>'amount')::numeric,
        COALESCE((v_rake->>'bbj')::numeric, 0),
        NULLIF(v_rake->>'pot', '')::numeric,
        NULLIF(v_rake->>'num_players', '')::integer,
        COALESCE(v_rake->'contributions', '{}'::jsonb),
        NULLIF(v_rake->>'tournament_id', '')::uuid,
        COALESCE(v_rake->'returned_uncalled', '{}'::jsonb),
        COALESCE(NULLIF(v_rake->>'method', ''), 'WEIGHTED_CONTRIBUTED')
      );
    IF NOT FOUND OR NOT (
      COALESCE(v_rake_result.applied, false)
      OR COALESCE(v_rake_result.already_processed, false)
      OR v_rake_result.rake_record_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'rake obligation did not produce a receipt for hand %', p_hand_id;
    END IF;
  END IF;

  v_bbj := v_payload->'bbj_contribution';
  IF v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null' THEN
    IF jsonb_typeof(v_bbj) <> 'object'
       OR COALESCE((v_bbj->>'amount')::numeric, 0) <= 0
       OR (v_bbj->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid BBJ contribution obligation for hand %', p_hand_id;
    END IF;

    SELECT c.union_id INTO v_union_id
      FROM public.clubs c
     WHERE c.id = (v_bbj->>'club_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BBJ obligation club not found for hand %', p_hand_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      'bbj-pool:' || COALESCE(v_union_id::text, 'club:' || (v_bbj->>'club_id')),
      0
    ));
    IF v_union_id IS NULL THEN
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.club_id = (v_bbj->>'club_id')::uuid
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    ELSE
      SELECT p.id INTO v_pool_id
        FROM public.bbj_pools p
       WHERE p.union_id = v_union_id
         AND p.status = 'active'
       ORDER BY p.created_at, p.id
       LIMIT 1
       FOR UPDATE;
    END IF;

    IF v_pool_id IS NULL THEN
      IF v_union_id IS NULL THEN
        INSERT INTO public.bbj_pools(
          club_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          (v_bbj->>'club_id')::uuid, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      ELSE
        INSERT INTO public.bbj_pools(
          union_id, main_balance, backup_balance, promo_balance, status
        ) VALUES (
          v_union_id, 0, 0, 0, 'active'
        ) RETURNING id INTO v_pool_id;
      END IF;
    END IF;

    SELECT r.id INTO v_contribution_id
      FROM public.bbj_record_contribution(
        v_pool_id,
        v_commit.hand_id,
        v_commit.table_id,
        (v_bbj->>'amount')::numeric,
        0, 0, 0,
        COALESCE((v_bbj->>'big_blind')::numeric, 2),
        v_commit.hand_number::integer,
        (v_bbj->>'club_id')::uuid
      ) r;
    IF v_contribution_id IS NULL THEN
      RAISE EXCEPTION 'BBJ contribution produced no receipt for hand %', p_hand_id;
    END IF;
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'promo_playthrough')
     ORDER BY value->>'user_id'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'user_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE((v_item->>'wagered')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'invalid promo obligation for hand %', p_hand_id;
    END IF;
    v_promo_result := public.promo_apply_playthrough(
      (v_item->>'club_id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'wagered')::numeric
    );
    IF v_promo_result->>'reason' IN ('engine_only', 'no_wager') THEN
      RAISE EXCEPTION 'promo obligation refused for hand %: %',
        p_hand_id, v_promo_result;
    END IF;
    v_promo_count := v_promo_count + 1;
  END LOOP;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_payload->'insurance')
     ORDER BY value->>'player_id', value->>'kind'
  LOOP
    IF (v_item->>'club_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (v_item->>'player_id') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid insurance obligation for hand %', p_hand_id;
    END IF;
    SELECT r.id INTO v_insurance_id
      FROM public.record_insurance_transaction(
        v_commit.table_id,
        (v_item->>'club_id')::uuid,
        v_commit.hand_number::integer,
        (v_item->>'player_id')::uuid,
        COALESCE((v_item->>'equity_percent')::numeric, 0),
        COALESCE((v_item->>'premium')::numeric, 0),
        COALESCE((v_item->>'insured_amount')::numeric, 0),
        COALESCE((v_item->>'payout')::numeric, 0),
        COALESCE((v_item->>'player_won')::boolean, false),
        COALESCE(NULLIF(v_item->>'kind', ''), 'insurance')::varchar
      ) r;
    IF v_insurance_id IS NULL THEN
      RAISE EXCEPTION 'insurance obligation produced no receipt for hand %', p_hand_id;
    END IF;
    v_insurance_count := v_insurance_count + 1;
  END LOOP;

  v_pending := v_payload->'pending_addons';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) <> 'null' THEN
    IF jsonb_typeof(v_pending) <> 'object'
       OR COALESCE((v_pending->>'enabled')::boolean, false) IS NOT TRUE
       OR jsonb_typeof(v_pending->'ids') IS DISTINCT FROM 'array'
       OR NULLIF(v_pending->>'max_buy_in', '') IS NULL
       OR (v_pending->>'max_buy_in')::numeric <= 0 THEN
      RAISE EXCEPTION 'invalid pending-add-on obligation for hand %', p_hand_id;
    END IF;
    FOR v_item IN
      SELECT value
        FROM jsonb_array_elements(v_pending->'ids')
       ORDER BY value #>> '{}'
    LOOP
      IF (v_item #>> '{}') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        RAISE EXCEPTION 'pending add-on % is not frozen for table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      -- Recovery can encounter an ID also frozen by an earlier accepted
      -- hand. The resolver owns exactly-once delivery and returns its stored
      -- result on replay. A resolved row is evidence, not a failed payment.
      SELECT a.* INTO v_addon
        FROM public.table_pending_addons a
       WHERE a.id = (v_item #>> '{}')::uuid
         AND a.table_id = v_commit.table_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % does not belong to table % (hand %)',
          v_item, v_commit.table_id, p_hand_id;
      END IF;
      SELECT * INTO v_addon_result
        FROM public.resolve_pending_addon(
          (v_item #>> '{}')::uuid,
          NULLIF(v_pending->>'max_buy_in', '')::numeric
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pending add-on % produced no receipt for hand %',
          v_item, p_hand_id;
      END IF;
      IF v_addon.amount IS NULL OR v_addon.amount <= 0
         OR v_addon.amount::text IN ('NaN', 'Infinity', '-Infinity')
         OR (v_addon.resolved_at IS NOT NULL AND
             (v_addon.applied_to_stack IS NULL OR v_addon.refunded IS NULL))
         OR v_addon_result.applied IS NULL OR v_addon_result.applied < 0
         OR v_addon_result.applied::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.applied <> round(v_addon_result.applied, 2)
         OR v_addon_result.refunded IS NULL OR v_addon_result.refunded < 0
         OR v_addon_result.refunded::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_addon_result.refunded <> round(v_addon_result.refunded, 2)
         OR v_addon_result.applied + v_addon_result.refunded
              IS DISTINCT FROM round(v_addon.amount, 2)
      THEN
        RAISE EXCEPTION 'pending add-on % has an incomplete resolution receipt for hand %',
          v_item, p_hand_id;
      END IF;
      v_addon_count := v_addon_count + 1;
    END LOOP;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'already_completed', false,
    'hand_id', p_hand_id,
    'hand_number', v_commit.hand_number,
    'time_banks', v_time_bank_count,
    'rake', v_rake IS NOT NULL AND jsonb_typeof(v_rake) <> 'null',
    'bbj_contribution', v_bbj IS NOT NULL AND jsonb_typeof(v_bbj) <> 'null',
    'promo_playthrough', v_promo_count,
    'insurance', v_insurance_count,
    'pending_addons', v_addon_count
  );

  UPDATE public.hand_atomic_commits c
     SET post_commit_completed_at = clock_timestamp(),
         post_commit_result = v_result
   WHERE c.hand_id = p_hand_id
     AND c.post_commit_completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post-commit completion receipt was lost for hand %', p_hand_id;
  END IF;

  RETURN v_result;
END;
$function$;
ALTER FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_process_hand_post_commit_obligations(uuid) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='8d18dde12765610895b25e297a1f403f' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_f06_finish_hand(p_tournament_id uuid, p_lease_generation uuid, p_permit_id uuid, p_outcome text, p_evidence_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'F06_UNKNOWN_PERMIT' USING ERRCODE='22023'; END IF;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,'{}',ARRAY[h.table_id]);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id FOR UPDATE;
 IF h.state<>'reserved' THEN
 IF h.state IS DISTINCT FROM p_outcome OR h.evidence_id IS DISTINCT FROM p_evidence_id THEN RAISE EXCEPTION 'F06_CHANGED_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 ELSE
 IF p_outcome='accepted' THEN
 IF NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number AND c.hand_id=p_evidence_id AND c.post_commit_completed_at IS NOT NULL) THEN
 RAISE EXCEPTION 'F06_HAND_EVIDENCE_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSIF p_outcome='never_started' THEN
 -- Lease must have drained the exact original custody under its held both-map
 -- reservation before claiming this park's new custody receipt. A successor
 -- generation is not evidence that the original dealer never started.
 IF h.generation IS DISTINCT FROM p_lease_generation OR NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
 WHERE o.source_table_id=h.table_id AND o.lifecycle=h.lifecycle AND o.state='park_requested' AND o.custody_id=p_evidence_id
 AND o.custody_generation=p_lease_generation AND o.revision>0)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=p_permit_id) THEN
 RAISE EXCEPTION 'F06_EXACT_QUIESCENT_CUSTODY_REQUIRED' USING ERRCODE='55000'; END IF;
 ELSE RAISE EXCEPTION 'F06_HAND_OUTCOME' USING ERRCODE='22023'; END IF;
 UPDATE smarter_private.f06_hand_permits SET state=p_outcome,evidence_id=p_evidence_id WHERE permit_id=p_permit_id RETURNING * INTO h;
 END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$;
ALTER FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='d5700b1c4e4663c5b9e12915a75d269b' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(p_tournament_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
BEGIN
  IF p_tournament_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_tournament_lease_v2 requires tournament_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'claim_tournament_lease_v2 requires the audited 30-second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY MANAGER KEEPS ITS LEASE (2026-09-10): the takeover waits for
     every in-flight manager transaction (they hold FOR KEY SHARE in the
     PostgREST pre-request hook). The upsert below only takes FOR NO KEY
     UPDATE on its own, which FOR KEY SHARE does not block. */
  PERFORM 1 FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id
   FOR UPDATE;

  IF smarter_private.f06_generation_aborted(p_tournament_id,p_requested_generation) THEN
    RETURN QUERY SELECT false,NULL::text,NULL::numeric,NULL::uuid,2;
    RETURN;
  END IF;

  INSERT INTO public.engine_tournament_leases AS l (
    tournament_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_tournament_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (tournament_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
           l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
         )
      OR (
           l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
         )
      OR (
           l.heartbeat_at < clock_timestamp() - interval '30 seconds'
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id, l.heartbeat_at, l.lease_generation
       INTO v_holder, v_heartbeat, v_generation;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, 2;
    RETURN;
  END IF;

  SELECT l.instance_id, l.heartbeat_at, l.lease_generation
    INTO v_holder, v_heartbeat, v_generation
    FROM public.engine_tournament_leases l
   WHERE l.tournament_id = p_tournament_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           (SELECT l.protocol_version
              FROM public.engine_tournament_leases l
             WHERE l.tournament_id = p_tournament_id);
END;
$function$;
ALTER FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease_v2(uuid,text,text,uuid,integer) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='1d5fdcf284efb107c4f5e2a3be364fb0' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(p_table_id uuid, p_instance_id text, p_version text DEFAULT NULL::text, p_requested_generation uuid DEFAULT NULL::uuid, p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric, lease_generation uuid, protocol_version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_holder text;
  v_heartbeat timestamptz;
  v_generation uuid;
  v_protocol integer;
BEGIN
  IF p_table_id IS NULL
     OR length(btrim(COALESCE(p_instance_id, ''))) = 0
     OR p_requested_generation IS NULL THEN
    RAISE EXCEPTION
      'claim_table_lease_v2 requires table_id, instance_id, and requested_generation'
      USING ERRCODE = '22023';
  END IF;
  IF p_stale_seconds IS DISTINCT FROM public.fn_engine_lease_stale_seconds() THEN
    RAISE EXCEPTION 'claim_table_lease_v2 requires the audited 30 second stale window'
      USING ERRCODE = '22023';
  END IF;

  /* A BUSY TABLE KEEPS ITS LEASE (2026-09-12): the takeover waits for every
     in-flight settlement (they hold FOR KEY SHARE on this row). The upsert
     below only takes FOR NO KEY UPDATE on its own, which FOR KEY SHARE does
     not block - so without this the settlement's lock would exclude nothing.
     This is the cash half of the pair claim_tournament_lease_v2 has had since
     2026-09-10. */
  PERFORM 1 FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id
   FOR UPDATE;

  INSERT INTO public.engine_table_leases AS l (
    table_id,
    instance_id,
    engine_version,
    acquired_at,
    heartbeat_at,
    lease_generation,
    protocol_version
  ) VALUES (
    p_table_id,
    p_instance_id,
    p_version,
    clock_timestamp(),
    clock_timestamp(),
    p_requested_generation,
    2
  )
  ON CONFLICT (table_id) DO UPDATE
     SET instance_id = EXCLUDED.instance_id,
         engine_version = EXCLUDED.engine_version,
         acquired_at = CASE
           WHEN l.protocol_version = 2
            AND l.instance_id = EXCLUDED.instance_id
            AND l.lease_generation = EXCLUDED.lease_generation THEN l.acquired_at
           ELSE clock_timestamp()
         END,
         heartbeat_at = clock_timestamp(),
         lease_generation = EXCLUDED.lease_generation,
         protocol_version = 2
   WHERE (
       l.protocol_version = 2
       AND l.instance_id = EXCLUDED.instance_id
       AND l.lease_generation = EXCLUDED.lease_generation
     )
      OR (
       l.protocol_version < 2
       AND l.instance_id = EXCLUDED.instance_id
     )
      OR (
           l.heartbeat_at < clock_timestamp() - make_interval(
             secs => public.fn_engine_lease_stale_seconds()
           )
       AND l.lease_generation IS DISTINCT FROM EXCLUDED.lease_generation
         )
  RETURNING l.instance_id,
            l.heartbeat_at,
            l.lease_generation,
            l.protocol_version
       INTO v_holder, v_heartbeat, v_generation, v_protocol;

  IF v_holder IS NOT NULL THEN
    RETURN QUERY SELECT true, v_holder, 0::numeric, v_generation, v_protocol;
    RETURN;
  END IF;

  SELECT l.instance_id,
         l.heartbeat_at,
         l.lease_generation,
         l.protocol_version
    INTO v_holder, v_heartbeat, v_generation, v_protocol
    FROM public.engine_table_leases l
   WHERE l.table_id = p_table_id;

  RETURN QUERY
    SELECT false,
           v_holder,
           round(extract(epoch FROM (clock_timestamp() - v_heartbeat))::numeric, 1),
           v_generation,
           v_protocol;
END;
$function$;
ALTER FUNCTION public.claim_table_lease_v2(uuid,text,text,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_table_lease_v2(uuid,text,text,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(uuid,text,text,uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.claim_table_lease_v2(uuid,text,text,uuid,integer) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='2c6a2555d927c8dbbad47b8ac7b60552' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_prefix(t uuid, g uuid, users uuid[], ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE u uuid;
BEGIN
 PERFORM smarter_private.f06_authority(t,g);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM smarter_private.f06_authority(t,g,false);
 FOR u IN SELECT DISTINCT x FROM unnest(users) x ORDER BY x LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)); END LOOP;
 PERFORM 1 FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t AND user_id=ANY(users) ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 PERFORM s.id FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
 WHERE tb.tournament_id=t AND (s.user_id=ANY(users) OR s.table_id=ANY(ids)) ORDER BY s.id FOR UPDATE OF s;
END $function$;
ALTER FUNCTION smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[]) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'::regprocedure AND md5(pg_get_functiondef(oid))='dae9d5b5f71a68362f202dfdf89c8fae' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_generation_aborted(t uuid, g uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'smarter_private'
AS $function$
BEGIN
 -- Existing leases, heartbeats, request admission and resurrection triggers all
 -- use this VOLATILE authority after their row-lock waits.
 RETURN EXISTS(SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts
 WHERE tournament_id=t AND (generation=g OR retired_lease_generation=g))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_generation_aborts WHERE tournament_id=t AND generation=g)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_generations WHERE tournament_id=t AND generation=g);
END $function$;
ALTER FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_generation_aborted(uuid,uuid) TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='3530559a94372866bf3baec006a8fd3c' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_aborted_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'smarter_private'
AS $function$
BEGIN
 IF smarter_private.f06_generation_aborted(NEW.tournament_id,NEW.lease_generation) THEN
 RAISE EXCEPTION 'F06_ABORTED_GENERATION_FENCED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_aborted_generation_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_aborted_generation_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_aborted_generation_guard() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_aborted_generation_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='78bdb7fde133088800446a0da7dddc57' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
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
ALTER FUNCTION public.fn_platform_frozen() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_platform_frozen() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_platform_frozen()'::regprocedure AND md5(pg_get_functiondef(oid))='ec683805e052fceeae74789e82dce4cc' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_serialize_engine_maintenance_break_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* PostgreSQL takes ACCESS EXCLUSIVE before firing a TRUNCATE trigger. Waiting
     for the advisory boundary from there would invert the canonical order
     against an admitted entry that next reads this table. This singleton has
     no legitimate truncate path, so refuse immediately instead of deadlocking. */
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'engine_maintenance_break may not be truncated'
      USING ERRCODE = '0A000';
  END IF;
  /* One exclusive writer boundary. The matching entry paths take this key in
     shared mode, so purchases stay concurrent with each other but can never
     straddle a maintenance-row commit. Transaction scope prevents a pooled
     connection from retaining the lock. */
  PERFORM pg_advisory_xact_lock(530090, 1);
  RETURN NULL;
END;
$function$;
ALTER FUNCTION public.fn_serialize_engine_maintenance_break_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_serialize_engine_maintenance_break_write() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_serialize_engine_maintenance_break_write() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure AND md5(pg_get_functiondef(oid))='6d62a5f9ad5e8fa615e3eac9396266a3' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$;
ALTER FUNCTION public.fn_active_maintenance_release_boundary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_active_maintenance_release_boundary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_active_maintenance_release_boundary()'::regprocedure AND md5(pg_get_functiondef(oid))='0d9548e27105b7172d83be4f7d10ea47' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE t uuid;
BEGIN
 -- Resolve the table even before BEGIN is visible; an absent permit cannot
 -- let an already-started writer cross cancellation's exclusive lane.
 SELECT tournament_id INTO t FROM public.tables WHERE id=NEW.table_id;
 IF t IS NOT NULL THEN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
 OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
 RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_prepared_hand_cancellations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations
 WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number) THEN
 RAISE EXCEPTION 'F06_CANCELLED_PREPARATION_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_cancelled_preparation_writer_guard() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='a7467e2cb64bab202a359eed42432299' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_immutable_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'F06_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(OLD)->>'state')='withdrawn_before_manifest' THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND (to_jsonb(NEW)->>'state')='aborted_unsettled' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid
 AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'evidence_id')::uuid AND a.permit_id=(to_jsonb(NEW)->>'permit_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'generation')::uuid AND a.hand_number=(to_jsonb(NEW)->>'hand_number')::bigint) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_operations' AND (to_jsonb(NEW)->>'state')='withdrawn_before_manifest' AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_unsettled_hand_aborts a WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_generation_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_mixed_abort_hands a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.generation=(to_jsonb(NEW)->>'origin_generation')::uuid) AND NOT EXISTS(
 SELECT 1 FROM smarter_private.f06_no_start_continuations a
 WHERE a.receipt_id=(to_jsonb(NEW)->>'abort_receipt_id')::uuid
 AND a.break_id=(to_jsonb(NEW)->>'break_id')::uuid
 AND a.tournament_id=(to_jsonb(NEW)->>'tournament_id')::uuid
 AND a.table_id=(to_jsonb(NEW)->>'source_table_id')::uuid
 AND a.original_generation=(to_jsonb(NEW)->>'origin_generation')::uuid
 AND a.park=(to_jsonb(OLD))
 AND (to_jsonb(NEW)-'state'-'abort_receipt_id')=(to_jsonb(OLD)-'state'-'abort_receipt_id')) THEN
 RAISE EXCEPTION 'F06_ABORT_RECEIPT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_hand_permits' AND ((to_jsonb(OLD)-'state'-'evidence_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'evidence_id') OR to_jsonb(OLD)->>'state'<>'reserved') THEN
 RAISE EXCEPTION 'F06_HAND_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='f06_members' OR
 (TG_TABLE_NAME='f06_attempts' AND ((to_jsonb(OLD)-'state'-'receipt') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'receipt') OR to_jsonb(OLD)->>'state'<>'active')) OR
 (TG_TABLE_NAME='f06_operations' AND ((to_jsonb(OLD)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') IS DISTINCT FROM (to_jsonb(NEW)-'state'-'manifest'-'revision'-'custody_id'-'custody_generation'-'cleanup_kind'-'close_receipt'-'abort_receipt_id') OR (to_jsonb(OLD)->'manifest'<>'null'::jsonb AND to_jsonb(OLD)->'manifest' IS DISTINCT FROM to_jsonb(NEW)->'manifest') OR (to_jsonb(OLD)->'close_receipt'<>'null'::jsonb AND to_jsonb(OLD)->'close_receipt' IS DISTINCT FROM to_jsonb(NEW)->'close_receipt'))) THEN
 RAISE EXCEPTION 'F06_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION smarter_private.f06_immutable_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_immutable_identity() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_immutable_identity() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure AND md5(pg_get_functiondef(oid))='0fe40a0711ef6d196c6883d3b9e8b86f' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_no_start_continuation_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'F06_CONTINUATION_IMMUTABLE' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION smarter_private.f06_no_start_continuation_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_no_start_continuation_immutable() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION smarter_private.f06_no_start_continuation_immutable() TO postgres;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_no_start_continuation_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='2c87da2a00030dcc36ecb62bf51b2a89' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
  v_caller   text := COALESCE(auth.role(), '');
BEGIN
  /* ZERO-DRIFT (2026-08-31): the wager figure is engine truth. Only the
     engine (service_role) or trusted admin context may apply playthrough -
     an authenticated user could previously release ANY member's locked promo
     by claiming an arbitrary wager. Fail closed. */
  IF NOT (v_caller = 'service_role'
          OR (v_caller = '' AND current_user IN ('postgres', 'supabase_admin'))) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'engine_only');
  END IF;

  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  BEGIN
    INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
    VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
    ON CONFLICT (user_id, club_id) DO UPDATE
       SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
           updated_at   = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    /* Exact release - the old v_promo::integer truncated fractions into
       nothing while promo_balance was zeroed in full. */
    v_released := round(v_promo, 2);

    PERFORM set_config('app.ledger_category', 'promo_release', true);
    PERFORM set_config('app.ledger_counterparty', 'promo_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_user_id::text, true);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_released,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '0', true);

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;
ALTER FUNCTION public.promo_apply_playthrough(uuid,uuid,numeric) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.promo_apply_playthrough(uuid,uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.promo_apply_playthrough(uuid,uuid,numeric) TO postgres;
GRANT EXECUTE ON FUNCTION public.promo_apply_playthrough(uuid,uuid,numeric) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.promo_apply_playthrough(uuid,uuid,numeric)'::regprocedure AND md5(pg_get_functiondef(oid))='ee9bcdf31b5f212b67e0ff536033f20c' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE TRIGGER f06_aborted_generation AFTER INSERT OR UPDATE ON public.engine_tournament_leases FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_aborted_generation_guard();
CREATE TRIGGER f06_abort_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_unsettled_hand_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_unsettled_hand_aborts'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_unsettled_hand_aborts","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"permit_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"break_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"expected","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"outcome","type":"text","default":"''aborted_unsettled''::text","notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""},{"name":"retired_lease_generation","type":"uuid","default":null,"notnull":false,"identity":"","generated":""}],"indexes":[{"name":"f06_abort_retired_lease_generation","constraint":false,"definition":"CREATE UNIQUE INDEX f06_abort_retired_lease_generation ON smarter_private.f06_unsettled_hand_aborts USING btree (tournament_id, retired_lease_generation) WHERE (retired_lease_generation IS NOT NULL)"},{"name":"f06_unsettled_hand_aborts_break_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_unsettled_hand_aborts_break_id_key ON smarter_private.f06_unsettled_hand_aborts USING btree (break_id)"},{"name":"f06_unsettled_hand_aborts_permit_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_unsettled_hand_aborts_permit_id_key ON smarter_private.f06_unsettled_hand_aborts USING btree (permit_id)"},{"name":"f06_unsettled_hand_aborts_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_unsettled_hand_aborts_pkey ON smarter_private.f06_unsettled_hand_aborts USING btree (receipt_id)"},{"name":"f06_unsettled_hand_aborts_table_id_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_unsettled_hand_aborts_table_id_hand_number_key ON smarter_private.f06_unsettled_hand_aborts USING btree (table_id, hand_number)"},{"name":"f06_unsettled_hand_aborts_tournament_id_generation_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_unsettled_hand_aborts_tournament_id_generation_key ON smarter_private.f06_unsettled_hand_aborts USING btree (tournament_id, generation)"}],"policies":null,"triggers":[{"name":"f06_abort_receipt_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_abort_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_unsettled_hand_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_abort_successor_distinct","type":"c","validated":true,"definition":"CHECK (((retired_lease_generation IS NULL) OR (retired_lease_generation <> generation)))"},{"name":"f06_unsettled_hand_aborts_break_id_key","type":"u","validated":true,"definition":"UNIQUE (break_id)"},{"name":"f06_unsettled_hand_aborts_outcome_check","type":"c","validated":true,"definition":"CHECK ((outcome = ''aborted_unsettled''::text))"},{"name":"f06_unsettled_hand_aborts_permit_id_key","type":"u","validated":true,"definition":"UNIQUE (permit_id)"},{"name":"f06_unsettled_hand_aborts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (receipt_id)"},{"name":"f06_unsettled_hand_aborts_table_id_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (table_id, hand_number)"},{"name":"f06_unsettled_hand_aborts_tournament_id_generation_key","type":"u","validated":true,"definition":"UNIQUE (tournament_id, generation)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_unsettled_hand_aborts' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE TRIGGER f06_generation_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_generation_aborts'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_generation_aborts","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"expected","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"outcome","type":"text","default":"''aborted_unsettled''::text","notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_generation_aborts_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_aborts_pkey ON smarter_private.f06_generation_aborts USING btree (receipt_id)"},{"name":"f06_generation_aborts_receipt_id_tournament_id_generation_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_aborts_receipt_id_tournament_id_generation_key ON smarter_private.f06_generation_aborts USING btree (receipt_id, tournament_id, generation)"},{"name":"f06_generation_aborts_tournament_id_generation_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_aborts_tournament_id_generation_key ON smarter_private.f06_generation_aborts USING btree (tournament_id, generation)"}],"policies":null,"triggers":[{"name":"f06_generation_receipt_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_generation_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_generation_aborts_outcome_check","type":"c","validated":true,"definition":"CHECK ((outcome = ''aborted_unsettled''::text))"},{"name":"f06_generation_aborts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (receipt_id)"},{"name":"f06_generation_aborts_receipt_id_tournament_id_generation_key","type":"u","validated":true,"definition":"UNIQUE (receipt_id, tournament_id, generation)"},{"name":"f06_generation_aborts_tournament_id_generation_key","type":"u","validated":true,"definition":"UNIQUE (tournament_id, generation)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_generation_aborts' USING DETAIL=actual::text; END IF; END $exact_table$;
ALTER TABLE smarter_private.f06_generation_abort_hands ADD CONSTRAINT f06_generation_abort_hands_receipt_id_tournament_id_genera_fkey FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_generation_aborts(receipt_id, tournament_id, generation);
CREATE TRIGGER f06_generation_child_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_generation_abort_hands'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_generation_abort_hands","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"permit_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"snapshot_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"break_id","type":"uuid","default":null,"notnull":false,"identity":"","generated":""},{"name":"expected","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_generation_abort_hands_break_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_abort_hands_break_id_key ON smarter_private.f06_generation_abort_hands USING btree (break_id)"},{"name":"f06_generation_abort_hands_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_abort_hands_pkey ON smarter_private.f06_generation_abort_hands USING btree (permit_id)"},{"name":"f06_generation_abort_hands_table_id_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_generation_abort_hands_table_id_hand_number_key ON smarter_private.f06_generation_abort_hands USING btree (table_id, hand_number)"}],"policies":null,"triggers":[{"name":"f06_generation_child_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_generation_child_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_generation_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_generation_abort_hands_break_id_key","type":"u","validated":true,"definition":"UNIQUE (break_id)"},{"name":"f06_generation_abort_hands_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (permit_id)"},{"name":"f06_generation_abort_hands_receipt_id_tournament_id_genera_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_generation_aborts(receipt_id, tournament_id, generation)"},{"name":"f06_generation_abort_hands_table_id_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (table_id, hand_number)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_generation_abort_hands' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE TRIGGER f06_mixed_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_mixed_aborts'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_mixed_aborts","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"expected","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"outcome","type":"text","default":"''aborted_unsettled''::text","notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_mixed_aborts_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_aborts_pkey ON smarter_private.f06_mixed_aborts USING btree (receipt_id)"},{"name":"f06_mixed_aborts_receipt_id_tournament_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_aborts_receipt_id_tournament_id_key ON smarter_private.f06_mixed_aborts USING btree (receipt_id, tournament_id)"}],"policies":null,"triggers":[{"name":"f06_mixed_receipt_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_mixed_receipt_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_aborts FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_mixed_aborts_outcome_check","type":"c","validated":true,"definition":"CHECK ((outcome = ''aborted_unsettled''::text))"},{"name":"f06_mixed_aborts_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (receipt_id)"},{"name":"f06_mixed_aborts_receipt_id_tournament_id_key","type":"u","validated":true,"definition":"UNIQUE (receipt_id, tournament_id)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_mixed_aborts' USING DETAIL=actual::text; END IF; END $exact_table$;
ALTER TABLE smarter_private.f06_mixed_abort_generations ADD CONSTRAINT f06_mixed_abort_generations_receipt_id_tournament_id_fkey FOREIGN KEY (receipt_id, tournament_id) REFERENCES smarter_private.f06_mixed_aborts(receipt_id, tournament_id);
CREATE TRIGGER f06_mixed_generations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_generations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_mixed_abort_generations'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_mixed_abort_generations","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_mixed_abort_generations_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_abort_generations_pkey ON smarter_private.f06_mixed_abort_generations USING btree (tournament_id, generation)"},{"name":"f06_mixed_abort_generations_receipt_id_tournament_id_genera_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_abort_generations_receipt_id_tournament_id_genera_key ON smarter_private.f06_mixed_abort_generations USING btree (receipt_id, tournament_id, generation)"}],"policies":null,"triggers":[{"name":"f06_mixed_generations_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_mixed_generations_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_generations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_mixed_abort_generations_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (tournament_id, generation)"},{"name":"f06_mixed_abort_generations_receipt_id_tournament_id_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (receipt_id, tournament_id) REFERENCES smarter_private.f06_mixed_aborts(receipt_id, tournament_id)"},{"name":"f06_mixed_abort_generations_receipt_id_tournament_id_genera_key","type":"u","validated":true,"definition":"UNIQUE (receipt_id, tournament_id, generation)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_mixed_abort_generations' USING DETAIL=actual::text; END IF; END $exact_table$;
ALTER TABLE smarter_private.f06_mixed_abort_hands ADD CONSTRAINT f06_mixed_abort_hands_receipt_id_tournament_id_generation_fkey FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_mixed_abort_generations(receipt_id, tournament_id, generation);
CREATE TRIGGER f06_mixed_hands_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_mixed_abort_hands'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_mixed_abort_hands","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"permit_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"receipt_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"snapshot_id","type":"uuid","default":null,"notnull":false,"identity":"","generated":""},{"name":"break_id","type":"uuid","default":null,"notnull":false,"identity":"","generated":""},{"name":"prior_hand_id","type":"uuid","default":null,"notnull":false,"identity":"","generated":""},{"name":"prior_abort_receipt_id","type":"uuid","default":null,"notnull":false,"identity":"","generated":""},{"name":"expected","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_mixed_abort_hands_break_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_abort_hands_break_id_key ON smarter_private.f06_mixed_abort_hands USING btree (break_id)"},{"name":"f06_mixed_abort_hands_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_abort_hands_pkey ON smarter_private.f06_mixed_abort_hands USING btree (permit_id)"},{"name":"f06_mixed_abort_hands_table_id_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_mixed_abort_hands_table_id_hand_number_key ON smarter_private.f06_mixed_abort_hands USING btree (table_id, hand_number)"}],"policies":null,"triggers":[{"name":"f06_mixed_hands_immutable","enabled":"O","function":"smarter_private.f06_abort_receipt_immutable()","definition":"CREATE TRIGGER f06_mixed_hands_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_mixed_abort_hands FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_abort_receipt_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_mixed_abort_hands_break_id_key","type":"u","validated":true,"definition":"UNIQUE (break_id)"},{"name":"f06_mixed_abort_hands_check","type":"c","validated":true,"definition":"CHECK ((((((snapshot_id IS NOT NULL))::integer + ((prior_hand_id IS NOT NULL))::integer) + ((prior_abort_receipt_id IS NOT NULL))::integer) = 1))"},{"name":"f06_mixed_abort_hands_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (permit_id)"},{"name":"f06_mixed_abort_hands_receipt_id_tournament_id_generation_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (receipt_id, tournament_id, generation) REFERENCES smarter_private.f06_mixed_abort_generations(receipt_id, tournament_id, generation)"},{"name":"f06_mixed_abort_hands_table_id_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (table_id, hand_number)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_mixed_abort_hands' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE TRIGGER f06_prepared_cancellation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_prepared_hand_cancellations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_prepared_cancellation_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_prepared_hand_cancellations'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_prepared_hand_cancellations","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"permit_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"lifecycle","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"custody_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_prepared_hand_cancellations_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_prepared_hand_cancellations_pkey ON smarter_private.f06_prepared_hand_cancellations USING btree (permit_id)"},{"name":"f06_prepared_hand_cancellations_table_id_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_prepared_hand_cancellations_table_id_hand_number_key ON smarter_private.f06_prepared_hand_cancellations USING btree (table_id, hand_number)"}],"policies":null,"triggers":[{"name":"f06_prepared_cancellation_immutable","enabled":"O","function":"smarter_private.f06_prepared_cancellation_immutable()","definition":"CREATE TRIGGER f06_prepared_cancellation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_prepared_hand_cancellations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_prepared_cancellation_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_prepared_hand_cancellations_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (permit_id)"},{"name":"f06_prepared_hand_cancellations_table_id_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (table_id, hand_number)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_prepared_hand_cancellations' USING DETAIL=actual::text; END IF; END $exact_table$;
ALTER TABLE public.hand_state_snapshots ADD CONSTRAINT hand_state_snapshots_table_id_fkey FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE;
CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='public.hand_state_snapshots'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"hand_state_snapshots","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"id","type":"uuid","default":"gen_random_uuid()","notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"integer","default":null,"notnull":true,"identity":"","generated":""},{"name":"state_json","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"config_json","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"dealer_seat","type":"integer","default":null,"notnull":true,"identity":"","generated":""},{"name":"players_json","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"stage","type":"text","default":"''preflop''::text","notnull":true,"identity":"","generated":""},{"name":"is_complete","type":"boolean","default":"false","notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"now()","notnull":true,"identity":"","generated":""},{"name":"updated_at","type":"timestamp with time zone","default":"now()","notnull":true,"identity":"","generated":""},{"name":"pending_deadlines","type":"jsonb","default":"''[]''::jsonb","notnull":true,"identity":"","generated":""},{"name":"disconnect_states","type":"jsonb","default":"''{}''::jsonb","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"hand_state_snapshots_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX hand_state_snapshots_pkey ON public.hand_state_snapshots USING btree (id)"},{"name":"idx_hand_snapshots_one_active_per_table","constraint":false,"definition":"CREATE UNIQUE INDEX idx_hand_snapshots_one_active_per_table ON public.hand_state_snapshots USING btree (table_id) WHERE (is_complete = false)"},{"name":"idx_hand_state_snapshots_created_at","constraint":false,"definition":"CREATE INDEX idx_hand_state_snapshots_created_at ON public.hand_state_snapshots USING btree (created_at DESC)"}],"policies":[{"name":"hand_state_snapshots_service_only","qual":"true","check":"true","roles":["service_role"],"command":"*","permissive":true}],"triggers":[{"name":"a00_f06_cancelled_preparation","enabled":"O","function":"smarter_private.f06_cancelled_preparation_writer_guard()","definition":"CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()"}],"force_rls":true,"constraints":[{"name":"hand_state_snapshots_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"hand_state_snapshots_table_id_fkey","type":"f","validated":true,"definition":"FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','hand_state_snapshots' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE TRIGGER a0_finish_hand_post_commit_obligations BEFORE DELETE ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_finish_hand_post_commit_obligations();
CREATE TRIGGER z9_notify_hand_projection_outbox AFTER INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_notify_hand_projection_outbox();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='public.hand_projection_outbox'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"hand_projection_outbox","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"SELECT"}],"columns":[{"name":"hand_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"hand_projection_outbox_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX hand_projection_outbox_hand_number_key ON public.hand_projection_outbox USING btree (hand_number)"},{"name":"hand_projection_outbox_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX hand_projection_outbox_pkey ON public.hand_projection_outbox USING btree (hand_id)"},{"name":"idx_hand_projection_outbox_table_hand","constraint":false,"definition":"CREATE INDEX idx_hand_projection_outbox_table_hand ON public.hand_projection_outbox USING btree (table_id, hand_number)"}],"policies":null,"triggers":[{"name":"a0_finish_hand_post_commit_obligations","enabled":"O","function":"trg_finish_hand_post_commit_obligations()","definition":"CREATE TRIGGER a0_finish_hand_post_commit_obligations BEFORE DELETE ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_finish_hand_post_commit_obligations()"},{"name":"z9_notify_hand_projection_outbox","enabled":"O","function":"trg_notify_hand_projection_outbox()","definition":"CREATE TRIGGER z9_notify_hand_projection_outbox AFTER INSERT ON public.hand_projection_outbox FOR EACH ROW EXECUTE FUNCTION trg_notify_hand_projection_outbox()"}],"force_rls":false,"constraints":[{"name":"hand_projection_outbox_hand_number_check","type":"c","validated":true,"definition":"CHECK ((hand_number >= 1000000))"},{"name":"hand_projection_outbox_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (hand_number)"},{"name":"hand_projection_outbox_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (hand_id)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','hand_projection_outbox' USING DETAIL=actual::text; END IF; END $exact_table$;
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='public.table_pending_addons'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"table_pending_addons","owner":"postgres","grants":[{"role":"anon","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"anon","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"anon","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"id","type":"uuid","default":"gen_random_uuid()","notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"user_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"amount","type":"numeric","default":null,"notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"now()","notnull":true,"identity":"","generated":""},{"name":"resolved_at","type":"timestamp with time zone","default":null,"notnull":false,"identity":"","generated":""},{"name":"applied_to_stack","type":"numeric","default":null,"notnull":false,"identity":"","generated":""},{"name":"refunded","type":"numeric","default":null,"notnull":false,"identity":"","generated":""},{"name":"kind","type":"text","default":"''addon''::text","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"idx_table_pending_addons_unresolved_all","constraint":false,"definition":"CREATE INDEX idx_table_pending_addons_unresolved_all ON public.table_pending_addons USING btree (created_at) WHERE (resolved_at IS NULL)"},{"name":"table_pending_addons_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX table_pending_addons_pkey ON public.table_pending_addons USING btree (id)"}],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"table_pending_addons_amount_check","type":"c","validated":true,"definition":"CHECK ((amount > (0)::numeric))"},{"name":"table_pending_addons_amount_is_cents","type":"c","validated":false,"definition":"CHECK (((amount IS NULL) OR (((amount)::text <> ALL (ARRAY[''NaN''::text, ''Infinity''::text, ''-Infinity''::text])) AND (amount = round(amount, 2))))) NOT VALID"},{"name":"table_pending_addons_applied_is_cents","type":"c","validated":false,"definition":"CHECK (((applied_to_stack IS NULL) OR (((applied_to_stack)::text <> ALL (ARRAY[''NaN''::text, ''Infinity''::text, ''-Infinity''::text])) AND (applied_to_stack = round(applied_to_stack, 2))))) NOT VALID"},{"name":"table_pending_addons_kind_check","type":"c","validated":true,"definition":"CHECK ((kind = ANY (ARRAY[''addon''::text, ''rebuy''::text])))"},{"name":"table_pending_addons_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (id)"},{"name":"table_pending_addons_refunded_is_cents","type":"c","validated":false,"definition":"CHECK (((refunded IS NULL) OR (((refunded)::text <> ALL (ARRAY[''NaN''::text, ''Infinity''::text, ''-Infinity''::text])) AND (refunded = round(refunded, 2))))) NOT VALID"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','table_pending_addons' USING DETAIL=actual::text; END IF; END $exact_table$;
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='public.engine_table_leases'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"engine_table_leases","owner":"postgres","grants":[{"role":"anon","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"anon","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"anon","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"authenticated","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"service_role","grantor":"postgres","grantable":false,"privilege":"TRIGGER"}],"columns":[{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"instance_id","type":"text","default":null,"notnull":true,"identity":"","generated":""},{"name":"engine_version","type":"text","default":null,"notnull":false,"identity":"","generated":""},{"name":"acquired_at","type":"timestamp with time zone","default":"now()","notnull":true,"identity":"","generated":""},{"name":"heartbeat_at","type":"timestamp with time zone","default":"now()","notnull":true,"identity":"","generated":""},{"name":"lease_generation","type":"uuid","default":"gen_random_uuid()","notnull":true,"identity":"","generated":""},{"name":"protocol_version","type":"integer","default":"1","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"engine_table_leases_instance_idx","constraint":false,"definition":"CREATE INDEX engine_table_leases_instance_idx ON public.engine_table_leases USING btree (instance_id)"},{"name":"engine_table_leases_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX engine_table_leases_pkey ON public.engine_table_leases USING btree (table_id)"}],"policies":null,"triggers":null,"force_rls":false,"constraints":[{"name":"engine_table_leases_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (table_id)"},{"name":"engine_table_leases_protocol_version_check","type":"c","validated":true,"definition":"CHECK ((protocol_version = ANY (ARRAY[1, 2])))"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','engine_table_leases' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE TRIGGER f06_no_start_continuation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_no_start_continuations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
CREATE TRIGGER f06_no_start_continuation_no_truncate BEFORE TRUNCATE ON smarter_private.f06_no_start_continuations FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable();
DO $exact_table$ DECLARE actual jsonb; BEGIN SELECT jsonb_build_object(
      'name',c.relname,'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('name',x.conname,'type',x.contype,'validated',x.convalidated,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname) FROM pg_constraint x WHERE x.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'constraint',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.conindid=i.indexrelid),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
      'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'command',p.polcmd,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'grants',(SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
      INTO actual FROM pg_class c WHERE c.oid='smarter_private.f06_no_start_continuations'::regclass; IF actual IS DISTINCT FROM '{"rls":true,"name":"f06_no_start_continuations","owner":"postgres","grants":[{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"DELETE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"INSERT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"MAINTAIN"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"REFERENCES"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"SELECT"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRIGGER"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"TRUNCATE"},{"role":"postgres","grantor":"postgres","grantable":false,"privilege":"UPDATE"}],"columns":[{"name":"receipt_id","type":"uuid","default":"gen_random_uuid()","notnull":true,"identity":"","generated":""},{"name":"break_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"permit_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"tournament_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"table_id","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"lifecycle","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"hand_number","type":"bigint","default":null,"notnull":true,"identity":"","generated":""},{"name":"original_generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"current_generation","type":"uuid","default":null,"notnull":true,"identity":"","generated":""},{"name":"park","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"permit","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"roster","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"prior_committed","type":"jsonb","default":null,"notnull":true,"identity":"","generated":""},{"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","notnull":true,"identity":"","generated":""}],"indexes":[{"name":"f06_no_start_continuations_break_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_no_start_continuations_break_id_key ON smarter_private.f06_no_start_continuations USING btree (break_id)"},{"name":"f06_no_start_continuations_permit_id_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_no_start_continuations_permit_id_key ON smarter_private.f06_no_start_continuations USING btree (permit_id)"},{"name":"f06_no_start_continuations_pkey","constraint":true,"definition":"CREATE UNIQUE INDEX f06_no_start_continuations_pkey ON smarter_private.f06_no_start_continuations USING btree (receipt_id)"},{"name":"f06_no_start_continuations_table_id_hand_number_key","constraint":true,"definition":"CREATE UNIQUE INDEX f06_no_start_continuations_table_id_hand_number_key ON smarter_private.f06_no_start_continuations USING btree (table_id, hand_number)"}],"policies":null,"triggers":[{"name":"f06_no_start_continuation_immutable","enabled":"O","function":"smarter_private.f06_no_start_continuation_immutable()","definition":"CREATE TRIGGER f06_no_start_continuation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_no_start_continuations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable()"},{"name":"f06_no_start_continuation_no_truncate","enabled":"O","function":"smarter_private.f06_no_start_continuation_immutable()","definition":"CREATE TRIGGER f06_no_start_continuation_no_truncate BEFORE TRUNCATE ON smarter_private.f06_no_start_continuations FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable()"}],"force_rls":false,"constraints":[{"name":"f06_no_start_continuations_break_id_key","type":"u","validated":true,"definition":"UNIQUE (break_id)"},{"name":"f06_no_start_continuations_permit_id_key","type":"u","validated":true,"definition":"UNIQUE (permit_id)"},{"name":"f06_no_start_continuations_pkey","type":"p","validated":true,"definition":"PRIMARY KEY (receipt_id)"},{"name":"f06_no_start_continuations_table_id_hand_number_key","type":"u","validated":true,"definition":"UNIQUE (table_id, hand_number)"}]}'::jsonb THEN RAISE EXCEPTION 'captured table differs: %','f06_no_start_continuations' USING DETAIL=actual::text; END IF; END $exact_table$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_balance_columns()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT array_agg(DISTINCT c)
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;
$function$;
ALTER FUNCTION public.fn_ca_money_rpc_balance_columns() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_balance_columns() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_balance_columns() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_balance_columns() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_money_rpc_balance_columns()'::regprocedure AND md5(pg_get_functiondef(oid))='53e86c9945bde2a5830232f59a365fdd' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_registry_guard()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  obj record;
  v_name text;
  v_src  text;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type <> 'function' OR obj.schema_name IS DISTINCT FROM 'public' THEN
      CONTINUE;
    END IF;

    SELECT p.proname, p.prosrc INTO v_name, v_src
      FROM pg_proc p WHERE p.oid = obj.objid AND p.prokind = 'f';
    IF v_name IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT public.fn_ca_money_rpc_writes_balances(v_src) THEN
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v_name) THEN
      CONTINUE;
    END IF;

    RAISE EXCEPTION
      'REFUSED: % writes balance columns and is not in ca_money_rpc_registry', v_name
      USING ERRCODE = '42501',
            DETAIL  = 'A function that can move money is registered before it exists, not after. '
                   || 'This is the guard for the seven drift incidents of 2026-09-11.',
            HINT    = 'Put the registry row ABOVE the CREATE FUNCTION in this same migration: '
                   || 'INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES ('
                   || quote_literal(v_name)
                   || ', ''approved'', ''what it moves, what gates it, how it is journaled'');  '
                   || 'Use status ''system'' if it moves no money and only reads or locks.';
  END LOOP;
END;
$function$;
ALTER FUNCTION public.fn_ca_money_rpc_registry_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_registry_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_registry_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_registry_guard() TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_money_rpc_registry_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='03928ac3da782be33306c2e07b0b8977' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$function$;
ALTER FUNCTION public.fn_ca_money_rpc_writes_balances(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_writes_balances(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_writes_balances(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_writes_balances(text) TO service_role;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_money_rpc_writes_balances(text)'::regprocedure AND md5(pg_get_functiondef(oid))='1b13d12e02c7f7b719fcfae4153dcb1f' AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'hand current capture differs'; END IF; END $$;
CREATE EVENT TRIGGER ab_ca_money_rpc_registered ON ddl_command_end WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.fn_ca_money_rpc_registry_guard();
COMMIT;
