-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419155614 "phase24b2_new_support_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f4ec196d6e80877118cbf49a5b40c675 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 24 PART B2 — New support tables for Home Games features
--  -----------------------------------------------------------------------
--  P3.9   commander_home_post_likes        — per-user like audit
--  P3.10  commander_home_post_comments     — threaded replies on posts
--  P3.11  commander_home_game_polls (+ options + votes) — "what day next week"
--  P3.12  commander_home_invite_tokens     — shareable one-use/N-use links
--  P3.13  commander_home_content_reports   — moderation queue
--  P3.15  commander_home_game_photos       — game-day photo uploads
--  P8.4   commander_home_audit_log         — per-group audit trail
-- =========================================================================

-- ────────────────────────────────────────────────────────────────────────
-- P3.9: Post likes
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_post_likes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    uuid NOT NULL REFERENCES commander_home_posts(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (post_id, user_id)
);

CREATE INDEX idx_home_post_likes_post ON commander_home_post_likes(post_id);
CREATE INDEX idx_home_post_likes_user ON commander_home_post_likes(user_id);

ALTER TABLE commander_home_post_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_post_likes_select ON commander_home_post_likes
  FOR SELECT TO authenticated
  USING (
    -- Can see likes on posts you can see
    post_id IN (
      SELECT p.id FROM commander_home_posts p
      JOIN commander_home_groups g ON g.id = p.group_id
      WHERE g.owner_id = auth.uid()
         OR NOT g.is_private
         OR p.group_id IN (
             SELECT group_id FROM commander_home_members
              WHERE user_id = auth.uid() AND status='approved')
    )
  );
CREATE POLICY home_post_likes_insert ON commander_home_post_likes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY home_post_likes_delete ON commander_home_post_likes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Trigger to maintain denormalized likes_count
CREATE OR REPLACE FUNCTION public.fn_update_home_post_likes_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
    UPDATE commander_home_posts 
       SET likes_count = (
           SELECT COUNT(*) FROM commander_home_post_likes 
            WHERE post_id = COALESCE(NEW.post_id, OLD.post_id)
       )
     WHERE id = COALESCE(NEW.post_id, OLD.post_id);
    RETURN COALESCE(NEW, OLD);
END;
$fn$;

CREATE TRIGGER trg_home_post_likes_count
    AFTER INSERT OR DELETE ON commander_home_post_likes
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_home_post_likes_count();

-- ────────────────────────────────────────────────────────────────────────
-- P3.10: Post comments (flat, non-threaded for v1)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_post_comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    uuid NOT NULL REFERENCES commander_home_posts(id) ON DELETE CASCADE,
    author_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content    text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
    is_edited  boolean DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_post_comments_post ON commander_home_post_comments(post_id, created_at);
CREATE INDEX idx_home_post_comments_author ON commander_home_post_comments(author_id);

ALTER TABLE commander_home_post_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_post_comments_select ON commander_home_post_comments
  FOR SELECT TO authenticated
  USING (
    post_id IN (
      SELECT p.id FROM commander_home_posts p
      JOIN commander_home_groups g ON g.id = p.group_id
      WHERE g.owner_id = auth.uid()
         OR NOT g.is_private
         OR p.group_id IN (
             SELECT group_id FROM commander_home_members
              WHERE user_id = auth.uid() AND status='approved')
    )
  );
CREATE POLICY home_post_comments_insert ON commander_home_post_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND post_id IN (
      SELECT p.id FROM commander_home_posts p
      JOIN commander_home_groups g ON g.id = p.group_id
      WHERE g.owner_id = auth.uid()
         OR p.group_id IN (
             SELECT group_id FROM commander_home_members
              WHERE user_id = auth.uid() AND status='approved')
    )
  );
CREATE POLICY home_post_comments_update ON commander_home_post_comments
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid());
CREATE POLICY home_post_comments_delete ON commander_home_post_comments
  FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR post_id IN (
      SELECT p.id FROM commander_home_posts p
      JOIN commander_home_groups g ON g.id = p.group_id
      WHERE g.owner_id = auth.uid()
         OR p.group_id IN (
             SELECT group_id FROM commander_home_members
              WHERE user_id = auth.uid() AND role = 'admin' AND status='approved')
    )
  );

