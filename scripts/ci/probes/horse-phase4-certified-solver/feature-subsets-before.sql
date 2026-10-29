\set ON_ERROR_STOP on
-- This file runs only in the existing disposable PostgreSQL qualification.
CREATE TEMP TABLE v31_feature_metadata_before AS
 SELECT oid,proowner,proacl,proconfig,proisstrict,provolatile,prosecdef,proparallel,
        prorettype,proargtypes,proleakproof
 FROM pg_proc WHERE oid='public.fn_gto_v31_board_relative_key_v2(integer,text)'::regprocedure;
CREATE TEMP TABLE v31_feature_callers_before AS
 SELECT oid,pg_get_functiondef(oid) definition FROM pg_proc
 WHERE oid IN ('public.fn_gto_v31_build_cell(uuid,jsonb)'::regprocedure,
  'public.fn_gto_v31_seal_build(uuid)'::regprocedure,
  'public.fn_gto_v31_promote_dataset(uuid)'::regprocedure,
  'public.fn_gto_v31_heldout_metrics(uuid,text)'::regprocedure);
CREATE TEMP TABLE v31_feature_edge_boards(board text PRIMARY KEY);
INSERT INTO v31_feature_edge_boards VALUES
 ('KsQdJc'),('Ah2d3c'),('AcAdAh'),('Ks7s2s'),('QsJd7c'),
 ('KsQdJc9h'),('Ah2d3c4s'),('AcAdAhAs'),('Ks7s2sTs'),('QsJd7c4h'),
 ('KsQdJc9h2s'),('Ah2d3c4s5h'),('AcAdAhAsKd'),('Ks7s2sTs9s'),
 ('AcAdKsKd2c'),('QsJd7c4h8s');
CREATE TEMP TABLE v31_feature_equivalence_cases(board text,combo integer,old_key text,PRIMARY KEY(board,combo));
CREATE TEMP TABLE v31_feature_timings(kind text PRIMARY KEY,elapsed_ms double precision);
DO $baseline$
DECLARE started timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO v31_feature_equivalence_cases
 SELECT board,i,public.fn_gto_v31_board_relative_key_v2(i,board)
 FROM v31_feature_edge_boards CROSS JOIN generate_series(0,1325) i;
 INSERT INTO v31_feature_timings VALUES ('old',extract(epoch FROM clock_timestamp()-started)*1000);
END;
$baseline$;
