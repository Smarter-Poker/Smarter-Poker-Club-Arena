-- Disposable fixture only (job 5, P14.3 selection receipts). Loaded after
-- setup.sql, the historical schema migration, reader-auth.sql, the r2 step
-- migration and the private reader migration, and BEFORE
-- 20261007075304_horse_commitment_selection_receipts.sql.
--
-- setup.sql models only the four source columns the r2 step reads. The new
-- readers also name the columns ACCEPTED_SOURCE_SELECT reads, so this adds
-- them with the types the repository's own migrations give them
-- (hand_history.hand_number is integer live; hand_atomic_commits per
-- 20260908042100 and 20260908043400). Columns are appended so the retained
-- 85/24 fixtures' positional INSERTs keep working unchanged; hand_number and
-- stack_result stay nullable here only so those fixtures need no edit.
--
-- The two smarter_private tables copy the column lists of
-- 20261007024757 (accepted_hand_rosters) and 20260918092329
-- (hand_submissions) with RLS on and no API-role privileges. Their write
-- guards (first-write discriminator, immutability) are owned and qualified by
-- those migrations' own runners and are NOT modelled here: this fixture
-- inserts rows directly as the owner. No production object, credential or
-- connection is involved.
ALTER TABLE public.hand_history
  ADD COLUMN hand_number integer,
  ADD COLUMN actions jsonb DEFAULT '[]';
ALTER TABLE public.hand_atomic_commits
  ADD COLUMN hand_number bigint,
  ADD COLUMN stack_result jsonb,
  ADD COLUMN committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN post_commit_request_hash text,
  ADD COLUMN post_commit_completed_at timestamptz;

CREATE SCHEMA smarter_private;
REVOKE ALL ON SCHEMA smarter_private FROM PUBLIC;
CREATE TABLE smarter_private.accepted_hand_rosters (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  post_commit_payload_hash text NOT NULL CHECK (post_commit_payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('captured','unavailable')),
  reasons text[] NOT NULL DEFAULT '{}' CHECK (cardinality(reasons) <= 16),
  roster jsonb,
  producer_version text NOT NULL DEFAULT 'accepted_hand_roster_v1'
    CHECK (producer_version = 'accepted_hand_roster_v1'),
  captured_txid bigint NOT NULL DEFAULT txid_current(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, hand_number),
  CHECK ((status = 'captured') = (roster IS NOT NULL)),
  CHECK ((status = 'captured') = (cardinality(reasons) = 0)),
  CHECK (roster IS NULL OR jsonb_typeof(roster) = 'object')
);
CREATE TABLE smarter_private.hand_submissions (
 submission_id uuid PRIMARY KEY,
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL CHECK (hand_number>0),
 instance_id text NOT NULL CHECK (length(btrim(instance_id))>0),
 lease_generation uuid NOT NULL,
 request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(table_id,hand_number)
);
ALTER TABLE smarter_private.accepted_hand_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.accepted_hand_rosters,smarter_private.hand_submissions
  FROM PUBLIC,anon,authenticated,service_role;