CREATE OR REPLACE FUNCTION public.fn_update_home_post_comments_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
    UPDATE commander_home_posts 
       SET comments_count = (
           SELECT COUNT(*) FROM commander_home_post_comments 
            WHERE post_id = COALESCE(NEW.post_id, OLD.post_id)
       )
     WHERE id = COALESCE(NEW.post_id, OLD.post_id);
    RETURN COALESCE(NEW, OLD);
END;
$fn$;

CREATE TRIGGER trg_home_post_comments_count
    AFTER INSERT OR DELETE ON commander_home_post_comments
    FOR EACH ROW EXECUTE FUNCTION public.fn_update_home_post_comments_count();

-- ────────────────────────────────────────────────────────────────────────
-- P3.11: Polls (e.g., "what day works next week?")
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_polls (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    created_by   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    question     text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
    poll_type    text NOT NULL DEFAULT 'single_choice' 
                     CHECK (poll_type IN ('single_choice','multi_choice','date_picker')),
    closes_at    timestamptz,  -- NULL = never closes
    is_closed    boolean NOT NULL DEFAULT false,
    options      jsonb NOT NULL DEFAULT '[]',  -- [{id, label}, ...]
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    updated_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_polls_group ON commander_home_polls(group_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commander_home_poll_votes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id    uuid NOT NULL REFERENCES commander_home_polls(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    option_ids text[] NOT NULL,  -- supports multi_choice
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (poll_id, user_id)
);

CREATE INDEX idx_home_poll_votes_poll ON commander_home_poll_votes(poll_id);

ALTER TABLE commander_home_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_home_poll_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_polls_select ON commander_home_polls
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid() OR NOT is_private)
    OR group_id IN (SELECT group_id FROM commander_home_members WHERE user_id=auth.uid() AND status='approved')
  );
CREATE POLICY home_polls_insert ON commander_home_polls
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid())
         OR group_id IN (SELECT group_id FROM commander_home_members 
                          WHERE user_id=auth.uid() AND role IN ('admin','member') AND status='approved'))
  );
CREATE POLICY home_polls_update ON commander_home_polls
  FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    OR group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id=auth.uid() AND role='admin' AND status='approved')
  );

CREATE POLICY home_poll_votes_select ON commander_home_poll_votes
  FOR SELECT TO authenticated
  USING (
    poll_id IN (SELECT id FROM commander_home_polls WHERE 
      group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid() OR NOT is_private)
      OR group_id IN (SELECT group_id FROM commander_home_members WHERE user_id=auth.uid() AND status='approved'))
  );
CREATE POLICY home_poll_votes_insert ON commander_home_poll_votes
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY home_poll_votes_update ON commander_home_poll_votes
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY home_poll_votes_delete ON commander_home_poll_votes
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- P3.12: Shareable invite tokens (single-use or N-use)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_invite_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id        uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    created_by      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    token           text NOT NULL UNIQUE,
    max_uses        integer,  -- NULL = unlimited
    use_count       integer NOT NULL DEFAULT 0,
    click_count     integer NOT NULL DEFAULT 0,
    expires_at      timestamptz,  -- NULL = never
    is_active       boolean NOT NULL DEFAULT true,
    label           text,  -- e.g. "Brian's Instagram Story Link"
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    last_used_at    timestamptz,
    CHECK (max_uses IS NULL OR max_uses >= 1),
    CHECK (use_count >= 0),
    CHECK (use_count <= COALESCE(max_uses, 2147483647))
);

CREATE INDEX idx_home_invite_tokens_group ON commander_home_invite_tokens(group_id);
CREATE UNIQUE INDEX idx_home_invite_tokens_token_active 
    ON commander_home_invite_tokens(token) WHERE is_active=true;

ALTER TABLE commander_home_invite_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_invite_tokens_select ON commander_home_invite_tokens
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id=auth.uid() AND role='admin' AND status='approved')
  );

