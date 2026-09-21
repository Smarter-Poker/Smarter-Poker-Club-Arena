-- FIXED. Two players bust in one hand from EQUAL starting stacks. TDA would tie
-- them and split the two places' prize, which this does not model: the rule
-- authored for the cash ladder breaks the tie by user id, and the satellite
-- ladder must break it the same way - the higher user id finishes higher.
\set ON_ERROR_STOP on
\set t   'e0000000-0000-4000-8000-000000000003'
\set tb  'e0000000-0000-4000-8000-0000000000ad'
\set q1  'e0000000-0000-4000-8000-000000000031'
\set lo  'e0000000-0000-4000-8000-0000000000e1'
\set hi  'e0000000-0000-4000-8000-0000000000e2'
-- The door recorded the HIGHER user id first, so recording order disagrees.
SELECT probe.satellite(:'t', ARRAY[:'q1']::uuid[], ARRAY[:'hi',:'lo']::uuid[]);
SELECT probe.bust(:'t', :'tb', :'hi', 500, 250, '2026-09-20 11:00:00+00');
SELECT probe.bust(:'t', :'tb', :'lo', 500, 250, '2026-09-20 11:00:00+00');
SELECT probe.place(:'t', ARRAY[:'hi',:'lo']::uuid[]);
SELECT probe.check(probe.accepts(:'t'), 'the equal-stack tie falls to user id: the higher id finishes higher');
SELECT probe.place(:'t', ARRAY[:'lo',:'hi']::uuid[]);
SELECT probe.check(NOT probe.accepts(:'t'), 'the opposite equal-stack order is refused');
