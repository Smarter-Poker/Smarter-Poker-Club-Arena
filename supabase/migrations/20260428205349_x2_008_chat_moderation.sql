-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260428205349 as "x2_008_chat_moderation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
CREATE TABLE IF NOT EXISTS public.chat_filter_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word_pattern TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('slur','spam','ad','phishing','other')),
  severity TEXT NOT NULL DEFAULT 'auto_redact'
    CHECK (severity IN ('auto_redact','auto_warn','auto_mute','flag_only')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_filter_words_active ON public.chat_filter_words (active);

CREATE TABLE IF NOT EXISTS public.chat_moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  table_id UUID,
  club_id UUID REFERENCES public.clubs(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN
    ('auto_redact','auto_warn','auto_mute','warn','mute','unmute','ban','unban','dismiss')),
  reason TEXT NOT NULL,
  matched_filter_id UUID REFERENCES public.chat_filter_words(id) ON DELETE SET NULL,
  original_message TEXT,
  redacted_message TEXT,
  moderator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_mod_user_action ON public.chat_moderation_actions (user_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_mod_club_recent ON public.chat_moderation_actions (club_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_mutes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('table','club','global')),
  table_id UUID,
  club_id  UUID REFERENCES public.clubs(id) ON DELETE CASCADE,
  CONSTRAINT chat_mute_scope_consistent CHECK (
    (scope = 'table'  AND table_id IS NOT NULL) OR
    (scope = 'club'   AND club_id  IS NOT NULL AND table_id IS NULL) OR
    (scope = 'global' AND table_id IS NULL AND club_id IS NULL)
  ),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  reason TEXT,
  applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','auto','self_serve')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_mutes_user_active ON public.chat_mutes (user_id, active);
CREATE INDEX IF NOT EXISTS idx_chat_mutes_expiring    ON public.chat_mutes (expires_at) WHERE active = TRUE;

ALTER TABLE public.chat_filter_words       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_moderation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_mutes              ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.chat_filter_words;
CREATE POLICY "service_role full access"
  ON public.chat_filter_words FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anyone authenticated reads filters" ON public.chat_filter_words;
CREATE POLICY "anyone authenticated reads filters"
  ON public.chat_filter_words FOR SELECT TO authenticated
  USING (active = TRUE);

DROP POLICY IF EXISTS "service_role full access" ON public.chat_moderation_actions;
CREATE POLICY "service_role full access"
  ON public.chat_moderation_actions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read own mod actions" ON public.chat_moderation_actions;
CREATE POLICY "users read own mod actions"
  ON public.chat_moderation_actions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "service_role full access" ON public.chat_mutes;
CREATE POLICY "service_role full access"
  ON public.chat_mutes FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read own mutes" ON public.chat_mutes;
CREATE POLICY "users read own mutes"
  ON public.chat_mutes FOR SELECT TO authenticated
  USING (user_id = auth.uid());

INSERT INTO public.chat_filter_words (word_pattern, category, severity) VALUES
  ('re:\\b(buy|sell)\\s+(chips|account)\\b', 'ad', 'auto_redact'),
  ('re:\\bjoin\\s+telegram\\b',              'spam', 'auto_warn'),
  ('re:https?://[^\\s]+',                    'spam', 'auto_redact')
ON CONFLICT (word_pattern) DO NOTHING;
