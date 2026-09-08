ALTER TABLE chip_ledger DROP CONSTRAINT IF EXISTS chip_ledger_from_type_check;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_from_type_check CHECK(from_type IN ('escrow','player_wallet','agent_wallet','settlement_suspense','table_stack','bbj_pool')) NOT VALID;
ALTER TABLE chip_ledger DROP CONSTRAINT IF EXISTS chip_ledger_category_check;
ALTER TABLE chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK(category IN ('adjustment','escrow_hold','escrow_release','bbj_contribution')) NOT VALID;

ALTER TABLE bbj_pools ADD COLUMN alloc_cum_amount numeric DEFAULT 0, ADD COLUMN total_contributed numeric DEFAULT 0,
 ADD COLUMN hands_contributed bigint DEFAULT 0, ADD COLUMN updated_at timestamptz;
CREATE TABLE bbj_contributions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),pool_id uuid,hand_id uuid,table_id uuid,club_id uuid,
 amount numeric,main_portion numeric,backup_portion numeric,promo_portion numeric,big_blind numeric,hand_number integer,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX bbj_pool_hand ON bbj_contributions(pool_id,hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE ca_bbj_policy(id integer PRIMARY KEY,pivot_threshold numeric,standard_main numeric,standard_backup numeric,pivot_main numeric,pivot_backup numeric);
INSERT INTO ca_bbj_policy VALUES(1,100000,.5,.25,.25,.25);
CREATE TABLE ca_bbj_alloc_state(pool_id uuid PRIMARY KEY,main_residue numeric DEFAULT 0,backup_residue numeric DEFAULT 0,updated_at timestamptz);

-- Immutable accepted-hand proof used only to recover missing legacy metadata.
CREATE TABLE IF NOT EXISTS hand_atomic_commits(
 hand_id uuid PRIMARY KEY, table_id uuid, hand_number bigint,
 post_commit_payload jsonb, post_commit_payload_hash text,
 post_commit_completed_at timestamptz
);
CREATE SCHEMA IF NOT EXISTS extensions;
-- PostgreSQL core SHA256 is the same byte digest used by pgcrypto here.
CREATE OR REPLACE FUNCTION extensions.digest(bytea,text) RETURNS bytea
 LANGUAGE sql AS $$SELECT sha256($1)$$;
