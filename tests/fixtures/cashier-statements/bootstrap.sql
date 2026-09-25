-- Cashier statements (Phase 5) native PostgreSQL 17 fixture: roles, the
-- Supabase-shaped privileges the migration must actively revoke, and the
-- minimal live column sets the statement functions read. Column names are
-- copied from tests/fixtures/full-weekly-accounting/schema.sql (a production
-- schema capture); nothing here is invented.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.uid',true),'')::uuid$$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;

-- Supabase grants every new public function and table to the three API roles
-- by default. Reproduce that so the migration's REVOKEs are really exercised.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;

CREATE TABLE public.profiles(
  id uuid PRIMARY KEY,
  username text,
  display_name text,
  alias text,
  is_horse boolean DEFAULT false
);
CREATE TABLE public.clubs(id uuid PRIMARY KEY,name text,owner_id uuid);
CREATE TABLE public.club_members(
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text,
  agent_id uuid,
  status text,
  chip_balance numeric(20,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id,user_id)
);
CREATE INDEX club_members_cashier_tree_idx ON public.club_members(club_id,agent_id,user_id);
CREATE TABLE public.agents(
  id uuid PRIMARY KEY,
  user_id uuid,
  club_id uuid,
  parent_agent_id uuid,
  status text DEFAULT 'active',
  agent_wallet_balance numeric DEFAULT 0
);
CREATE TABLE public.chip_transactions(
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id uuid NOT NULL,
  from_user_id uuid,
  to_user_id uuid,
  amount numeric(14,2) NOT NULL,
  transaction_type text NOT NULL,
  notes text,
  related_cashout_id uuid,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now(),
  balance_after numeric(14,2),
  clawed_back boolean DEFAULT false,
  reversible_until timestamp with time zone,
  is_reversed boolean DEFAULT false,
  table_id uuid
);
CREATE INDEX chip_transactions_club_created_idx ON public.chip_transactions(club_id,created_at DESC);
CREATE INDEX chip_transactions_club_from_created_idx ON public.chip_transactions(club_id,from_user_id,created_at DESC);
CREATE INDEX chip_transactions_club_to_created_idx ON public.chip_transactions(club_id,to_user_id,created_at DESC);
-- Partial, exactly as production (tests/fixtures/full-weekly-accounting/schema.sql):
-- the statement's anti-join must carry `metadata ? 'idempotency_key'` to use it.
CREATE UNIQUE INDEX ux_chip_transactions_idempotency_key ON public.chip_transactions USING btree (((metadata ->> 'idempotency_key'::text))) WHERE (metadata ? 'idempotency_key'::text);

-- chip_ledger is hash-chained and append-only in production (chain_seq,
-- prev_hash, row_hash and trg_ca_append_only). The statement only reads it,
-- so the chain columns are carried and the trigger is not.
CREATE TABLE public.chip_ledger(
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  performed_by uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  from_type text NOT NULL,
  from_entity_id uuid,
  from_label text,
  to_type text NOT NULL,
  to_entity_id uuid,
  to_label text,
  amount numeric(15,2) NOT NULL,
  category text NOT NULL,
  description text,
  notes text,
  club_id uuid,
  union_id uuid,
  table_id uuid,
  hand_id uuid,
  tournament_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  idempotency_key text,
  correlation_id uuid,
  causation_id uuid,
  settlement_id text,
  pre_from_balance numeric,
  post_from_balance numeric,
  pre_to_balance numeric,
  post_to_balance numeric,
  status text NOT NULL DEFAULT 'posted',
  metadata jsonb,
  chain_seq bigint,
  prev_hash text,
  row_hash text
);
CREATE INDEX idx_chip_ledger_club_created_desc ON public.chip_ledger(club_id,created_at DESC);
CREATE INDEX idx_chip_ledger_club_from_created ON public.chip_ledger(club_id,from_entity_id,created_at);
CREATE INDEX idx_chip_ledger_club_to_created ON public.chip_ledger(club_id,to_entity_id,created_at);
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The browser reads neither ledger through these doors; keep the fixture's
-- base tables closed to the API roles like production.
REVOKE ALL ON public.profiles,public.clubs,public.club_members,public.agents,public.chip_transactions,public.chip_ledger FROM anon,authenticated;

-- Test helpers (owned by the bootstrap superuser, no data access of their own).
CREATE FUNCTION public.assert_true(boolean,text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF $1 IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',$2;END IF;RAISE NOTICE 'PASS: %',$2;END$$;
CREATE FUNCTION public.refuses(text,text) RETURNS boolean LANGUAGE plpgsql AS $$BEGIN EXECUTE $1;RETURN false;EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE=$2;END$$;
CREATE FUNCTION public.refusal(text) RETURNS text LANGUAGE plpgsql AS $$BEGIN EXECUTE $1;RETURN 'no error';EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE||' '||SQLERRM;END$$;
CREATE FUNCTION public.u(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT ('00000000-0000-0000-0000-'||lpad($1::text,12,'0'))::uuid$$;
CREATE FUNCTION public.as_user(int) RETURNS void LANGUAGE sql AS $$SELECT set_config('test.uid',CASE WHEN $1 IS NULL THEN '' ELSE public.u($1)::text END,false)$$;
