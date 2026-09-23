-- KEPT. (b) One of the two seats still has its cards. That is real drift - some
-- rows survived and some did not - and it must refuse exactly as it does today.
\set ON_ERROR_STOP on
BEGIN;
SELECT probe.deal('2c621856-e728-4e8b-bf08-4c56746a8649',12942021,ARRAY[1]);
SELECT probe.deal('bbbb1111-0000-4000-8000-00000000000b',900001,ARRAY[1]);
SELECT probe.expect_inert_both(false, 'PARTIAL card set: condition 1 (exactly zero) fails');
SELECT probe.expect_both('REFUSED', 'partial card set');
COMMIT;
