-- Run as postgres on the disposable stage-one rehearsal database after the
-- committed-move receipt migration. The final PASS exception is intentional:
-- it rolls back every fixture row while preserving the proof in the client
-- output.
BEGIN;

DO $fixture_guard$
BEGIN
  IF current_user<>'postgres'
     OR NOT EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid)
     OR to_regprocedure(
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
        ) IS NULL THEN
    RAISE EXCEPTION 'committed move receipt probe requires the disposable stage-one rehearsal database';
  END IF;
END;
$fixture_guard$;

SET LOCAL session_replication_role=replica;

INSERT INTO public.tournaments
SELECT (jsonb_populate_record(NULL::public.tournaments,
  to_jsonb(t)||jsonb_build_object(
    'id','b8100000-0000-4000-8000-000000000001',
    'name','Committed Move Receipt Lease Loss Probe',
    'status','RUNNING','updated_at',clock_timestamp()
  ))).*
  FROM public.tournaments t
 WHERE t.id='30000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO public.tables(
  id,name,tournament_id,status,lifecycle,current_players,game_type,club_id
) VALUES
  ('b8200000-0000-4000-8000-000000000001','Move Receipt Source',
   'b8100000-0000-4000-8000-000000000001','running','live',0,
   'tournament','20000000-0000-0000-0000-000000000001'),
  ('b8200000-0000-4000-8000-000000000002','Move Receipt Destination',
   'b8100000-0000-4000-8000-000000000001','running','live',1,
   'tournament','20000000-0000-0000-0000-000000000001');

INSERT INTO public.table_seats(
  id,table_id,seat_number,user_id,stack,status,joined_at,left_at,
  leave_pending,is_sitting_out,is_away,club_id
) VALUES
  ('b8300000-0000-4000-8000-000000000001',
   'b8200000-0000-4000-8000-000000000001',2,
   '10000000-0000-0000-0000-000000000001',0,'left',
   clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',
   false,false,false,'20000000-0000-0000-0000-000000000001'),
  ('b8300000-0000-4000-8000-000000000002',
   'b8200000-0000-4000-8000-000000000002',4,
   '10000000-0000-0000-0000-000000000001',1075.5,'active',
   clock_timestamp()-interval '1 minute',NULL,
   false,false,false,'20000000-0000-0000-0000-000000000001');

INSERT INTO public.tournament_seat_move_receipts(
  request_id,tournament_id,user_id,source_table_id,destination_table_id,
  source_seat_id,destination_seat_id,source_seat_number,
  destination_seat_number,source_mode,stack,moved_at
) VALUES (
  'b8400000-0000-4000-8000-000000000001',
  'b8100000-0000-4000-8000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'b8200000-0000-4000-8000-000000000001',
  'b8200000-0000-4000-8000-000000000002',
  'b8300000-0000-4000-8000-000000000001',
  'b8300000-0000-4000-8000-000000000002',2,4,
  'live_source',1075.5,clock_timestamp()-interval '1 minute'
);

SET LOCAL session_replication_role=origin;

CREATE TEMP TABLE committed_move_probe_result(value jsonb NOT NULL) ON COMMIT DROP;
GRANT INSERT,SELECT ON committed_move_probe_result TO service_role;

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('app.smarter_data_actor','service',true);

SET LOCAL ROLE service_role;
INSERT INTO committed_move_probe_result(value)
SELECT public.fn_resolve_committed_tournament_seat_move(
  'b8400000-0000-4000-8000-000000000001',
  'b8100000-0000-4000-8000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'b8200000-0000-4000-8000-000000000001',
  'b8200000-0000-4000-8000-000000000002',4,'live_source'
);
RESET ROLE;

DO $proof$
DECLARE
  v_result jsonb:=(SELECT value FROM committed_move_probe_result);
  v_refused boolean:=false;
BEGIN
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'replayed' IS DISTINCT FROM 'true'
     OR (v_result->>'request_id')::uuid IS DISTINCT FROM
          'b8400000-0000-4000-8000-000000000001'::uuid
     OR (v_result->>'tournament_id')::uuid IS DISTINCT FROM
          'b8100000-0000-4000-8000-000000000001'::uuid
     OR (v_result->>'destination_seat_number')::integer IS DISTINCT FROM 4
     OR (v_result->>'stack')::numeric IS DISTINCT FROM 1075.5 THEN
    RAISE EXCEPTION 'FAIL resolver did not return the exact immutable receipt';
  END IF;

  BEGIN
    PERFORM public.fn_resolve_committed_tournament_seat_move(
      'b8400000-0000-4000-8000-000000000001',
      'b8100000-0000-4000-8000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'b8200000-0000-4000-8000-000000000001',
      'b8200000-0000-4000-8000-000000000002',5,'live_source');
  EXCEPTION WHEN unique_violation THEN
    v_refused:=true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'FAIL resolver accepted a mismatched operation identity';
  END IF;

  IF public.fn_resolve_committed_tournament_seat_move(
       'b8400000-0000-4000-8000-000000000099',
       'b8100000-0000-4000-8000-000000000001',
       '10000000-0000-0000-0000-000000000001',
       'b8200000-0000-4000-8000-000000000001',
       'b8200000-0000-4000-8000-000000000002',4,'live_source') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL resolver invented a receipt for an unknown request';
  END IF;

  IF (SELECT count(*) FROM public.tournament_seat_move_receipts r
       WHERE r.tournament_id='b8100000-0000-4000-8000-000000000001')<>1
     OR has_function_privilege(
       'anon',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL receipt-only resolution changed state or leaked authority';
  END IF;

  RAISE EXCEPTION 'PASS committed move receipt survived manager lease loss; exact mismatch refused; missing receipt stayed missing; all probe work rolled back';
END;
$proof$;

ROLLBACK;
