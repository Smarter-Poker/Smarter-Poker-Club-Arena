-- Recognition prerequisites are fixture data. Actual shared source reader,
-- stage bodies, rollup and document delivery functions are exercised below.
CREATE TABLE accounting_tournament_fee_sources(id uuid PRIMARY KEY,rake_record_id uuid,tournament_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,charged_at timestamptz,rake_credit numeric,contract jsonb);
CREATE TABLE accounting_tournament_fee_recognitions(tournament_id uuid PRIMARY KEY,recognized_at timestamptz,status text,net_rake numeric,union_id uuid);
CREATE TABLE accounting_tournament_recognized_sources(source_id uuid PRIMARY KEY REFERENCES accounting_tournament_fee_sources(id),tournament_id uuid REFERENCES accounting_tournament_fee_recognitions(tournament_id),recognized_at timestamptz,disposition text,rake_credit numeric);