-- ────────────────────────────────────────────────────────────────────────
-- P3.13: Content reports (moderation queue)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_content_reports (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    reported_type   text NOT NULL CHECK (reported_type IN ('post','comment','group','member','game','review')),
    reported_id     uuid NOT NULL,
    reason_category text NOT NULL CHECK (reason_category IN (
        'spam','harassment','hate_speech','nudity','violence','illegal',
        'fake_game','self_harm','doxxing','other')),
    reason_text     text CHECK (length(reason_text) <= 2000),
    status          text NOT NULL DEFAULT 'pending' 
                        CHECK (status IN ('pending','reviewed','actioned','dismissed')),
    reviewed_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
    reviewed_at     timestamptz,
    moderator_note  text,
    created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_reports_status ON commander_home_content_reports(status, created_at DESC);
CREATE INDEX idx_home_reports_target ON commander_home_content_reports(reported_type, reported_id);
CREATE INDEX idx_home_reports_reporter ON commander_home_content_reports(reporter_id);

ALTER TABLE commander_home_content_reports ENABLE ROW LEVEL SECURITY;

-- Reporters see their own reports; mod queue is service_role only (for admin UI)
CREATE POLICY home_reports_self_select ON commander_home_content_reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid());
CREATE POLICY home_reports_insert ON commander_home_content_reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────────
-- P3.15: Game-day photos
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_game_photos (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id      uuid NOT NULL REFERENCES commander_home_games(id) ON DELETE CASCADE,
    uploader_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    photo_url    text NOT NULL,
    caption      text CHECK (caption IS NULL OR length(caption) <= 500),
    is_featured  boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_game_photos_game ON commander_home_game_photos(game_id, created_at DESC);

ALTER TABLE commander_home_game_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY home_game_photos_select ON commander_home_game_photos
  FOR SELECT TO authenticated
  USING (
    game_id IN (
      SELECT g.id FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = auth.uid()
         OR NOT grp.is_private
         OR g.group_id IN (
             SELECT group_id FROM commander_home_members 
              WHERE user_id=auth.uid() AND status='approved')
    )
  );
CREATE POLICY home_game_photos_insert ON commander_home_game_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    uploader_id = auth.uid()
    AND game_id IN (
      SELECT g.id FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = auth.uid()
         OR g.group_id IN (
             SELECT group_id FROM commander_home_members 
              WHERE user_id=auth.uid() AND status='approved')
    )
  );
CREATE POLICY home_game_photos_update ON commander_home_game_photos
  FOR UPDATE TO authenticated
  USING (
    uploader_id = auth.uid()
    OR game_id IN (
      SELECT g.id FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = auth.uid()
    )
  );
CREATE POLICY home_game_photos_delete ON commander_home_game_photos
  FOR DELETE TO authenticated
  USING (
    uploader_id = auth.uid()
    OR game_id IN (
      SELECT g.id FROM commander_home_games g
      JOIN commander_home_groups grp ON grp.id = g.group_id
      WHERE grp.owner_id = auth.uid()
         OR g.group_id IN (
             SELECT group_id FROM commander_home_members 
              WHERE user_id=auth.uid() AND role='admin' AND status='approved')
    )
  );

-- ────────────────────────────────────────────────────────────────────────
-- P8.4: Per-group audit log
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commander_home_audit_log (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id      uuid NOT NULL REFERENCES commander_home_groups(id) ON DELETE CASCADE,
    actor_id      uuid REFERENCES profiles(id) ON DELETE SET NULL,
    target_type   text NOT NULL,     -- 'member','game','post','group','review'
    target_id     uuid,
    action        text NOT NULL,     -- 'approved','banned','promoted_admin','game_cancelled', etc
    metadata      jsonb DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_home_audit_group ON commander_home_audit_log(group_id, created_at DESC);
CREATE INDEX idx_home_audit_actor ON commander_home_audit_log(actor_id, created_at DESC);
CREATE INDEX idx_home_audit_target ON commander_home_audit_log(target_type, target_id);

ALTER TABLE commander_home_audit_log ENABLE ROW LEVEL SECURITY;

-- Only owners + admins can read the audit log for their group
CREATE POLICY home_audit_log_select ON commander_home_audit_log
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT id FROM commander_home_groups WHERE owner_id=auth.uid())
    OR group_id IN (SELECT group_id FROM commander_home_members 
                     WHERE user_id=auth.uid() AND role='admin' AND status='approved')
  );

-- No direct INSERT — only SECURITY DEFINER RPCs write here
