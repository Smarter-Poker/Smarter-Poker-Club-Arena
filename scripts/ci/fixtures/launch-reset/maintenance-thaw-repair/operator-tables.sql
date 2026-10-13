CREATE TABLE public.ca_engine_operator_commands (
    id uuid NOT NULL,
    actor_id uuid NOT NULL,
    domain text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    announced_at timestamp with time zone,
    result jsonb,
    end_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ca_engine_operator_commands_domain_check CHECK ((domain = ANY (ARRAY['floor'::text, 'maintenance'::text]))),
    CONSTRAINT ca_engine_operator_commands_reason_check CHECK (((length(reason) >= 10) AND (length(reason) <= 500)))
);
CREATE TABLE public.ca_operator_floor_hold (
    id boolean DEFAULT true NOT NULL,
    operation_id uuid NOT NULL,
    mode text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT ca_operator_floor_hold_id_check CHECK (id),
    CONSTRAINT ca_operator_floor_hold_mode_check CHECK ((mode = ANY (ARRAY['pause'::text, 'park'::text])))
);
CREATE TABLE public.ca_operator_table_closes (
    table_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT ca_operator_table_closes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'closed'::text])))
);
CREATE TABLE public.ca_launch_operator_scopes(operation_id uuid PRIMARY KEY,actor_id uuid NOT NULL,club_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());