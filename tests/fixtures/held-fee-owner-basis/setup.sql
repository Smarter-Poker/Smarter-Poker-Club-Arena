-- Owner-authorized held-fee basis: private native scene over the maintained
-- Early Bird phase (original27 fee rows, 2.70 held in escrow, players final).
CREATE SCHEMA held_fee_fixture;
CREATE TABLE held_fee_fixture.assertions(label text PRIMARY KEY);
CREATE FUNCTION held_fee_fixture.assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label;END IF;
 INSERT INTO held_fee_fixture.assertions VALUES(label);RAISE NOTICE 'PASS %',label;
END $$;
CREATE FUNCTION held_fee_fixture.event() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd'::uuid $$;
CREATE FUNCTION held_fee_fixture.union_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'fade0000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION held_fee_fixture.operation() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT 'e1d0f00d-0000-4000-8000-000000000927'::uuid $$;
CREATE FUNCTION held_fee_fixture.agent_id() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('held-fee-native-agent')::uuid $$;
CREATE FUNCTION held_fee_fixture.terms_at() RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT completed_at-interval '1 minute' FROM public.tournament_terminal_settlements WHERE tournament_id=held_fee_fixture.event() $$;
CREATE VIEW held_fee_fixture.contributors AS
 SELECT r.id AS rake_record_id,e.user_id,e.refund_wallet_club_id AS club_id,r.created_at AS charged_at,r.rake_amount
 FROM public.rake_records r JOIN public.tournament_refund_entitlements e
  ON e.tournament_id=r.tournament_id AND e.user_id::text=r.metadata->>'user_id' AND e.created_at=r.created_at
  AND e.refund_fee=r.rake_amount AND e.entitlement_kind='wallet_charge'
 WHERE r.tournament_id=held_fee_fixture.event() AND r.is_tournament;
-- The agent is an existing contributor account of the first club; the next
-- contributor of that club reports to it.
CREATE TABLE held_fee_fixture.agent AS
 SELECT club_id,(array_agg(DISTINCT user_id ORDER BY user_id))[1] AS user_id,(array_agg(DISTINCT user_id ORDER BY user_id))[2] AS agent_member
 FROM held_fee_fixture.contributors WHERE club_id=(SELECT min(club_id::text)::uuid FROM held_fee_fixture.contributors) GROUP BY club_id;
CREATE FUNCTION held_fee_fixture.snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT earlybird_fee_fixture.snapshot(held_fee_fixture.event()) $$;
SELECT held_fee_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres'
 AND (SELECT count(*)=27 AND sum(rake_amount)=2.70 AND count(DISTINCT club_id)=2 FROM held_fee_fixture.contributors)
 AND (SELECT user_id IS NOT NULL AND agent_member IS NOT NULL FROM held_fee_fixture.agent),
 'Private native scene carries the original27 Early Bird contributors');
