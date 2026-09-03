-- ═══════════════════════════════════════════════════════════════════════════════
--  HAND VALIDATION LOG — Tracks discrepancies in hand results
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hand_validation_log (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    hand_id         TEXT NOT NULL,
    table_id        TEXT NOT NULL,
    discrepancy_type TEXT NOT NULL CHECK (discrepancy_type IN ('POT_MISMATCH', 'WINNER_MISMATCH', 'SIDE_POT_ERROR', 'AMOUNT_MISMATCH')),
    expected_result TEXT NOT NULL,
    actual_result   TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
    resolved        BOOLEAN DEFAULT FALSE,
    resolved_by     UUID REFERENCES auth.users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by hand and severity
CREATE INDEX IF NOT EXISTS idx_hand_validation_hand_id ON hand_validation_log(hand_id);
CREATE INDEX IF NOT EXISTS idx_hand_validation_severity ON hand_validation_log(severity) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_hand_validation_created ON hand_validation_log(created_at DESC);

-- RLS: Only admins/owners can read validation logs
ALTER TABLE hand_validation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read validation logs"
    ON hand_validation_log FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'owner', 'super_agent')
        )
    );

CREATE POLICY "Service can insert validation logs"
    ON hand_validation_log FOR INSERT
    WITH CHECK (TRUE);
