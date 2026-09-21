-- KEPT. (d) Condition 2 fails: this exact hand has an atomic commit, so chips
-- moved and the abort is not inert. The function refuses at its EXISTING
-- later-or-unknown-custody assertion, which is upstream of the card test; the
-- gate is asked directly as well, so the relaxation's own clause is proven.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id)
VALUES ('2c621856-e728-4e8b-bf08-4c56746a8649',12942021,'dddd0001-0000-4000-8000-000000000001'),
       ('bbbb1111-0000-4000-8000-00000000000b',900001,'dddd0002-0000-4000-8000-000000000002');
SELECT probe.expect_inert_both(false, 'condition 2 fails: this hand committed');
SELECT probe.expect_both('REFUSED', 'zero cards but the hand committed');
COMMIT;
