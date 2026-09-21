-- FIXED. A satellite pays three seats. Three players are left with two seats
-- already locked up by the survivors, so the LAST seat is the best of the three
-- remaining places - and two of those three bust in the SAME hand.
--
-- big started that hand with 900 chips, small with 100. TDA: the smaller
-- hand-start stack busts first and finishes lower. So big takes the last seat
-- (place 3) and small is the bubble (place 4).
--
-- The door recorded big's row before small's, so by elimination_sequence small
-- is the last elimination and looks like the better finish. Before this
-- migration the standings gate demanded exactly that recording order, and would
-- have certified a cohort that handed the last seat to `small`.
\set ON_ERROR_STOP on
\set t   'e0000000-0000-4000-8000-000000000001'
\set tb  'e0000000-0000-4000-8000-0000000000ab'
\set q1  'e0000000-0000-4000-8000-000000000011'
\set q2  'e0000000-0000-4000-8000-000000000012'
\set big 'e0000000-0000-4000-8000-0000000000b0'
\set sml 'e0000000-0000-4000-8000-0000000000c0'
\set out 'e0000000-0000-4000-8000-0000000000d0'

-- Two survivors hold seats 1 and 2. Three eliminated players, in the order the
-- door RECORDED them: out (an earlier hand), then big, then small. The door
-- wrote the bigger stack's row first, so by recording order small is the LAST
-- elimination - and the rule this replaces reads that as the better finish.
SELECT probe.satellite(:'t', ARRAY[:'q1',:'q2']::uuid[], ARRAY[:'out',:'big',:'sml']::uuid[]);

-- `out` busts alone, one hand earlier. `small` and `big` bust in hand 900,
-- small with the shorter stack.
SELECT probe.bust(:'t', :'tb', :'out', 899, 400, '2026-09-20 12:00:00+00');
SELECT probe.bust(:'t', :'tb', :'sml', 900, 100, '2026-09-20 12:05:00+00');
SELECT probe.bust(:'t', :'tb', :'big', 900, 900, '2026-09-20 12:05:00+00');

-- THE TRUE LADDER: big 3rd (the last seat), small 4th (the bubble), out 5th.
SELECT probe.place(:'t', ARRAY[:'big',:'sml',:'out']::uuid[]);
SELECT probe.check(probe.accepts(:'t'),
  'the true ladder is certified: the bigger hand-start stack takes the last seat');

SELECT probe.check(
  (SELECT position FROM public.tournament_players
    WHERE tournament_id=:'t' AND user_id=:'big') = 3,
  'big finishes 3rd and takes the last seat');
SELECT probe.check(
  (SELECT position FROM public.tournament_players
    WHERE tournament_id=:'t' AND user_id=:'sml') = 4,
  'small finishes 4th and is the bubble');

-- THE RECORDING ORDER, which is what the defect certified: small 3rd, big 4th.
SELECT probe.place(:'t', ARRAY[:'sml',:'big',:'out']::uuid[]);
SELECT probe.check(NOT probe.accepts(:'t'),
  'the recording-order ladder is refused: it hands the last seat to the shorter stack');
