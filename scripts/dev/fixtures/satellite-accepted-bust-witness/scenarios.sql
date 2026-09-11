BEGIN;
DO $cases$
BEGIN
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(3,10,100,'2026-09-11 02:00Z','2026-09-11 02:10Z');
 PERFORM probe.rank_before(probe.id(100));
 PERFORM probe.second_is(2,'preimage reproduces recording-order inversion');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'accepted commit wins over recording and hand-number order');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,10,50,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(3,10,100,'2026-09-11 01:01Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'same hand larger starting stack finishes higher');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,10,100,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(3,10,100,'2026-09-11 01:01Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'same hand equal stack follows user-id tie break');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z');
 PERFORM probe.candidate(3,10,100,'2026-09-11 02:00Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'pruned hand uses capture time instead of eliminated_at');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,10,50,'2026-09-11 03:00Z');
 PERFORM probe.candidate(3,10,100,'2026-09-11 01:00Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'pruned same hand uses one earliest capture before stack ordering');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(2,10,100,'2026-09-11 04:00Z','2026-09-11 04:10Z');
 PERFORM probe.candidate(3,30,100,'2026-09-11 02:00Z','2026-09-11 02:10Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'latest eliminated generation selects the accepted hand');

 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(2,40,100,'2026-09-11 04:00Z','2026-09-11 04:10Z','rebought');
 PERFORM probe.candidate(3,30,100,'2026-09-11 02:00Z','2026-09-11 02:10Z');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(3,'rebought generation does not replace the eliminated witness');

 PERFORM probe.seed();
 PERFORM probe.rank_before(probe.id(100));
 PERFORM probe.second_is(2,'preimage finite timestamp fallback case');
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(2,'finite eliminated_at fallback is retained');

 PERFORM probe.seed();
 UPDATE public.tournament_players SET eliminated_at='2026-09-11 01:00Z' WHERE status='eliminated';
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.second_is(2,'equal witness times retain sequence tie break');

 PERFORM probe.seed();
 UPDATE public.tournament_players SET eliminated_at=NULL WHERE id=probe.id(2);
 PERFORM probe.refuses_unchanged('missing evidence refuses without changing positions');
 PERFORM probe.seed();
 UPDATE public.tournament_players SET eliminated_at='infinity' WHERE id=probe.id(2);
 PERFORM probe.refuses_unchanged('infinite fallback refuses without changing positions');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z','-infinity');
 PERFORM probe.refuses_unchanged('infinite commit refuses without using fallback');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'infinity');
 PERFORM probe.refuses_unchanged('infinite pruned capture refuses');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,'NaN','2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.refuses_unchanged('NaN selected stack refuses');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.candidate(3,20,'Infinity','2026-09-11 01:00Z');
 PERFORM probe.refuses_unchanged('nonfinite same-hand peer refuses');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,NULL,'2026-09-11 01:00Z','2026-09-11 01:10Z');
 PERFORM probe.refuses_unchanged('unknown same-hand stack refuses');
 PERFORM probe.seed();
 PERFORM probe.candidate(2,20,100,NULL,'2026-09-11 01:10Z');
 PERFORM probe.refuses_unchanged('unknown generation capture refuses');
 PERFORM probe.seed();
 UPDATE public.tournament_players SET elimination_sequence=NULL WHERE id=probe.id(2);
 PERFORM probe.refuses_unchanged('missing durable sequence still refuses');
 PERFORM probe.seed();
 UPDATE public.tournament_players SET elimination_sequence=10 WHERE id=probe.id(2);
 PERFORM probe.refuses_unchanged('duplicate durable sequence still refuses');
 PERFORM probe.seed();
 DELETE FROM public.tournament_players WHERE status='eliminated';
 PERFORM probe.rank_after(probe.id(100));
 PERFORM probe.check((SELECT position=1 AND status='winner' FROM public.tournament_players),
  'single winner with no eliminated field is unchanged');
 RAISE NOTICE 'PASS 20 ranking scenarios; preimage inversion reproduced; refusals preserve rows';
END $cases$;
ROLLBACK;
