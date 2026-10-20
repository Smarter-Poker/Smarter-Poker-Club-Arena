CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA smarter_private;
CREATE TABLE public.accounting_close_partials(kind text NOT NULL,union_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,window_start timestamptz NOT NULL,window_end timestamptz NOT NULL,value jsonb NOT NULL,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz NOT NULL,PRIMARY KEY(kind,union_id,period_start,period_end,window_start));
CREATE TABLE public.accounting_close_certificates(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,value jsonb,certified_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end));
CREATE TABLE public.union_pnl_cash_outcomes(table_id uuid,hand_number bigint,hand_id uuid,recognized_at timestamptz,game_scope jsonb,evidence jsonb,payload_hash text,PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.union_pnl_cash_outcome_touches(table_id uuid,hand_number bigint,recognized_at timestamptz,game_union_id text,shaped boolean,accepted_rake text,participants jsonb,PRIMARY KEY(table_id,hand_number));
CREATE INDEX union_pnl_cash_outcome_touches_week ON public.union_pnl_cash_outcome_touches(game_union_id,recognized_at);
CREATE TABLE public.union_pnl_cash_outcome_link_resolutions(table_id uuid,hand_number bigint,hand_id uuid,outcome_payload_hash text,outcome_evidence_md5 text,game_scope jsonb,evidence jsonb,proof_md5 text,proof jsonb,PRIMARY KEY(table_id,hand_number));
CREATE TABLE smarter_private.posthand_escrow_certificates(table_id uuid,hand_number bigint,hand_id uuid,original jsonb,original_sha256 text,recorded_at timestamptz,PRIMARY KEY(table_id,hand_number));
CREATE TABLE public.union_pnl_projection_build(projection text,end_block bigint,last_block bigint,completed_at timestamptz);
CREATE FUNCTION smarter_private.original_inventory_proof_sources_match()RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
CREATE FUNCTION smarter_private.original_inventory_basis_generation()RETURNS text LANGUAGE sql STABLE AS $$SELECT 'fixture-generation'::text$$;
-- Flow/earned stages and timer collaborators are unchanged, controlled inputs.
CREATE FUNCTION public.fn_accounting_close_certificate(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT CASE WHEN $1='earned_plan' THEN '{}'::jsonb END$$;
CREATE FUNCTION public.fn_accounting_close_problem(text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION smarter_private.inventory_basis_cache_read(text,boolean,text,uuid,timestamptz,timestamptz)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT CASE WHEN $3='pnl_flows' THEN '{"bad":0,"flows":[]}'::jsonb END$$;
CREATE FUNCTION public.fn_accounting_union_earned_plan_window(uuid,timestamptz,timestamptz)RETURNS TABLE(value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea)LANGUAGE sql AS $$SELECT '{}'::jsonb,NULL::uuid[],NULL::bytea,NULL::uuid[],NULL::bytea$$;
-- Actual original participant repair is separately source-pinned; fixture supplies
-- original-shaped repaired evidence to exercise the actual hand-lines branch.
CREATE FUNCTION public.fn_union_pnl_posthand_escrow_participants(public.union_pnl_cash_outcomes)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT $1.evidence->'repaired_participants'$$;
CREATE FUNCTION public.fn_union_pnl_posthand_escrow_touch(public.union_pnl_cash_outcome_touches)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT o.evidence->'repaired_participants' FROM public.union_pnl_cash_outcomes o WHERE o.table_id=$1.table_id AND o.hand_number=$1.hand_number$$;
CREATE FUNCTION smarter_private.posthand_escrow_certificate_immutable()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'POSTHAND_ESCROW_CERTIFICATE_IMMUTABLE';END IF;RETURN NEW;END$$;
CREATE FUNCTION public.fn_union_pnl_compact_participants(jsonb)RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$SELECT $1$$;
CREATE FUNCTION smarter_private.posthand_escrow_certified_evidence(uuid,bigint)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT NULL::jsonb$$;
CREATE FUNCTION public.fn_union_pnl_prove_posthand_escrow(uuid,bigint)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT '{"status":"blocked"}'::jsonb$$;
CREATE FUNCTION smarter_private.posthand_escrow_original_snapshot(uuid,bigint)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('hand_id',o.hand_id)FROM public.union_pnl_cash_outcomes o WHERE o.table_id=$1 AND o.hand_number=$2$$;
CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
