SELECT pg_temp.assert((SELECT count(*)=5 FROM union_pnl_inventory_events),'original active inventory captured completely, terminal historical rows excluded explicitly');
SELECT pg_temp.assert((SELECT source_counts='{"tables":1,"table_seats":1,"tournaments":1,"tournament_players":1,"union_clubs":1}'::jsonb FROM union_pnl_inventory_capture),'capture fence retains exact source counts');
SELECT pg_temp.assert((SELECT bool_and(observed_at>statement_timestamp()-interval '10 minutes' AND transaction_id IS NOT NULL) FROM union_pnl_inventory_events),'baseline is an actual installation observation, never an old-week balance');
SELECT pg_temp.assert(fn_union_pnl_inventory_as_of(fn_union_week_start(now()))->>'reason'='boundary_precedes_original_inventory_capture','past week cannot inherit a current snapshot');
SELECT pg_temp.assert(fn_union_pnl_inventory_as_of(fn_union_week_start(now()+interval '8 days'))->>'reason'='closed_original_week_boundary_required','future boundary refused');
SELECT pg_temp.assert(fn_union_pnl_inventory_as_of(now())->>'reason'='closed_original_week_boundary_required','non-boundary timestamp refused');
UPDATE table_seats SET is_away=true WHERE id=pg_temp.u(3);
SELECT pg_temp.assert((SELECT count(*)=5 FROM union_pnl_inventory_events),'nonfinancial seat activity does not duplicate inventory');
UPDATE table_seats SET stack=0 WHERE id=pg_temp.u(3);
SELECT pg_temp.assert((SELECT before_row->'stack'='100'::jsonb AND after_row->'stack'='0'::jsonb AND operation='UPDATE' FROM union_pnl_inventory_events ORDER BY event_id DESC LIMIT 1),'original zero stack and before image retained');
BEGIN;
UPDATE table_seats SET stack=123 WHERE id=pg_temp.u(3);
ROLLBACK;
SELECT pg_temp.assert((SELECT count(*)=6 FROM union_pnl_inventory_events),'rolled back owner operation cannot publish inventory evidence');
SELECT pg_temp.seed('table_seats',jsonb_build_object('id',pg_temp.u(8),'table_id',pg_temp.u(2),'club_id',pg_temp.u(101),'user_id',pg_temp.u(302),'occupancy_id',pg_temp.u(402),'stack',0,'joined_at',clock_timestamp()));
SELECT pg_temp.assert((SELECT count(*)=7 FROM union_pnl_inventory_events),'zero-stack participant is included without rake or activity filter');
UPDATE tournaments SET status='COMPLETED',ended_at=clock_timestamp() WHERE id=pg_temp.u(4);
SELECT pg_temp.assert((SELECT before_row->>'status'='RUNNING' AND after_row->>'status'='COMPLETED' AND after_row->'prize_pool'='1000'::jsonb FROM union_pnl_inventory_events ORDER BY event_id DESC LIMIT 1),'terminal transition retains original open obligation observation');
DO $$DECLARE rel text; action text; accepted boolean; BEGIN
 FOREACH rel IN ARRAY ARRAY['union_pnl_inventory_events','union_pnl_inventory_capture'] LOOP
  FOREACH action IN ARRAY ARRAY['UPDATE','DELETE','TRUNCATE'] LOOP
   accepted:=false;
   BEGIN
    EXECUTE CASE action WHEN 'UPDATE' THEN format('UPDATE %I SET %I=%I',rel,CASE WHEN rel='union_pnl_inventory_events' THEN 'row_id' ELSE 'captured_at' END,CASE WHEN rel='union_pnl_inventory_events' THEN 'row_id' ELSE 'captured_at' END)
     WHEN 'DELETE' THEN format('DELETE FROM %I',rel) ELSE format('TRUNCATE %I',rel) END;
    accepted:=true;
   EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
   PERFORM pg_temp.assert(NOT accepted,rel||' refuses '||action);
  END LOOP;
 END LOOP;
 BEGIN TRUNCATE table_seats; RAISE EXCEPTION 'truncate accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN PERFORM pg_temp.assert(true,'owner table truncate refuses population destruction'); END;
