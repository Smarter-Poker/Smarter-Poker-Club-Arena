-- KEPT. When players bust one at a time the recording order and the bust order
-- agree, and the gate must certify exactly what it always certified.
\set ON_ERROR_STOP on
\set t   'e0000000-0000-4000-8000-000000000002'
\set tb  'e0000000-0000-4000-8000-0000000000ac'
\set q1  'e0000000-0000-4000-8000-000000000021'
\set a   'e0000000-0000-4000-8000-0000000000a1'
\set b   'e0000000-0000-4000-8000-0000000000a2'
\set c   'e0000000-0000-4000-8000-0000000000a3'
SELECT probe.satellite(:'t', ARRAY[:'q1']::uuid[], ARRAY[:'a',:'b',:'c']::uuid[]);
SELECT probe.bust(:'t', :'tb', :'a', 701, 300, '2026-09-20 10:00:00+00');
SELECT probe.bust(:'t', :'tb', :'b', 702, 300, '2026-09-20 10:10:00+00');
SELECT probe.bust(:'t', :'tb', :'c', 703, 300, '2026-09-20 10:20:00+00');
SELECT probe.place(:'t', ARRAY[:'c',:'b',:'a']::uuid[]);
SELECT probe.check(probe.accepts(:'t'), 'the one-at-a-time ladder is still certified');
SELECT probe.place(:'t', ARRAY[:'a',:'b',:'c']::uuid[]);
SELECT probe.check(NOT probe.accepts(:'t'), 'a reversed ladder is still refused');
