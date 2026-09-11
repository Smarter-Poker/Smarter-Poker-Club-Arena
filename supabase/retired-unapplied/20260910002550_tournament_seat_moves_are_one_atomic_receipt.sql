-- 20260910002550_tournament_seat_moves_are_one_atomic_receipt
--
-- Tournament seat movement has one canonical mutation authority:
-- public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text).
-- The predecessor migration installs that writer, its one-use seat-exit
-- capability, and its immutable request receipt. An earlier Stage-B draft
-- introduced a second, unwired *_atomic writer with an incompatible receipt
-- schema. Two service-callable writers are not redundancy; they are split
-- authority. This contraction removes those draft overloads, preserves the
-- destination-pointer uniqueness guard, and proves the runtime writer and the
-- lease-loss resolver are the only surviving move surfaces.

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $require_canonical_move_authority$
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL
     OR to_regprocedure(
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'Canonical tournament move writer, receipt, or read-only resolver is missing';
  END IF;
END;
$require_canonical_move_authority$;

-- Retire every signature from the abandoned Stage-B draft. No CASCADE: an
-- unexpected dependency is evidence of a real second caller and must stop the
-- cutover rather than be silently removed.
DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer
);
DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic(
  uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer
);

-- The six-argument legacy writer predates durable request identity.
DROP FUNCTION IF EXISTS public.fn_move_tournament_player(
  uuid,uuid,uuid,uuid,integer,uuid
);

-- One active roster pointer may name one destination chair. Historical
-- eliminated/winner coordinates remain testimony and are intentionally
-- outside this partial uniqueness guard.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_tournament_players_one_active_destination_pointer
  ON public.tournament_players (tournament_id,table_id,seat_number)
  WHERE status IN ('registered','playing')
    AND table_id IS NOT NULL
    AND seat_number IS NOT NULL;

DO $prove_one_tournament_move_authority$
DECLARE
  v_writer_source text;
  v_writer_config text[];
  v_resolver_source text;
  v_receipt_shape text[];
  v_move_function_count integer;
BEGIN
  SELECT p.prosrc,p.proconfig
    INTO STRICT v_writer_source,v_writer_config
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'::regprocedure
     AND p.prosecdef;

  SELECT p.prosrc
    INTO STRICT v_resolver_source
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure
     AND p.prosecdef;

  SELECT count(*)::integer
    INTO v_move_function_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('fn_move_tournament_player',
                       'fn_move_tournament_player_atomic');

  SELECT array_agg(
           a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||
           CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END
           ORDER BY a.attnum)
    INTO v_receipt_shape
    FROM pg_attribute a
   WHERE a.attrelid='public.tournament_seat_move_receipts'::regclass
     AND a.attnum>0 AND NOT a.attisdropped;

  IF v_move_function_count<>1
     OR to_regprocedure(
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer)'
        ) IS NOT NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)'
        ) IS NOT NULL THEN
    RAISE EXCEPTION
      'Tournament move mutation authority is not singular';
  END IF;

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
    RAISE EXCEPTION
      'Canonical tournament move receipt schema drifted: %',v_receipt_shape;
  END IF;

  IF NOT COALESCE(v_writer_config,'{}'::text[])
       @> ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
     OR position('fn_caller_is_engine()' IN v_writer_source)=0
     OR position('ca:tournament-terminal-settlement:v1' IN v_writer_source)=0
     OR position('table_cap:' IN v_writer_source)=0
     OR position('fn_ca_tournament_seat_move_receipt(p_request_id)'
                 IN v_writer_source)=0
     OR position('tournament move requires exactly one live source seat'
                 IN v_writer_source)=0
     OR position('v_source.stack-v_tp.chips::numeric' IN v_writer_source)=0
     OR position('fn_ca_open_tournament_seat_exit_authority'
                 IN v_writer_source)=0
     OR position($needle$SET stack=0,left_at=v_moved_at$needle$
                 IN v_writer_source)=0
     OR position('SET table_id=p_destination_table_id'
                 IN v_writer_source)=0
     OR position('SET current_players=(' IN v_writer_source)=0
     OR position('INSERT INTO public.tournament_seat_move_receipts'
                 IN v_writer_source)=0
     OR position('fn_ca_close_tournament_seat_exit_authority(v_token,true)'
                 IN v_writer_source)=0 THEN
    RAISE EXCEPTION
      'Canonical tournament move writer lost a lock, chip, seat, roster, or receipt invariant';
  END IF;

  IF position('app.smarter_data_actor' IN v_resolver_source)=0
     OR position('ca:tournament-terminal-settlement:v1'
                 IN v_resolver_source)=0
     OR position('fn_ca_tournament_seat_move_receipt(p_request_id)'
                 IN v_resolver_source)=0
     OR v_resolver_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M' THEN
    RAISE EXCEPTION
      'Tournament move lease-loss resolver is not receipt-only';
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
     OR has_function_privilege(
       'anon',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
       'EXECUTE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','SELECT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','INSERT')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','UPDATE')
     OR has_table_privilege(
       'service_role','public.tournament_seat_move_receipts','DELETE') THEN
    RAISE EXCEPTION
      'Tournament move writer, resolver, or receipt ACL is not exact';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_class c
        WHERE c.oid='public.tournament_seat_move_receipts'::regclass
          AND c.relrowsecurity)
     OR NOT EXISTS (
       SELECT 1
         FROM pg_trigger t
        WHERE t.tgrelid='public.tournament_seat_move_receipts'::regclass
          AND t.tgname='tournament_seat_move_receipts_append_only'
          AND NOT t.tgisinternal
          AND t.tgenabled='O')
     OR NOT EXISTS (
       SELECT 1
         FROM pg_class index_relation
         JOIN pg_namespace index_namespace
           ON index_namespace.oid=index_relation.relnamespace
         JOIN pg_index index_catalog
           ON index_catalog.indexrelid=index_relation.oid
        WHERE index_namespace.nspname='public'
          AND index_relation.relname=
                'idx_tournament_players_one_active_destination_pointer'
          AND index_catalog.indrelid='public.tournament_players'::regclass
          AND index_catalog.indisunique
          AND index_catalog.indisvalid
          AND index_catalog.indisready
          AND ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(index_catalog.indkey)
                       WITH ORDINALITY AS key_column(attnum,position)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=index_catalog.indrelid
                   AND attribute.attnum=key_column.attnum
                 ORDER BY key_column.position)
              =ARRAY['tournament_id','table_id','seat_number']::text[]
          AND pg_get_expr(
                index_catalog.indpred,index_catalog.indrelid,true)
              ='(status = ANY (ARRAY[''registered''::text, ''playing''::text])) AND table_id IS NOT NULL AND seat_number IS NOT NULL') THEN
    RAISE EXCEPTION
      'Tournament move receipt immutability or active destination uniqueness is missing';
  END IF;
END;
$prove_one_tournament_move_authority$;

NOTIFY pgrst, 'reload schema';

COMMIT;
