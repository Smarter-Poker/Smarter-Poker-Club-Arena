ALTER TABLE tournaments ADD COLUMN ended_at timestamptz;
CREATE TABLE financial_alerts(id uuid DEFAULT gen_random_uuid(),severity text,source text,message text,context jsonb,resolved boolean DEFAULT false);