END $$;
SELECT pg_temp.assert(NOT has_table_privilege('service_role','union_pnl_inventory_events','INSERT') AND NOT has_table_privilege('authenticated','union_pnl_inventory_events','SELECT'),'application roles cannot forge or disclose original inventory');
SELECT pg_temp.assert(NOT has_function_privilege('service_role','fn_union_pnl_inventory_as_of(timestamptz)','EXECUTE') AND NOT has_function_privilege('authenticated','fn_union_pnl_inventory_project(text,jsonb)','EXECUTE'),'private readers do not bypass consumer authorization');

-- Local-only historical fixture seeding: the actual producer above was tested
-- against real current timestamps. To test the unchanged reader's old-boundary
-- behavior without waiting two calendar weeks, shift ONLY isolated fixture
-- evidence timestamps, then immediately restore both immutable guards.
ALTER TABLE union_pnl_inventory_capture DISABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_inventory_events DISABLE TRIGGER original_pnl_inventory_events_immutable;
UPDATE union_pnl_inventory_capture SET captured_at=fn_union_week_start(now())-interval '14 days';
UPDATE union_pnl_inventory_events SET observed_at=fn_union_week_start(now())-interval '13 days'+event_id*interval '1 second';
UPDATE union_pnl_inventory_events SET observed_at=fn_union_week_start(now())+interval '1 second' WHERE source_name='tournaments' AND operation='UPDATE';
ALTER TABLE union_pnl_inventory_capture ENABLE TRIGGER original_pnl_inventory_capture_immutable;
ALTER TABLE union_pnl_inventory_events ENABLE TRIGGER original_pnl_inventory_events_immutable;
CREATE TEMP TABLE original_boundary AS SELECT fn_union_pnl_inventory_as_of(fn_union_week_start(now())) value;
SELECT pg_temp.assert((SELECT value->>'status'='observed' AND value->'issues'='[]'::jsonb AND value->'financial_basis_certified'='false'::jsonb FROM original_boundary),'complete historical population is observed but never monetary certification');
SELECT pg_temp.assert((SELECT jsonb_array_length(value#>'{population,table_seats}')=2 FROM original_boundary),'zero activity participants survive boundary population');
SELECT pg_temp.assert((SELECT value#>>'{population,tournaments,0,row,status}'='RUNNING' FROM original_boundary),'boundary uses original running state despite current terminal state');
SELECT pg_temp.assert((SELECT value#>'{population,table_seats,0,row,stack}'='0'::jsonb FROM original_boundary),'boundary preserves exact recorded zero equity');
UPDATE tables SET club_id=pg_temp.u(999),union_id=pg_temp.u(998) WHERE id=pg_temp.u(2);
UPDATE union_clubs SET club_id=pg_temp.u(999) WHERE id=pg_temp.u(1);
UPDATE table_seats SET stack=800 WHERE id=pg_temp.u(3);
SELECT pg_temp.assert((SELECT fn_union_pnl_inventory_as_of(fn_union_week_start(now()))=value FROM original_boundary),'current balances and membership cannot change original boundary');
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_temp.assert(fn_union_pnl_inventory_as_of(fn_union_week_start(now()))->>'reason'='inventory_requires_fresh_read_committed_snapshot','stale transaction snapshots cannot certify boundary');
ROLLBACK;
UPDATE tournaments SET status='RUNNING' WHERE id=pg_temp.u(6);
-- Reopened pre-fence terminal records have no original population seed. Shift
-- just this isolated event to the old book to exercise explicit refusal.
ALTER TABLE union_pnl_inventory_events DISABLE TRIGGER original_pnl_inventory_events_immutable;
UPDATE union_pnl_inventory_events SET observed_at=fn_union_week_start(now())-interval '1 minute' WHERE source_name='tournaments' AND row_id=pg_temp.u(6);
ALTER TABLE union_pnl_inventory_events ENABLE TRIGGER original_pnl_inventory_events_immutable;
SELECT pg_temp.assert(fn_union_pnl_inventory_as_of(fn_union_week_start(now()))->>'status'='blocked','unobserved terminal population cannot reopen into a certified book');
