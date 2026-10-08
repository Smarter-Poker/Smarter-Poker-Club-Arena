-- Disposable fixture only (job 7, accepted-roster identity). Loaded after
-- selection-setup.sql and 20261007075304, and BEFORE
-- 20261008041707_horse_commitment_audit_accepted_roster_identity.sql, which
-- reads the first accepted roster ever captured as its epoch. This records
-- that first roster at noon UTC two days ago, so the fixture's three audit
-- days are one wholly before the epoch, one across it and one wholly after.
-- The row is a bare discriminator for a hand that is not in hand_history;
-- the audit never scans it. Inserted directly as the owner: the producer's
-- write guards are qualified by 20261007024757's own runner, not here.
INSERT INTO smarter_private.accepted_hand_rosters(table_id,hand_number,hand_id,post_commit_payload_hash,status,roster,captured_at)
VALUES ('66666666-6666-4666-8666-666666666666',1,'77777777-7777-4777-8777-777777777777',repeat('e',64),'captured',
  jsonb_build_object('version',1,'actors','[]'::jsonb),
  (((transaction_timestamp() AT TIME ZONE 'UTC')::date-2)::timestamp AT TIME ZONE 'UTC')+interval '12 hours');
