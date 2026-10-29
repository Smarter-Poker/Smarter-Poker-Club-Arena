-- Minimal dependencies for exact unchanged current guard functions.
ALTER TABLE hand_atomic_commits ADD COLUMN post_commit_payload jsonb;
ALTER TABLE smarter_private.hand_submission_dispositions ADD COLUMN permit_id uuid UNIQUE, ADD PRIMARY KEY(table_id,hand_number);
CREATE TABLE smarter_private.hand_submission_disposals(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_prepared_hand_cancellations(table_id uuid,hand_number bigint);
CREATE TABLE smarter_private.f06_no_start_continuations(receipt_id uuid,break_id uuid,tournament_id uuid,table_id uuid,original_generation uuid,park jsonb,hand_number bigint);
CREATE TABLE smarter_private.f06_unsettled_hand_aborts(receipt_id uuid,permit_id uuid,tournament_id uuid,table_id uuid,generation uuid,hand_number bigint,break_id uuid);
CREATE TABLE smarter_private.f06_mixed_abort_hands(receipt_id uuid,permit_id uuid,tournament_id uuid,table_id uuid,generation uuid,hand_number bigint,break_id uuid);
