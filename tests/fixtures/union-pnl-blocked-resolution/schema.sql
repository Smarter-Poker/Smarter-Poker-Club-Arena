-- Native qualification schema for the blocked cash-outcome resolution.
-- Tables carry the production columns the report, the proof and the writers
-- read (captured 2026-09-28 from information_schema). Readers of the report
-- that are unrelated to accepted cash hands are stubbed to an empty, ready
-- basis so the report's accepted-cash gate is the only thing under test.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;

CREATE TABLE public.union_pnl_cash_outcomes(table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid NOT NULL UNIQUE,
 transaction_id xid8, recognized_at timestamptz NOT NULL, payload_hash text, game_scope jsonb, evidence jsonb, PRIMARY KEY(table_id,hand_number));
CREATE INDEX ON public.union_pnl_cash_outcomes((game_scope->>'game_union_id'),recognized_at);
CREATE TABLE public.union_pnl_weekly_capture(singleton boolean PRIMARY KEY, captured_at timestamptz, contract_version integer);
CREATE TABLE public.union_pnl_original_flows(ledger_id uuid, transaction_id xid8, recognized_at timestamptz, game_scope jsonb, ledger_snapshot jsonb);
CREATE TABLE public.union_pnl_inventory_events(event_id bigint, source_name text, row_id uuid, observed_at timestamptz, transaction_id xid8,
 operation text, before_row jsonb, after_row jsonb);
CREATE TABLE public.union_pnl_transaction_frames(transaction_id xid8, observed_at timestamptz, book_start timestamptz);
CREATE TABLE public.tournament_participant_funding_receipts(id uuid, transaction_id xid8, registration_id uuid, user_id uuid, asset text, funding_club_id uuid);
CREATE TABLE public.tournament_accounting_credit_receipts(transaction_id xid8, id uuid, user_id uuid, credited_club_id uuid,
 tournament_snapshot jsonb, entry_receipt_ids uuid[]);
CREATE TABLE public.accounting_payable_earning_sources(source_type text, club_id uuid, union_id uuid, earned_at timestamptz, rake_credit numeric);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY, from_type text, from_entity_id uuid, to_type text, to_entity_id uuid, amount numeric,
 category text, club_id uuid, status text);
CREATE TABLE public.cash_hand_participant_manifests(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, captured_at timestamptz,
 lease_instance_id text, lease_generation uuid, request jsonb, game_scope jsonb, participants jsonb, issues jsonb, funding_provenance_complete boolean,
 UNIQUE(table_id,hand_number));
CREATE TABLE public.cash_hand_provenance_receipts(table_id uuid, hand_number bigint, hand_id uuid UNIQUE, accepted_at timestamptz, payload_hash text,
 accepted_request jsonb, manifest_id uuid, atomic_receipt jsonb, stack_claim jsonb, stack_settlement jsonb, version integer, status text,
 game_scope jsonb, participants jsonb, signed_external_net numeric, rake numeric, bbj numeric, all_players_included boolean,
 funding_provenance_complete boolean, issues jsonb, transaction_id xid8, PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.cash_participant_funding_receipts(id uuid PRIMARY KEY, recorded_at timestamptz, operation_kind text, operation_key text,
 user_id uuid, table_id uuid, seat_id uuid, occupancy_id uuid, seat_joined_at timestamptz, source_ledger_id uuid UNIQUE, wallet_transaction_id uuid,
 account_type text, account_entity_id uuid, funding_club_id uuid, funding_union_id uuid, asset text, unit_scale integer, amount numeric,
 balance_before numeric, balance_after numeric, pending_addon_id uuid UNIQUE, transaction_id xid8);
CREATE INDEX ON public.cash_participant_funding_receipts(occupancy_id,recorded_at,id);
CREATE TABLE public.cash_funding_application_receipts(pending_addon_id uuid PRIMARY KEY, funding_receipt_id uuid UNIQUE, applied_at timestamptz,
 original_occupancy_id uuid, applied_occupancy_id uuid, applied numeric, refunded numeric, transaction_id xid8);
CREATE TABLE public.cash_seat_move_receipts(move_id uuid PRIMARY KEY, player_id uuid, from_table_id uuid, source_occupancy_id uuid,
 to_table_id uuid, destination_occupancy_id uuid, amount numeric, created_at timestamptz);

-- Stubs: an empty, ready basis for everything but accepted cash hands.
CREATE FUNCTION public.fn_union_pnl_boundary(p_union_id uuid, p_at timestamptz) RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT jsonb_build_object('status','ready','holdings','[]'::jsonb,'inventory',jsonb_build_object('population',jsonb_build_object('union_clubs','[]'::jsonb))) $$;
CREATE FUNCTION public.fn_union_pnl_original_flow_evidence(p_union_id uuid, p_start timestamptz, p_end timestamptz)
 RETURNS TABLE(ledger_id uuid, club_id uuid, user_id uuid, buyins numeric, cashouts numeric, kind text, valid boolean)
 LANGUAGE sql STABLE AS $$ SELECT NULL::uuid,NULL::uuid,NULL::uuid,NULL::numeric,NULL::numeric,NULL::text,NULL::boolean WHERE false $$;
CREATE FUNCTION public.fn_union_pnl_tournament_entry_club(r public.tournament_participant_funding_receipts) RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT r.funding_club_id $$;
CREATE FUNCTION public.fn_union_eco_terms_evidence(p_union_id uuid, p_start timestamptz, p_end timestamptz) RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT jsonb_build_object('status','ready','segments',jsonb_build_array(jsonb_build_object('terms',jsonb_build_object('eco_enabled',true,'eco_rate',0.10,'eco_base_mode','club_cash_profit')))) $$;
CREATE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid, p_start timestamptz, p_end timestamptz) RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid, p_start timestamptz, p_end timestamptz, p_live boolean DEFAULT false)
 RETURNS TABLE(club_id uuid, game_type text, rake_in numeric, rate numeric, payout numeric)
 LANGUAGE sql STABLE AS $$ SELECT NULL::uuid,NULL::text,NULL::numeric,NULL::numeric,NULL::numeric WHERE false $$;
CREATE TABLE public.ca_seat_stack_exits(id bigserial PRIMARY KEY, seat_id uuid, table_id uuid, user_id uuid, club_id uuid, seat_number integer,
 stack numeric, exit_kind text, db_role text, app_name text, occurred_at timestamptz);
