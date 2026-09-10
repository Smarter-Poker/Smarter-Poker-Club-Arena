\set ON_ERROR_STOP on

DO $postconditions$
DECLARE
  v_receipt_shape text[];
BEGIN
  IF (
    SELECT count(*)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('fn_move_tournament_player',
                         'fn_move_tournament_player_atomic')
  )<>1
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
        ) IS NULL THEN
    RAISE EXCEPTION 'one canonical tournament move writer did not survive';
  END IF;

  SELECT array_agg(
           a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
           CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END
           ORDER BY a.attnum)
    INTO v_receipt_shape
    FROM pg_attribute a
   WHERE a.attrelid='public.tournament_seat_move_receipts'::regclass
     AND a.attnum>0 AND NOT a.attisdropped;

  IF v_receipt_shape IS DISTINCT FROM ARRAY[
       'request_id:uuid:not-null',
       'tournament_id:uuid:not-null',
       'user_id:uuid:not-null',
       'source_table_id:uuid:not-null',
       'destination_table_id:uuid:not-null',
       'source_seat_id:uuid:not-null',
       'destination_seat_id:uuid:not-null',
       'source_seat_number:integer:not-null',
       'destination_seat_number:integer:not-null',
       'source_mode:text:not-null',
       'stack:numeric:not-null',
       'moved_at:timestamp with time zone:not-null'
     ]::text[] THEN
    RAISE EXCEPTION 'canonical move receipt changed: %',v_receipt_shape;
  END IF;

  IF has_function_privilege(
       'anon',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)',
       'EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','SELECT')
     OR NOT EXISTS (
       SELECT 1 FROM pg_class c
        WHERE c.oid='public.tournament_seat_move_receipts'::regclass
          AND c.relrowsecurity)
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid='public.tournament_seat_move_receipts'::regclass
          AND t.tgname='tournament_seat_move_receipts_append_only'
          AND t.tgenabled='O' AND NOT t.tgisinternal)
     OR NOT EXISTS (
       SELECT 1
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid=c.oid
        WHERE c.oid=
          'public.idx_tournament_players_one_active_destination_pointer'::regclass
          AND i.indisunique AND i.indisvalid AND i.indisready) THEN
    RAISE EXCEPTION 'canonical move ACL, immutability, or uniqueness is incomplete';
  END IF;
END;
$postconditions$;
