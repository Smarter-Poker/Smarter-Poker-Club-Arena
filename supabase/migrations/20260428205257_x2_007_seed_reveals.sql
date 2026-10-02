-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205257 as "x2_007_seed_reveals"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.seed_reveals (
  hand_id UUID PRIMARY KEY,
  table_id UUID NOT NULL,
  club_id  UUID REFERENCES public.clubs(id) ON DELETE SET NULL,
  seed_commit_sha256 TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seed_plaintext TEXT,
  revealed_at TIMESTAMPTZ,
  shuffle_algo TEXT NOT NULL DEFAULT 'fisher_yates_v1',
  rng_algo     TEXT NOT NULL DEFAULT 'crypto_getRandomValues',
  CONSTRAINT seed_reveal_consistent CHECK (
    seed_plaintext IS NULL OR encode(digest(seed_plaintext, 'sha256'), 'hex') = seed_commit_sha256
  )
);

CREATE INDEX IF NOT EXISTS idx_seed_reveals_table ON public.seed_reveals (table_id, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_seed_reveals_club  ON public.seed_reveals (club_id, committed_at DESC);

ALTER TABLE public.seed_reveals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.seed_reveals;
CREATE POLICY "service_role full access"
  ON public.seed_reveals FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anyone authenticated reads seed reveals" ON public.seed_reveals;
CREATE POLICY "anyone authenticated reads seed reveals"
  ON public.seed_reveals FOR SELECT TO authenticated
  USING (true);
