-- PREPARED ONLY. Requires an admitted disposable PostgreSQL fixture database,
-- existing extensions.digest and fixture roles postgres/anon/authenticated/service_role.
-- No extension installation, production connection, financial RPC or real rows.
CREATE TABLE public.profiles(id uuid PRIMARY KEY,is_horse boolean);
CREATE TABLE public.tournaments(
  id uuid PRIMARY KEY,tournament_type text,table_size integer,max_players integer
);
CREATE TABLE public.hand_history(
  id uuid PRIMARY KEY,table_id uuid NOT NULL,created_at timestamptz NOT NULL,
  game_variant text,big_blind numeric,players jsonb,tournament_id uuid
);
CREATE INDEX idx_hand_history_created ON public.hand_history(created_at DESC);
CREATE TABLE public.hand_atomic_commits(
  hand_id uuid PRIMARY KEY,table_id uuid,payload_hash text,
  post_commit_payload_hash text,post_commit_payload jsonb
);
-- Next load baseline/migration.sql unchanged; select either its baseline body
-- or replace ONLY that diagnostic body with candidate/function.sql.
