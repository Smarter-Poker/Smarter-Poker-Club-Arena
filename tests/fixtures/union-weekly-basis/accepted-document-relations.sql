-- Exact accepted37 missing relation definitions; no controlled money.
CREATE TABLE public.operational_alert_events (
    id bigint NOT NULL,
    source text NOT NULL,
    event_key text NOT NULL,
    alertname text NOT NULL,
    status text NOT NULL,
    severity text NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_received_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    delivery_count bigint DEFAULT 1 NOT NULL,
    investigation_status text DEFAULT 'new'::text NOT NULL,
    investigation jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT operational_alert_events_alertname_check CHECK (((length(alertname) >= 1) AND (length(alertname) <= 240))),
    CONSTRAINT operational_alert_events_event_key_check CHECK (((length(event_key) >= 1) AND (length(event_key) <= 512))),
    CONSTRAINT operational_alert_events_investigation_status_check CHECK ((investigation_status = ANY (ARRAY['new'::text, 'investigating'::text, 'blocked'::text, 'verified_fixed'::text, 'historical'::text, 'test'::text]))),
    CONSTRAINT operational_alert_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 262144))),
    CONSTRAINT operational_alert_events_severity_check CHECK (((length(severity) >= 1) AND (length(severity) <= 40))),
    CONSTRAINT operational_alert_events_source_check CHECK (((length(source) >= 1) AND (length(source) <= 120))),
    CONSTRAINT operational_alert_events_status_check CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text, 'info'::text])))
);
CREATE TABLE public.engine_alerts (
    id bigint DEFAULT nextval('public.engine_alerts_id_seq'::regclass) NOT NULL,
    fingerprint text NOT NULL,
    alertname text NOT NULL,
    severity text DEFAULT 'unknown'::text NOT NULL,
    component text,
    status text DEFAULT 'firing'::text NOT NULL,
    summary text,
    description text,
    labels jsonb DEFAULT '{}'::jsonb NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_via text[] DEFAULT '{}'::text[] NOT NULL
);
CREATE TABLE public.accounting_correction_documents (
    id uuid NOT NULL,
    contract_version smallint NOT NULL,
    source_ledger_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    club_id uuid NOT NULL,
    union_id uuid,
    source_club_id uuid,
    source_union_id uuid,
    source_row jsonb NOT NULL,
    amount numeric NOT NULL,
    issuer_type text NOT NULL,
    issuer_id uuid NOT NULL,
    payee_type text NOT NULL,
    payee_id uuid NOT NULL,
    issuer_representative_id uuid NOT NULL,
    issuer_name text NOT NULL,
    payee_name text NOT NULL,
    audience_user_ids uuid[] NOT NULL,
    incident_id uuid,
    write_failure_id bigint,
    recorded_at timestamp with time zone NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_correction_documents_amount_check CHECK (((amount > (0)::numeric) AND (amount <= 9999999999.99) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount = round(amount, 2)))),
    CONSTRAINT accounting_correction_documents_check CHECK (((incident_id IS NOT NULL) OR (write_failure_id IS NOT NULL))),
    CONSTRAINT accounting_correction_documents_check1 CHECK ((isfinite(recorded_at) AND isfinite(issued_at) AND (issued_at >= recorded_at) AND (cardinality(audience_user_ids) >= 1))),
    CONSTRAINT accounting_correction_documents_contract_version_check CHECK ((contract_version = 1)),
    CONSTRAINT accounting_correction_documents_issuer_type_check CHECK ((issuer_type = ANY (ARRAY['club'::text, 'union'::text, 'agent'::text, 'player'::text]))),
    CONSTRAINT accounting_correction_documents_payee_type_check CHECK ((payee_type = ANY (ARRAY['club'::text, 'union'::text, 'agent'::text, 'player'::text])))
);
CREATE TABLE public.accounting_cashier_events (
    id uuid NOT NULL,
    contract_version smallint NOT NULL,
    cashout_id uuid NOT NULL,
    escrow_id uuid NOT NULL,
    source_transaction_id uuid NOT NULL,
    source_ledger_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    event_slot text NOT NULL,
    event_kind text NOT NULL,
    hold_event_id uuid,
    hold_invoice_id uuid,
    club_id uuid NOT NULL,
    player_id uuid NOT NULL,
    assigned_agent_id uuid NOT NULL,
    actor_user_id uuid,
    actor_role text NOT NULL,
    ledger_actor_user_id uuid NOT NULL,
    issuer_representative_id uuid NOT NULL,
    issuer_name text NOT NULL,
    player_name text NOT NULL,
    audience_user_ids uuid[] NOT NULL,
    op_id uuid NOT NULL,
    operation_fingerprint jsonb NOT NULL,
    accepted_note text,
    transaction_note text NOT NULL,
    amount numeric(15,2) NOT NULL,
    ledger_from_type text NOT NULL,
    ledger_from_entity_id uuid NOT NULL,
    ledger_to_type text NOT NULL,
    ledger_to_entity_id uuid NOT NULL,
    wallet_owner_id uuid NOT NULL,
    wallet_before numeric NOT NULL,
    wallet_after numeric NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_cashier_events_actor_role_check CHECK ((actor_role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text, 'agent'::text, 'sub_agent'::text, 'player'::text, 'member'::text, 'system'::text]))),
    CONSTRAINT accounting_cashier_events_amount_check CHECK (((amount > (0)::numeric) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))),
    CONSTRAINT accounting_cashier_events_check CHECK ((((event_kind = 'hold'::text) AND (event_slot = 'hold'::text) AND (hold_event_id IS NULL) AND (hold_invoice_id IS NULL)) OR ((event_kind <> 'hold'::text) AND (event_slot = 'terminal'::text) AND (hold_event_id IS NOT NULL) AND (hold_invoice_id IS NOT NULL)))),
    CONSTRAINT accounting_cashier_events_check1 CHECK ((((event_kind = 'expiry_refund'::text) AND (actor_user_id IS NULL) AND (actor_role = 'system'::text)) OR ((event_kind <> 'expiry_refund'::text) AND (actor_user_id IS NOT NULL) AND (actor_role <> 'system'::text)))),
    CONSTRAINT accounting_cashier_events_check2 CHECK (((issued_at >= occurred_at) AND (cardinality(audience_user_ids) >= 2))),
    CONSTRAINT accounting_cashier_events_contract_version_check CHECK ((contract_version = 1)),
    CONSTRAINT accounting_cashier_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['hold'::text, 'approval'::text, 'cancellation'::text, 'decline'::text, 'expiry_refund'::text]))),
    CONSTRAINT accounting_cashier_events_event_slot_check CHECK ((event_slot = ANY (ARRAY['hold'::text, 'terminal'::text])))
);
CREATE TABLE public.accounting_cash_accrual_batches (
    rake_record_id uuid NOT NULL,
    hand_id uuid NOT NULL,
    earned_at timestamp with time zone NOT NULL,
    source_fingerprint text NOT NULL,
    status text NOT NULL,
    plan jsonb,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_cash_accrual_batches_check CHECK (((status = 'accrued'::text) = (plan IS NOT NULL))),
    CONSTRAINT accounting_cash_accrual_batches_status_check CHECK ((status = ANY (ARRAY['accrued'::text, 'legacy_unverified'::text])))
);
CREATE TABLE public.accounting_cash_accrual_cutover (
    singleton boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_cash_accrual_cutover_singleton_check CHECK (singleton)
);
CREATE TABLE public.accounting_cash_bank_receipts (
    rake_record_id uuid NOT NULL,
    union_id uuid,
    club_id uuid NOT NULL,
    union_transaction_id uuid,
    club_ledger_id uuid,
    banked_at timestamp with time zone NOT NULL,
    amount numeric NOT NULL,
    CONSTRAINT accounting_cash_bank_receipts_amount_check CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))),
    CONSTRAINT accounting_cash_bank_receipts_check CHECK ((((union_id IS NOT NULL) AND (union_transaction_id IS NOT NULL) AND (club_ledger_id IS NULL)) OR ((union_id IS NULL) AND (union_transaction_id IS NULL) AND (club_ledger_id IS NOT NULL))))
);
CREATE TABLE public.accounting_cash_rake_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rake_record_id uuid NOT NULL,
    player_id uuid NOT NULL,
    club_id uuid NOT NULL,
    union_id uuid,
    coordinator_union_id uuid,
    earned_at timestamp with time zone NOT NULL,
    rake_credit numeric NOT NULL,
    contract jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_cash_rake_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))
);
CREATE TABLE public.accounting_cash_source_receipts (
    id uuid NOT NULL,
    rake_record_id uuid NOT NULL,
    attempt bigint NOT NULL,
    earned_at timestamp with time zone NOT NULL,
    source_fingerprint text NOT NULL,
    status text NOT NULL,
    reason text,
    sqlstate text,
    error_detail text,
    scope jsonb NOT NULL,
    result jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_cash_source_receipts_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT accounting_cash_source_receipts_check CHECK (((status = 'blocked'::text) = (reason IS NOT NULL))),
    CONSTRAINT accounting_cash_source_receipts_scope_check CHECK (((scope ->> 'kind'::text) = ANY (ARRAY['union'::text, 'club'::text, 'unknown'::text]))),
    CONSTRAINT accounting_cash_source_receipts_status_check CHECK ((status = ANY (ARRAY['accrued'::text, 'blocked'::text])))
);
CREATE TABLE public.accounting_cash_source_work (
    rake_record_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    source_fingerprint text NOT NULL,
    status text NOT NULL,
    attempts bigint NOT NULL,
    next_attempt_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_cash_source_work_attempts_check CHECK ((attempts > 0)),
    CONSTRAINT accounting_cash_source_work_status_check CHECK ((status = ANY (ARRAY['accrued'::text, 'blocked'::text])))
);
CREATE TABLE public.accounting_credit_change_documents_v1 (
    id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    operation_receipt_id uuid NOT NULL,
    issuer_name text NOT NULL,
    recipient_name text NOT NULL,
    audience_user_ids uuid[] NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    CONSTRAINT credit_change_document_audience_nonempty CHECK ((cardinality(audience_user_ids) > 0))
);
CREATE TABLE public.accounting_credit_reduction_operations_v1 (
    id uuid NOT NULL,
    contract_version smallint NOT NULL,
    actor_user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    club_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    target_user_id uuid NOT NULL,
    action text NOT NULL,
    requested_reduction numeric(15,2) NOT NULL,
    reason text,
    assignment_reason text NOT NULL,
    before_limit numeric(15,2) NOT NULL,
    after_limit numeric(15,2) NOT NULL,
    credit_used numeric(15,2) NOT NULL,
    before_prepaid boolean NOT NULL,
    after_prepaid boolean NOT NULL,
    before_revision bigint NOT NULL,
    after_revision bigint NOT NULL,
    applied_reduction numeric(15,2) NOT NULL,
    assignment_id uuid,
    document_id uuid,
    invoice_id uuid,
    recorded_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_credit_reduction_operation_requested_reduction_check CHECK (((requested_reduction > (0)::numeric) AND (requested_reduction <= (1000000000)::numeric))),
    CONSTRAINT accounting_credit_reduction_operations__applied_reduction_check CHECK ((((applied_reduction)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (applied_reduction >= (0)::numeric))),
    CONSTRAINT accounting_credit_reduction_operations_v1_action_check CHECK ((action = 'reduce_credit_limit'::text)),
    CONSTRAINT accounting_credit_reduction_operations_v1_after_limit_check CHECK ((((after_limit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (after_limit >= (0)::numeric))),
    CONSTRAINT accounting_credit_reduction_operations_v1_after_revision_check CHECK ((after_revision >= 0)),
    CONSTRAINT accounting_credit_reduction_operations_v1_assignment_id_check CHECK (((assignment_id IS NULL) OR (assignment_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT accounting_credit_reduction_operations_v1_before_limit_check CHECK ((((before_limit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (before_limit >= (0)::numeric))),
    CONSTRAINT accounting_credit_reduction_operations_v1_before_revision_check CHECK ((before_revision >= 0)),
    CONSTRAINT accounting_credit_reduction_operations_v1_check CHECK ((NOT ('00000000-0000-0000-0000-000000000000'::uuid = ANY (ARRAY[id, actor_user_id, operation_id, club_id, agent_id, target_user_id])))),
    CONSTRAINT accounting_credit_reduction_operations_v1_check1 CHECK (((applied_reduction = LEAST(requested_reduction, before_limit)) AND (after_limit = (before_limit - applied_reduction)))),
    CONSTRAINT accounting_credit_reduction_operations_v1_check2 CHECK ((assignment_reason =
CASE
    WHEN ((reason IS NULL) OR (reason = ''::text)) THEN 'Credit line reduced'::text
    ELSE reason
END)),
    CONSTRAINT accounting_credit_reduction_operations_v1_check3 CHECK ((((applied_reduction > (0)::numeric) AND (NOT before_prepaid) AND (before_limit > (0)::numeric) AND (credit_used <= after_limit) AND (after_prepaid = (after_limit = (0)::numeric)) AND ((after_revision)::numeric = ((before_revision)::numeric + (1)::numeric)) AND (assignment_id IS NOT NULL) AND (document_id IS NOT NULL) AND (invoice_id IS NOT NULL) AND (assignment_id <> document_id) AND (assignment_id <> invoice_id) AND (document_id <> invoice_id)) OR ((applied_reduction = (0)::numeric) AND (before_limit = (0)::numeric) AND (after_limit = (0)::numeric) AND (credit_used = (0)::numeric) AND before_prepaid AND after_prepaid AND (before_revision = after_revision) AND (assignment_id IS NULL) AND (document_id IS NULL) AND (invoice_id IS NULL)))),
    CONSTRAINT accounting_credit_reduction_operations_v1_credit_used_check CHECK ((((credit_used)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (credit_used >= (0)::numeric))),
    CONSTRAINT accounting_credit_reduction_operations_v1_document_id_check CHECK (((document_id IS NULL) OR (document_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT accounting_credit_reduction_operations_v1_invoice_id_check CHECK (((invoice_id IS NULL) OR (invoice_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT accounting_credit_reduction_operations_v1_recorded_at_check CHECK (isfinite(recorded_at)),
    CONSTRAINT accounting_credit_reduction_operations_v_contract_version_check CHECK ((contract_version = 1))
);
CREATE TABLE public.accounting_credit_reduction_retirements_v1 (
    id uuid NOT NULL,
    contract_version smallint NOT NULL,
    actor_user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    club_id uuid NOT NULL,
    retired_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_credit_reduction_retirements__contract_version_check CHECK ((contract_version = 1)),
    CONSTRAINT accounting_credit_reduction_retirements_v1_check CHECK ((NOT ('00000000-0000-0000-0000-000000000000'::uuid = ANY (ARRAY[id, actor_user_id, operation_id, club_id])))),
    CONSTRAINT accounting_credit_reduction_retirements_v1_retired_at_check CHECK (isfinite(retired_at))
);
CREATE TABLE public.accounting_tournament_fee_recognitions (
    tournament_id uuid NOT NULL,
    recognized_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    net_rake numeric NOT NULL,
    union_id uuid,
    bank_club_id uuid,
    union_wallet_transaction_id uuid,
    bank_journal_id uuid,
    source_fingerprint text NOT NULL,
    plan jsonb NOT NULL,
    CONSTRAINT accounting_tournament_fee_recognitions_check CHECK (((net_rake = (0)::numeric) OR (bank_club_id IS NOT NULL))),
    CONSTRAINT accounting_tournament_fee_recognitions_check1 CHECK ((((net_rake = (0)::numeric) AND (union_wallet_transaction_id IS NULL) AND (bank_journal_id IS NULL)) OR ((net_rake > (0)::numeric) AND ((((union_wallet_transaction_id IS NOT NULL))::integer + ((bank_journal_id IS NOT NULL))::integer) = 1)))),
    CONSTRAINT accounting_tournament_fee_recognitions_net_rake_check CHECK (((net_rake >= (0)::numeric) AND (net_rake = round(net_rake, 2)) AND ((net_rake)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))),
    CONSTRAINT accounting_tournament_fee_recognitions_status_check CHECK ((status = ANY (ARRAY['recognized'::text, 'cancelled'::text, 'banked_accrual_deferred'::text])))
);
CREATE TABLE public.accounting_tournament_fee_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rake_record_id uuid NOT NULL,
    tournament_id uuid NOT NULL,
    player_id uuid NOT NULL,
    club_id uuid NOT NULL,
    union_id uuid,
    coordinator_union_id uuid,
    game_type text NOT NULL,
    registration_id uuid NOT NULL,
    source_charge_ledger_id uuid NOT NULL,
    source_entitlement_id uuid NOT NULL,
    charged_at timestamp with time zone NOT NULL,
    rake_credit numeric NOT NULL,
    contract jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT accounting_tournament_fee_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))
);
CREATE TABLE public.accounting_tournament_recognized_sources (
    source_id uuid NOT NULL,
    tournament_id uuid NOT NULL,
    recognized_at timestamp with time zone NOT NULL,
    disposition text NOT NULL,
    rake_credit numeric NOT NULL,
    CONSTRAINT accounting_tournament_recognized_sources_disposition_check CHECK ((disposition = ANY (ARRAY['earned'::text, 'refunded'::text]))),
    CONSTRAINT accounting_tournament_recognized_sources_rake_credit_check CHECK (((rake_credit >= (0)::numeric) AND (rake_credit = round(rake_credit, 2)) AND ((rake_credit)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))))
);
CREATE TABLE public.accounting_period_recompute_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    club_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    requested_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_requested_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    attempted_at timestamp with time zone,
    attempts bigint DEFAULT 0 NOT NULL,
    last_result jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT accounting_period_recompute_requests_check CHECK (((EXTRACT(isodow FROM period_start) = (1)::numeric) AND (period_end = (period_start + 6)))),
    CONSTRAINT accounting_period_recompute_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'blocked'::text, 'complete'::text])))
);
CREATE TABLE public.accounting_rakeback_period_calculations (
    id bigint NOT NULL,
    period_id uuid NOT NULL,
    accounting_version integer DEFAULT 2 NOT NULL,
    source_fingerprint text NOT NULL,
    club_id uuid NOT NULL,
    player_id uuid NOT NULL,
    coordinator_union_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    rake_generated numeric NOT NULL,
    rakeback_amount numeric NOT NULL,
    display_rate numeric NOT NULL,
    payer_kind text NOT NULL,
    payer_user_id uuid,
    source_allocations jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT accounting_rakeback_period_calculation_accounting_version_check CHECK ((accounting_version = 2)),
    CONSTRAINT accounting_rakeback_period_calculation_source_allocations_check CHECK ((jsonb_typeof(source_allocations) = 'array'::text)),
    CONSTRAINT accounting_rakeback_period_calculations_check CHECK (((payer_kind = 'agent'::text) = (payer_user_id IS NOT NULL))),
    CONSTRAINT accounting_rakeback_period_calculations_check1 CHECK ((rakeback_amount <= rake_generated)),
    CONSTRAINT accounting_rakeback_period_calculations_display_rate_check CHECK (((display_rate >= (0)::numeric) AND (display_rate <= (1)::numeric) AND (display_rate = round(display_rate, 4)))),
    CONSTRAINT accounting_rakeback_period_calculations_payer_kind_check CHECK ((payer_kind = ANY (ARRAY['club'::text, 'agent'::text]))),
    CONSTRAINT accounting_rakeback_period_calculations_rake_generated_check CHECK ((((rake_generated)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (rake_generated >= (0)::numeric) AND (rake_generated = round(rake_generated, 2)))),
    CONSTRAINT accounting_rakeback_period_calculations_rakeback_amount_check CHECK ((((rakeback_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (rakeback_amount >= (0)::numeric) AND (rakeback_amount = round(rakeback_amount, 2))))
);
CREATE TABLE public.accounting_routed_settlement_runs (
    union_id uuid,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    round_no integer NOT NULL,
    routing_version integer DEFAULT 3 NOT NULL,
    source_fingerprint text NOT NULL,
    result jsonb NOT NULL,
    completed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    standalone_club_id uuid,
    scope_kind text GENERATED ALWAYS AS (
CASE
    WHEN (union_id IS NULL) THEN 'club'::text
    ELSE 'union'::text
END) STORED NOT NULL,
    scope_id uuid GENERATED ALWAYS AS (COALESCE(union_id, standalone_club_id)) STORED NOT NULL,
    CONSTRAINT accounting_routed_run_one_scope CHECK ((num_nonnulls(union_id, standalone_club_id) = 1)),
    CONSTRAINT accounting_routed_settlement_runs_check CHECK ((period_start < period_end)),
    CONSTRAINT accounting_routed_settlement_runs_round_no_check CHECK ((round_no = ANY (ARRAY[2, 3]))),
    CONSTRAINT accounting_routed_settlement_runs_routing_version_check CHECK ((routing_version = 3))
);
CREATE TABLE public.accounting_tournament_fee_batches (
    rake_record_id uuid NOT NULL,
    tournament_id uuid NOT NULL,
    source_fingerprint text NOT NULL,
    status text DEFAULT 'captured'::text NOT NULL,
    source_version integer DEFAULT 2 NOT NULL,
    source_manifest jsonb,
    rake_amount numeric NOT NULL,
    captured_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT accounting_tournament_fee_batches_check CHECK (((status = 'legacy_unverified'::text) OR (jsonb_typeof(source_manifest) = 'object'::text))),
    CONSTRAINT accounting_tournament_fee_batches_rake_amount_check CHECK (((rake_amount > (0)::numeric) AND (rake_amount = round(rake_amount, 2)) AND ((rake_amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])))),
    CONSTRAINT accounting_tournament_fee_batches_source_version_check CHECK ((source_version = 2)),
    CONSTRAINT accounting_tournament_fee_batches_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'legacy_unverified'::text])))
);
CREATE TABLE public.accounting_tournament_fee_cutover (
    singleton boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    CONSTRAINT accounting_tournament_fee_cutover_singleton_check CHECK (singleton)
);
CREATE TABLE public.ca_correction_request_intents_v1 (
    linkage_key text NOT NULL,
    ledger_id uuid NOT NULL,
    request_intent jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT ca_correction_request_intents_v1_request_intent_check CHECK (((jsonb_typeof(request_intent) = 'object'::text) AND ((request_intent ->> 'version'::text) = '1'::text)))
);
CREATE TABLE public.chip_escrow (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cashout_request_id uuid NOT NULL,
    player_id uuid NOT NULL,
    amount numeric(15,2) NOT NULL,
    locked_at timestamp with time zone DEFAULT now(),
    released_at timestamp with time zone,
    release_type text,
    club_id uuid,
    table_id uuid,
    CONSTRAINT chip_escrow_release_type_check CHECK ((release_type = ANY (ARRAY['completed'::text, 'cancelled'::text, 'rejected'::text, 'expired'::text])))
);
CREATE TABLE public.commission_rate_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id uuid NOT NULL,
    changed_by uuid NOT NULL,
    old_rate numeric NOT NULL,
    new_rate numeric NOT NULL,
    rate_type text NOT NULL,
    club_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commission_rate_audit_rate_type_check CHECK ((rate_type = ANY (ARRAY['rakeback'::text, 'commission'::text, 'sub_agent_split'::text, 'bonus_pct'::text])))
);
CREATE TABLE public.credit_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requester_id uuid NOT NULL,
    approver_id uuid,
    club_id uuid NOT NULL,
    requested_amount numeric DEFAULT 0 NOT NULL,
    approved_amount numeric,
    reason text,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewer_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    decision_authority_version smallint
);
CREATE TABLE public.engine_alert_delivery_receipts (
    event_id uuid NOT NULL,
    engine_alert_id bigint NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT engine_alert_delivery_payload_object CHECK ((jsonb_typeof(payload) = 'object'::text))
);
CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    push_enabled boolean DEFAULT true,
    email_enabled boolean DEFAULT true,
    sms_enabled boolean DEFAULT false,
    marketing_enabled boolean DEFAULT false,
    tournament_alerts boolean DEFAULT true,
    social_alerts boolean DEFAULT true,
    training_alerts boolean DEFAULT true,
    preferences jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mute_all boolean DEFAULT false NOT NULL,
    browser_push boolean DEFAULT false NOT NULL,
    push_type_prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    quiet_hours_start smallint,
    quiet_hours_end smallint,
    quiet_hours_tz text,
    daily_push_cap integer DEFAULT 0 NOT NULL,
    CONSTRAINT notification_preferences_daily_push_cap_check CHECK ((daily_push_cap >= 0)),
    CONSTRAINT notification_preferences_quiet_hours_end_check CHECK (((quiet_hours_end IS NULL) OR ((quiet_hours_end >= 0) AND (quiet_hours_end <= 23)))),
    CONSTRAINT notification_preferences_quiet_hours_start_check CHECK (((quiet_hours_start IS NULL) OR ((quiet_hours_start >= 0) AND (quiet_hours_start <= 23))))
);
CREATE TABLE public.operational_notification_destinations (
    notification_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    target_task_id uuid DEFAULT '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid NOT NULL,
    original_notification jsonb NOT NULL,
    inbox_event_id bigint,
    captured_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_attempt_at timestamp with time zone,
    last_error text,
    CONSTRAINT operational_notification_destinatio_original_notification_check CHECK ((jsonb_typeof(original_notification) = 'object'::text)),
    CONSTRAINT operational_notification_destinations_recipient_user_id_check CHECK ((recipient_user_id = '47965354-0e56-43ef-931c-ddaab82af765'::uuid)),
    CONSTRAINT operational_notification_destinations_target_task_id_check CHECK ((target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'::uuid))
);
CREATE TABLE public.player_agent_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    player_id uuid NOT NULL,
    club_id uuid NOT NULL,
    agent_id uuid,
    sub_agent_id uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT player_assigned_exactly_one CHECK ((((agent_id IS NOT NULL) AND (sub_agent_id IS NULL)) OR ((agent_id IS NULL) AND (sub_agent_id IS NOT NULL))))
);
CREATE TABLE public.sub_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    parent_agent_id uuid NOT NULL,
    club_id uuid NOT NULL,
    commission_pct numeric(5,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    suspended_reason text,
    suspended_at timestamp with time zone,
    total_players_recruited integer DEFAULT 0 NOT NULL,
    total_rake_generated numeric(20,4) DEFAULT 0 NOT NULL,
    total_commission_paid numeric(20,4) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sub_agents_commission_pct_check CHECK (((commission_pct >= (0)::numeric) AND (commission_pct <= (100)::numeric))),
    CONSTRAINT sub_agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])))
);
ALTER TABLE ONLY public.accounting_cash_accrual_batches
    ADD CONSTRAINT accounting_cash_accrual_batches_hand_id_key UNIQUE (hand_id);
