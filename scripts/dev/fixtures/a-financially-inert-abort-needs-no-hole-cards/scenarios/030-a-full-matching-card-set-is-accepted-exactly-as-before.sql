-- KEPT. (c) Every seat still has its cards and they match the roster. This is
-- the ordinary path and nothing about it may change.
\set ON_ERROR_STOP on
BEGIN;
SELECT probe.deal('2c621856-e728-4e8b-bf08-4c56746a8649',12942021,ARRAY[1,3]);
SELECT probe.deal('bbbb1111-0000-4000-8000-00000000000b',900001,ARRAY[1,3]);
SELECT probe.expect_inert_both(false, 'full card set: condition 1 (exactly zero) fails, so the relaxation is unreachable');
SELECT probe.expect_both('ACCEPTED', 'full matching card set');
-- The canonical still carries both rows, unchanged by the coalesce.
DO $$
DECLARE c jsonb := probe.cards('A');
BEGIN
 IF jsonb_array_length(c) <> 2 THEN
  RAISE EXCEPTION 'PROBE FAILED: canonical cards is %, expected 2 rows', c;
 END IF;
 RAISE NOTICE 'CANONICAL A cards carries % row(s)', jsonb_array_length(c);
END $$;
COMMIT;
