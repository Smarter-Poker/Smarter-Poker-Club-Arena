-- Isolated fixture only. Replace the earlier synthetic physical shell with the
-- five exact original rosters, incarnations, accepted hand and uncapped keys.
-- No witness, successful payout, completed terminal or new sequence is seeded.
SELECT sep8_spin_fixture.assert(inet_server_addr() IS NULL AND current_database()='postgres'
 AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements JOIN sep8_spin_fixture.cases USING(tournament_id))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.spin_original_standings),
 'Original standings seed is local and precedes admission');
CREATE TABLE sep8_spin_fixture.standings_cases(tournament_id uuid PRIMARY KEY,operation_id uuid NOT NULL,expected jsonb NOT NULL);
CREATE TABLE sep8_spin_fixture.standings_sources AS
 SELECT tournament_id,smarter_private.spin_original_retained_case(tournament_id) document FROM sep8_spin_fixture.cases;
BEGIN;
SET LOCAL session_replication_role=replica;
CREATE TEMP TABLE spin_original_tournament_rows ON COMMIT DROP AS
 SELECT r.* FROM sep8_spin_fixture.standings_sources o JOIN public.tournaments t ON t.id=o.tournament_id,
 jsonb_populate_record(t,o.document->'tournament') r;
CREATE TEMP TABLE spin_original_table_rows ON COMMIT DROP AS
 SELECT r.* FROM sep8_spin_fixture.standings_sources o,jsonb_array_elements(o.document->'tables') j,
 public.tables t,jsonb_populate_record(t,j) r WHERE t.id=(j->>'id')::uuid;
DELETE FROM public.table_seats WHERE table_id IN(SELECT table_id FROM sep8_spin_fixture.cases);
DELETE FROM public.tables WHERE tournament_id IN(SELECT tournament_id FROM sep8_spin_fixture.cases);
DELETE FROM public.tournament_players WHERE tournament_id IN(SELECT tournament_id FROM sep8_spin_fixture.cases);
DELETE FROM public.tournaments WHERE id IN(SELECT tournament_id FROM sep8_spin_fixture.cases);
INSERT INTO public.tournaments SELECT * FROM spin_original_tournament_rows;
-- Generated buy-in projections are computed by the actual table definition.
DO $seed_tables$ DECLARE columns text; BEGIN
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO columns
 FROM pg_attribute WHERE attrelid='public.tables'::regclass
 AND attnum>0 AND NOT attisdropped AND attgenerated='';
 EXECUTE format('INSERT INTO public.tables (%s) SELECT %s FROM spin_original_table_rows',columns,columns);
END $seed_tables$;
INSERT INTO public.tournament_players SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.tournament_players,o.document->'roster') r;
INSERT INTO public.table_seats SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.table_seats,o.document->'seats') r;
INSERT INTO public.tournament_knockout_candidates SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.tournament_knockout_candidates,o.document->'candidates') r;
INSERT INTO public.hand_atomic_commits SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.hand_atomic_commits,o.document->'atomic') r;
INSERT INTO public.hand_history SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.hand_history,o.document->'history') r;
INSERT INTO public.settlement_idempotency_keys SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_recordset(NULL::public.settlement_idempotency_keys,o.document->'settlement_keys') r;
INSERT INTO public.tournament_entry_close_receipts SELECT r.* FROM sep8_spin_fixture.standings_sources o,
 jsonb_populate_record(NULL::public.tournament_entry_close_receipts,o.document->'entry_close') r;
-- Literal current manager identities from the original physical capture.
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,engine_version,lease_generation,protocol_version,acquired_at,heartbeat_at) VALUES
 ('b60c7add-6b38-4549-b091-601f64d118a0','1-991f9ac4','7c2371db','7a424f71-3e13-48ef-add1-8467ac9f0743',2,'2026-09-18T09:12:32.955834+00:00','2026-09-18T09:40:17.517865+00:00'),
 ('199a71a9-f364-4e90-a3ba-3cdcfb7755bc','1-991f9ac4','7c2371db','27e40ff5-32d5-4221-b579-1ad74650bee8',2,'2026-09-18T09:12:30.036535+00:00','2026-09-18T09:40:17.517388+00:00'),
 ('f3f050f1-569e-4fb6-859f-86b6092e682e','1-991f9ac4','7c2371db','29133480-4743-4119-9886-f78a1c9ba037',2,'2026-09-18T09:12:32.305597+00:00','2026-09-18T09:40:17.517775+00:00'),
 ('808ef798-0942-4ce0-9ae1-eeefaaf4b0a9','1-991f9ac4','7c2371db','56ac0210-970b-4165-aa10-3c7edfbdcebb',2,'2026-09-18T09:12:32.868343+00:00','2026-09-18T09:40:17.517819+00:00'),
 ('e3f4e2ab-8397-43e8-8643-6cec3fff3a63','1-991f9ac4','7c2371db','7a0a0909-5372-46db-9e95-41be02e7cd35',2,'2026-09-18T09:12:34.494275+00:00','2026-09-18T09:40:17.517963+00:00');
SET LOCAL session_replication_role=origin;
COMMIT;
INSERT INTO sep8_spin_fixture.standings_cases
 SELECT c.tournament_id,md5('local-five-spin-operation:'||c.tournament_id)::uuid,
 jsonb_build_object('tournament_id',c.tournament_id,
 'manager',to_jsonb(l)-ARRAY['heartbeat_at','acquired_at'],
 'snapshot',smarter_private.spin_original_retained_case(c.tournament_id))
 FROM sep8_spin_fixture.cases c JOIN public.engine_tournament_leases l USING(tournament_id);
SELECT sep8_spin_fixture.assert(current_setting('session_replication_role')='origin'
 AND (SELECT count(*)=5 FROM sep8_spin_fixture.standings_cases)
 AND NOT EXISTS(SELECT 1 FROM sep8_spin_fixture.standings_sources s
 WHERE smarter_private.spin_original_current_case(s.tournament_id) IS DISTINCT FROM s.document)
 AND (SELECT count(*)=5 FROM public.tournament_players p JOIN sep8_spin_fixture.cases c USING(tournament_id)
 WHERE p.position=3 AND p.elimination_sequence IS NULL)
 AND (SELECT count(*)=5 FROM public.tournament_players p JOIN sep8_spin_fixture.cases c USING(tournament_id)
 WHERE p.position=2 AND p.elimination_sequence IS NOT NULL),
 'Exact original five standings and complete hand inventories preserved');