ALTER TABLE ONLY public.accounting_cash_accrual_batches
    ADD CONSTRAINT accounting_cash_accrual_batches_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE ONLY public.accounting_cash_accrual_cutover
    ADD CONSTRAINT accounting_cash_accrual_cutover_pkey PRIMARY KEY (singleton);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_club_ledger_id_key UNIQUE (club_ledger_id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_union_transaction_id_key UNIQUE (union_transaction_id);
ALTER TABLE ONLY public.accounting_cash_rake_sources
    ADD CONSTRAINT accounting_cash_rake_sources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_cash_rake_sources
    ADD CONSTRAINT accounting_cash_rake_sources_rake_record_id_player_id_key UNIQUE (rake_record_id, player_id);
ALTER TABLE ONLY public.accounting_cash_source_receipts
    ADD CONSTRAINT accounting_cash_source_receipts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_cash_source_receipts
    ADD CONSTRAINT accounting_cash_source_receipts_rake_record_id_attempt_key UNIQUE (rake_record_id, attempt);
ALTER TABLE ONLY public.accounting_cash_source_work
    ADD CONSTRAINT accounting_cash_source_work_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_actor_user_id_op_id_key UNIQUE NULLS NOT DISTINCT (actor_user_id, op_id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_cashout_id_event_slot_key UNIQUE (cashout_id, event_slot);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_source_ledger_id_key UNIQUE (source_ledger_id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_source_transaction_id_key UNIQUE (source_transaction_id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_source_ledger_id_key UNIQUE (source_ledger_id);
ALTER TABLE ONLY public.accounting_credit_change_documents_v1
    ADD CONSTRAINT accounting_credit_change_documents_v1_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE ONLY public.accounting_credit_change_documents_v1
    ADD CONSTRAINT accounting_credit_change_documents_v1_operation_receipt_id_key UNIQUE (operation_receipt_id);
ALTER TABLE ONLY public.accounting_credit_change_documents_v1
    ADD CONSTRAINT accounting_credit_change_documents_v1_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_credit_reduction_operations_v1
    ADD CONSTRAINT accounting_credit_reduction_oper_actor_user_id_operation_id_key UNIQUE (actor_user_id, operation_id);
ALTER TABLE ONLY public.accounting_credit_reduction_operations_v1
    ADD CONSTRAINT accounting_credit_reduction_operations_v1_assignment_id_key UNIQUE (assignment_id);
ALTER TABLE ONLY public.accounting_credit_reduction_operations_v1
    ADD CONSTRAINT accounting_credit_reduction_operations_v1_document_id_key UNIQUE (document_id);
ALTER TABLE ONLY public.accounting_credit_reduction_operations_v1
    ADD CONSTRAINT accounting_credit_reduction_operations_v1_invoice_id_key UNIQUE (invoice_id);
ALTER TABLE ONLY public.accounting_credit_reduction_operations_v1
    ADD CONSTRAINT accounting_credit_reduction_operations_v1_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_credit_reduction_retirements_v1
    ADD CONSTRAINT accounting_credit_reduction_reti_actor_user_id_operation_id_key UNIQUE (actor_user_id, operation_id);
ALTER TABLE ONLY public.accounting_credit_reduction_retirements_v1
    ADD CONSTRAINT accounting_credit_reduction_retirements_v1_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_period_recompute_requests
    ADD CONSTRAINT accounting_period_recompute_r_club_id_period_start_period_e_key UNIQUE (club_id, period_start, period_end);
ALTER TABLE ONLY public.accounting_period_recompute_requests
    ADD CONSTRAINT accounting_period_recompute_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_rakeback_period_calculations
    ADD CONSTRAINT accounting_rakeback_period_cal_period_id_source_fingerprint_key UNIQUE (period_id, source_fingerprint);
ALTER TABLE ONLY public.accounting_rakeback_period_calculations
    ADD CONSTRAINT accounting_rakeback_period_calculations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_routed_settlement_runs
    ADD CONSTRAINT accounting_routed_settlement_runs_pkey PRIMARY KEY (scope_kind, scope_id, period_start, period_end, round_no);
ALTER TABLE ONLY public.accounting_tournament_fee_batches
    ADD CONSTRAINT accounting_tournament_fee_batches_pkey PRIMARY KEY (rake_record_id);
ALTER TABLE ONLY public.accounting_tournament_fee_cutover
    ADD CONSTRAINT accounting_tournament_fee_cutover_pkey PRIMARY KEY (singleton);
ALTER TABLE ONLY public.accounting_tournament_fee_recognitions
    ADD CONSTRAINT accounting_tournament_fee_recog_union_wallet_transaction_id_key UNIQUE (union_wallet_transaction_id);
ALTER TABLE ONLY public.accounting_tournament_fee_recognitions
    ADD CONSTRAINT accounting_tournament_fee_recognitions_bank_journal_id_key UNIQUE (bank_journal_id);
ALTER TABLE ONLY public.accounting_tournament_fee_recognitions
    ADD CONSTRAINT accounting_tournament_fee_recognitions_pkey PRIMARY KEY (tournament_id);
ALTER TABLE ONLY public.accounting_tournament_fee_sources
    ADD CONSTRAINT accounting_tournament_fee_sources_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.accounting_tournament_fee_sources
    ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_player_id_key UNIQUE (rake_record_id, player_id);
ALTER TABLE ONLY public.accounting_tournament_fee_sources
    ADD CONSTRAINT accounting_tournament_fee_sources_source_entitlement_id_key UNIQUE (source_entitlement_id);
ALTER TABLE ONLY public.accounting_tournament_recognized_sources
    ADD CONSTRAINT accounting_tournament_recognized_sources_pkey PRIMARY KEY (source_id);
ALTER TABLE ONLY public.ca_correction_request_intents_v1
    ADD CONSTRAINT ca_correction_request_intents_v1_ledger_id_key UNIQUE (ledger_id);
ALTER TABLE ONLY public.ca_correction_request_intents_v1
    ADD CONSTRAINT ca_correction_request_intents_v1_pkey PRIMARY KEY (linkage_key);
ALTER TABLE ONLY public.chip_escrow
    ADD CONSTRAINT chip_escrow_cashout_request_id_key UNIQUE (cashout_request_id);
ALTER TABLE ONLY public.chip_escrow
    ADD CONSTRAINT chip_escrow_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.commission_rate_audit
    ADD CONSTRAINT commission_rate_audit_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.credit_requests
    ADD CONSTRAINT credit_requests_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.engine_alert_delivery_receipts
    ADD CONSTRAINT engine_alert_delivery_receipts_engine_alert_id_key UNIQUE (engine_alert_id);
ALTER TABLE ONLY public.engine_alert_delivery_receipts
    ADD CONSTRAINT engine_alert_delivery_receipts_pkey PRIMARY KEY (event_id);
ALTER TABLE ONLY public.engine_alerts
    ADD CONSTRAINT engine_alerts_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id);
ALTER TABLE ONLY public.operational_alert_events
    ADD CONSTRAINT operational_alert_events_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.operational_alert_events
    ADD CONSTRAINT operational_alert_events_source_event_key_key UNIQUE (source, event_key);
ALTER TABLE ONLY public.operational_notification_destinations
    ADD CONSTRAINT operational_notification_destinations_pkey PRIMARY KEY (notification_id);
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_player_id_club_id_key UNIQUE (player_id, club_id);
ALTER TABLE ONLY public.sub_agents
    ADD CONSTRAINT sub_agents_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sub_agents
    ADD CONSTRAINT sub_agents_user_id_key UNIQUE (user_id);
CREATE INDEX accounting_cash_accrual_batches_earned ON public.accounting_cash_accrual_batches USING btree (earned_at, status);
CREATE INDEX accounting_cash_bank_receipts_union_period ON public.accounting_cash_bank_receipts USING btree (union_id, banked_at);
CREATE INDEX accounting_cash_rake_sources_bank_period ON public.accounting_cash_rake_sources USING btree (union_id, earned_at) WHERE (union_id IS NOT NULL);
CREATE INDEX accounting_cash_rake_sources_coordinator_period ON public.accounting_cash_rake_sources USING btree (coordinator_union_id, earned_at, club_id);
CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources USING btree (club_id, earned_at, player_id);
CREATE INDEX accounting_cash_source_work_retry ON public.accounting_cash_source_work USING btree (next_attempt_at, rake_record_id) WHERE (status = 'blocked'::text);
CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests USING btree (period_start, club_id) WHERE (status <> 'complete'::text);
CREATE INDEX accounting_rakeback_period_calculations_latest ON public.accounting_rakeback_period_calculations USING btree (period_id, id DESC);
CREATE INDEX accounting_tournament_fee_sources_event ON public.accounting_tournament_fee_sources USING btree (tournament_id, rake_record_id);
CREATE INDEX accounting_tournament_recognized_sources_week ON public.accounting_tournament_recognized_sources USING btree (recognized_at, tournament_id);
CREATE INDEX engine_alerts_active_idx ON public.engine_alerts USING btree (alertname, status, received_at DESC);
CREATE INDEX engine_alerts_received_idx ON public.engine_alerts USING btree (received_at DESC);
CREATE INDEX idx_commission_rate_audit_changed_by ON public.commission_rate_audit USING btree (changed_by);
CREATE INDEX idx_commission_rate_audit_club_id_fk ON public.commission_rate_audit USING btree (club_id);
CREATE INDEX idx_player_agent_assignments_club_id_fk ON public.player_agent_assignments USING btree (club_id);
CREATE INDEX idx_sub_agents_club_id_fk ON public.sub_agents USING btree (club_id);
CREATE INDEX operational_alert_pending_idx ON public.operational_alert_events USING btree (investigation_status, id);
CREATE INDEX operational_notification_destinations_pending_idx ON public.operational_notification_destinations USING btree (captured_at, notification_id) WHERE (inbox_event_id IS NULL);
ALTER TABLE ONLY public.accounting_cash_accrual_batches
    ADD CONSTRAINT accounting_cash_accrual_batches_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.rake_records(id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_club_ledger_id_fkey FOREIGN KEY (club_ledger_id) REFERENCES public.chip_ledger(id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.rake_records(id);
ALTER TABLE ONLY public.accounting_cash_bank_receipts
    ADD CONSTRAINT accounting_cash_bank_receipts_union_transaction_id_fkey FOREIGN KEY (union_transaction_id) REFERENCES public.union_wallet_transactions(id);
ALTER TABLE ONLY public.accounting_cash_rake_sources
    ADD CONSTRAINT accounting_cash_rake_sources_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);
ALTER TABLE ONLY public.accounting_cash_rake_sources
    ADD CONSTRAINT accounting_cash_rake_sources_player_id_fkey FOREIGN KEY (player_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.accounting_cash_rake_sources
    ADD CONSTRAINT accounting_cash_rake_sources_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.accounting_cash_accrual_batches(rake_record_id);
ALTER TABLE ONLY public.accounting_cash_source_receipts
    ADD CONSTRAINT accounting_cash_source_receipts_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.rake_records(id);
ALTER TABLE ONLY public.accounting_cash_source_work
    ADD CONSTRAINT accounting_cash_source_work_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.rake_records(id);
ALTER TABLE ONLY public.accounting_cash_source_work
    ADD CONSTRAINT accounting_cash_source_work_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.accounting_cash_source_receipts(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_cashout_id_fkey FOREIGN KEY (cashout_id) REFERENCES public.cashout_requests(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_escrow_id_fkey FOREIGN KEY (escrow_id) REFERENCES public.chip_escrow(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_hold_event_id_fkey FOREIGN KEY (hold_event_id) REFERENCES public.accounting_cashier_events(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_hold_invoice_id_fkey FOREIGN KEY (hold_invoice_id) REFERENCES public.settlement_invoices(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_source_ledger_id_fkey FOREIGN KEY (source_ledger_id) REFERENCES public.chip_ledger(id);
ALTER TABLE ONLY public.accounting_cashier_events
    ADD CONSTRAINT accounting_cashier_events_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES public.chip_transactions(id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_source_ledger_id_fkey FOREIGN KEY (source_ledger_id) REFERENCES public.chip_ledger(id);
ALTER TABLE ONLY public.accounting_correction_documents
    ADD CONSTRAINT accounting_correction_documents_union_id_fkey FOREIGN KEY (union_id) REFERENCES public.unions(id);
ALTER TABLE ONLY public.accounting_period_recompute_requests
    ADD CONSTRAINT accounting_period_recompute_requests_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);
ALTER TABLE ONLY public.accounting_rakeback_period_calculations
    ADD CONSTRAINT accounting_rakeback_period_calculations_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id);
ALTER TABLE ONLY public.accounting_rakeback_period_calculations
    ADD CONSTRAINT accounting_rakeback_period_calculations_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.rakeback_periods(id);
ALTER TABLE ONLY public.accounting_tournament_fee_batches
    ADD CONSTRAINT accounting_tournament_fee_batches_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.rake_records(id);
ALTER TABLE ONLY public.accounting_tournament_fee_recognitions
    ADD CONSTRAINT accounting_tournament_fee_reco_union_wallet_transaction_id_fkey FOREIGN KEY (union_wallet_transaction_id) REFERENCES public.union_wallet_transactions(id);
ALTER TABLE ONLY public.accounting_tournament_fee_recognitions
    ADD CONSTRAINT accounting_tournament_fee_recognitions_bank_journal_id_fkey FOREIGN KEY (bank_journal_id) REFERENCES public.chip_ledger(id);
ALTER TABLE ONLY public.accounting_tournament_fee_sources
    ADD CONSTRAINT accounting_tournament_fee_sources_rake_record_id_fkey FOREIGN KEY (rake_record_id) REFERENCES public.accounting_tournament_fee_batches(rake_record_id);
ALTER TABLE ONLY public.accounting_tournament_recognized_sources
    ADD CONSTRAINT accounting_tournament_recognized_sources_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.accounting_tournament_fee_sources(id);
ALTER TABLE ONLY public.accounting_tournament_recognized_sources
    ADD CONSTRAINT accounting_tournament_recognized_sources_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.accounting_tournament_fee_recognitions(tournament_id);
ALTER TABLE ONLY public.chip_escrow
    ADD CONSTRAINT chip_escrow_cashout_request_id_fkey FOREIGN KEY (cashout_request_id) REFERENCES public.cashout_requests(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.chip_escrow
    ADD CONSTRAINT chip_escrow_player_id_fkey FOREIGN KEY (player_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.commission_rate_audit
    ADD CONSTRAINT commission_rate_audit_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.commission_rate_audit
    ADD CONSTRAINT commission_rate_audit_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.commission_rate_audit
    ADD CONSTRAINT commission_rate_audit_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.accounting_credit_change_documents_v1
    ADD CONSTRAINT credit_change_document_invoice_fk FOREIGN KEY (invoice_id) REFERENCES public.settlement_invoices(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ONLY public.engine_alert_delivery_receipts
    ADD CONSTRAINT engine_alert_delivery_receipts_engine_alert_id_fkey FOREIGN KEY (engine_alert_id) REFERENCES public.engine_alerts(id) ON DELETE RESTRICT;
ALTER TABLE ONLY public.chip_escrow
    ADD CONSTRAINT fk_chip_escrow_player_id_profiles FOREIGN KEY (player_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.operational_notification_destinations
    ADD CONSTRAINT operational_notification_destinations_inbox_event_id_fkey FOREIGN KEY (inbox_event_id) REFERENCES public.operational_alert_events(id);
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_player_id_fkey FOREIGN KEY (player_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.player_agent_assignments
    ADD CONSTRAINT player_agent_assignments_sub_agent_id_fkey FOREIGN KEY (sub_agent_id) REFERENCES public.sub_agents(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.sub_agents
    ADD CONSTRAINT sub_agents_club_id_fkey FOREIGN KEY (club_id) REFERENCES public.clubs(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.sub_agents
    ADD CONSTRAINT sub_agents_parent_agent_id_fkey FOREIGN KEY (parent_agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.sub_agents
    ADD CONSTRAINT sub_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE VIEW public.accounting_payable_earning_sources WITH (security_invoker='true') AS
 SELECT 'cash_rake_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    NULL::uuid AS tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    s.contract
   FROM public.accounting_cash_rake_sources s
UNION ALL
 SELECT 'tournament_fee_accrual'::text AS source_type,
    s.id AS source_id,
    s.rake_record_id,
    s.tournament_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    rs.recognized_at AS earned_at,
    s.rake_credit,
    s.contract
   FROM ((public.accounting_tournament_fee_sources s
     JOIN public.accounting_tournament_recognized_sources rs ON (((rs.source_id = s.id) AND (rs.tournament_id = s.tournament_id))))
     JOIN public.accounting_tournament_fee_recognitions r ON ((r.tournament_id = s.tournament_id)))
  WHERE ((rs.disposition = 'earned'::text) AND (r.status = 'recognized'::text) AND (rs.rake_credit = s.rake_credit) AND (rs.recognized_at = r.recognized_at) AND (NOT (s.union_id IS DISTINCT FROM r.union_id)));

-- Exact identity definitions retained from the same accepted catalog.
ALTER TABLE public.accounting_rakeback_period_calculations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.accounting_rakeback_period_calculations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
-- The bounded schema capture retained this orphan sequence without its table.
DROP SEQUENCE public.operational_alert_events_id_seq;
ALTER TABLE public.operational_alert_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operational_alert_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
