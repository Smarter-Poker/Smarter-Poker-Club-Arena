-- Accessed-column projections of actual public contracts. No financial writer
-- runs here. The bank tournament_id PRIMARY KEY is the actual cardinality law.
CREATE SCHEMA fixture;
CREATE SCHEMA auth;
CREATE SCHEMA smarter_private;
CREATE SCHEMA supabase_migrations;
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[]);
CREATE TABLE public.clubs(id uuid PRIMARY KEY,union_id uuid,asset text,is_platform boolean);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,club_id uuid,union_id uuid);
CREATE TABLE public.accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,net_rake numeric,union_id uuid,bank_club_id uuid,source_fingerprint text);
CREATE TABLE public.tournament_rake_settlements(tournament_id uuid PRIMARY KEY,settled_at timestamptz,amount numeric(15,2) NOT NULL,union_id uuid,club_id uuid);
CREATE TABLE public.tournament_terminal_settlements(tournament_id uuid PRIMARY KEY,settled_at timestamptz,completed_at timestamptz);
CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY,settled_at timestamptz);
CREATE TABLE public.tournament_satellite_settlements(tournament_id uuid PRIMARY KEY,settled_at timestamptz);
CREATE TABLE public.accounting_tournament_fee_sources(id uuid PRIMARY KEY,tournament_id uuid,rake_record_id uuid,rake_credit numeric,union_id uuid,coordinator_union_id uuid,club_id uuid,player_id uuid,contract jsonb,charged_at timestamptz);
CREATE TABLE public.rake_records(id uuid PRIMARY KEY,tournament_id uuid,is_tournament boolean NOT NULL,rake_amount numeric(18,4) NOT NULL,hand_id uuid,table_id uuid,club_id uuid,bbj_contribution numeric(18,4),pot_size numeric(18,4),num_players integer,created_at timestamptz,player_contributions jsonb,global_hand_id bigint,source text,metadata jsonb,rake_method text NOT NULL,returned_uncalled jsonb);
CREATE TABLE public.accounting_tournament_fee_batches(rake_record_id uuid PRIMARY KEY,tournament_id uuid,status text,source_fingerprint text,rake_amount numeric);
CREATE TABLE public.accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY,tournament_id uuid,recognized_at timestamptz,disposition text,rake_credit numeric);
CREATE TABLE public.tournament_refund_entitlements(id uuid PRIMARY KEY,tournament_id uuid,refund_wallet_club_id uuid);
CREATE INDEX ON public.accounting_tournament_fee_sources(tournament_id);
CREATE INDEX ON public.accounting_tournament_fee_sources(rake_record_id);
CREATE INDEX ON public.accounting_tournament_recognized_sources(tournament_id);
CREATE INDEX ON public.rake_records(tournament_id);
CREATE INDEX ON public.tournament_refund_entitlements(tournament_id);
CREATE INDEX ON public.accounting_tournament_fee_recognitions(recognized_at);
CREATE INDEX ON public.tournament_rake_settlements(settled_at);
CREATE INDEX ON public.tournament_terminal_settlements(settled_at);
CREATE TABLE fixture.net_plans(tournament_id uuid PRIMARY KEY,value jsonb,error_code text);
CREATE FUNCTION fixture.u(n integer)RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid$$;
-- Exact inline 17-field fingerprint owner expression from actual quality.
CREATE FUNCTION public.fn_accounting_tournament_fee_fingerprint(r public.rake_records)RETURNS text LANGUAGE sql STABLE AS $$SELECT md5(jsonb_build_object('id',r.id,'hand_id',r.hand_id,'table_id',r.table_id,'club_id',r.club_id,'rake_amount',r.rake_amount,'bbj_contribution',r.bbj_contribution,'pot_size',r.pot_size,'num_players',r.num_players,'created_at',r.created_at,'player_contributions',r.player_contributions,'global_hand_id',r.global_hand_id,'is_tournament',r.is_tournament,'tournament_id',r.tournament_id,'source',r.source,'metadata',r.metadata,'rake_method',r.rake_method,'returned_uncalled',r.returned_uncalled)::text)$$;
-- Explicit external-helper boundaries: quality itself is the full actual body.
CREATE FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
CREATE FUNCTION public.fn_accounting_tournament_source_terms_at(uuid,timestamptz,jsonb)RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT $2$$;
CREATE FUNCTION public.fn_accounting_tournament_fee_net_plan(t uuid)RETURNS jsonb LANGUAGE plpgsql STABLE AS $$DECLARE p fixture.net_plans;BEGIN SELECT * INTO STRICT p FROM fixture.net_plans WHERE tournament_id=t;IF p.error_code IS NOT NULL THEN RAISE EXCEPTION 'fixture external net-plan refusal' USING ERRCODE=p.error_code;END IF;RETURN p.value;END$$;
-- Installer environment boundaries; no production maintenance state is mocked as evidence.
CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.auth_uid',true),'')::uuid$$;
CREATE FUNCTION public.fn_ca_break_window_refuses_migrations(timestamptz)RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.window_refusal',true),'')$$;
CREATE FUNCTION public.fn_platform_frozen()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.frozen',true)IS NOT DISTINCT FROM 'on'$$;
CREATE FUNCTION public.fn_active_maintenance_release_boundary()RETURNS timestamptz LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('native.boundary',true),'')::timestamptz$$;
CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('native.sources_match',true)IS DISTINCT FROM 'off'$$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT 'original-inventory-245-v1:3e8afc28be0839e9a91519ba1efc0a12'::text$$;
