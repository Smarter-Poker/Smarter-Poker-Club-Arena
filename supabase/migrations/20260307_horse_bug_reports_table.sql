-- ============================================================
-- Horse Bug Reports Table — March 7, 2026
-- Persists bug reports from horse mini-agent QA system
-- ============================================================

CREATE TABLE IF NOT EXISTS horse_bug_reports (
    id TEXT PRIMARY KEY,
    horse_name TEXT NOT NULL DEFAULT 'GLOBAL',
    horse_id TEXT NOT NULL DEFAULT 'system',
    table_id TEXT NOT NULL DEFAULT 'global',
    table_name TEXT NOT NULL DEFAULT 'Global',
    hand_number BIGINT NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'runtime_error',
    severity TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    context JSONB NOT NULL DEFAULT '{}'::jsonb,
    stack_trace TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_severity ON horse_bug_reports(severity);
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_category ON horse_bug_reports(category);
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_resolved ON horse_bug_reports(resolved);
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_created_at ON horse_bug_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_horse_name ON horse_bug_reports(horse_name);
CREATE INDEX IF NOT EXISTS idx_horse_bug_reports_table_id ON horse_bug_reports(table_id);

-- Enable RLS
ALTER TABLE horse_bug_reports ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all reports
CREATE POLICY "Authenticated users can read bug reports"
    ON horse_bug_reports FOR SELECT
    TO authenticated
    USING (true);

-- Allow authenticated users to insert reports
CREATE POLICY "Authenticated users can insert bug reports"
    ON horse_bug_reports FOR INSERT
    TO authenticated
    WITH CHECK (true);

-- Allow authenticated users to update (resolve) reports
CREATE POLICY "Authenticated users can update bug reports"
    ON horse_bug_reports FOR UPDATE
    TO authenticated
    USING (true);

-- Allow anon to insert (for horses running without auth)
CREATE POLICY "Anon can insert bug reports"
    ON horse_bug_reports FOR INSERT
    TO anon
    WITH CHECK (true);

-- Allow anon to read
CREATE POLICY "Anon can read bug reports"
    ON horse_bug_reports FOR SELECT
    TO anon
    USING (true);

-- Comment
COMMENT ON TABLE horse_bug_reports IS 'Automated bug reports from horse mini-agent QA system during gameplay';
