-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828013042; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.hand_audit_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  hand_external_id text NOT NULL,
  decision_key text NOT NULL,
  question_id text,
  game_id text NOT NULL,
  street text NOT NULL,
  hero_position text,
  villain_position text,
  spot_type text,
  hero_hand text,
  board_cards jsonb NOT NULL DEFAULT '[]'::jsonb,
  player_action text NOT NULL,
  solver_action text,
  selected_frequency numeric(6,2),
  optimal_frequency numeric(6,2),
  classification text NOT NULL,
  ev_loss numeric,
  ev_loss_measured boolean NOT NULL DEFAULT false,
  solver_verified boolean NOT NULL DEFAULT false,
  solver_source text,
  match_tier integer,
  audited_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hand_audit_decisions_user_hand_decision_key
    UNIQUE (user_id, hand_external_id, decision_key)
);

CREATE INDEX IF NOT EXISTS idx_hand_audit_decisions_user_audited
  ON public.hand_audit_decisions (user_id, audited_at DESC);

CREATE INDEX IF NOT EXISTS idx_hand_audit_decisions_verified_user
  ON public.hand_audit_decisions (user_id, audited_at DESC)
  WHERE solver_verified = true;

CREATE INDEX IF NOT EXISTS idx_training_question_cache_solver_signature
  ON public.training_question_cache (
    (question_data->'scenario'->>'street'),
    (question_data->'scenario'->>'heroPosition'),
    (question_data->'scenario'->>'heroHand')
  );

ALTER TABLE public.hand_audit_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own hand audit decisions" ON public.hand_audit_decisions;
CREATE POLICY "Users can view own hand audit decisions"
  ON public.hand_audit_decisions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages hand audit decisions" ON public.hand_audit_decisions;
CREATE POLICY "Service role manages hand audit decisions"
  ON public.hand_audit_decisions FOR ALL
  USING (auth.jwt()->>'role' = 'service_role')
  WITH CHECK (auth.jwt()->>'role' = 'service_role');
