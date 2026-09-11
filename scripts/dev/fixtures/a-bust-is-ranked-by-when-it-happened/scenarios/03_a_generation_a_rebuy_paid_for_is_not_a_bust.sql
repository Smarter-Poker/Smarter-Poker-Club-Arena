-- FIXED. The 798866ae shape: the player busted, bought back in twice seconds
-- later, the purchase never marked that generation 'rebought', and the old door
-- refused the player's next, real bust with unresolved_knockout_generation_chain
-- for ever. The posted wallet-to-pool 'rebuy' leg between the two generations
-- proves the older one was bought back; the door closes it with the new bust.
\set ON_ERROR_STOP on
\set t '30000000-0000-4000-8000-000000000001'
\set tb '30000000-0000-4000-8000-0000000000ab'
\set p '30000000-0000-4000-8000-00000000000a'
\set q '30000000-0000-4000-8000-00000000000b'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING');
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'p');
SELECT probe.player(:'t', :'q');
SELECT probe.player(:'t', '30000000-0000-4000-8000-00000000000f', 9000);
SELECT probe.player(:'t', '30000000-0000-4000-8000-000000000010', 9000);

-- p: one orphan, two legs seconds after it, the real bust a day later.
SELECT probe.bust(:'t', :'tb', :'p', 8550341, 2220, '2026-09-09 05:27:52.469+00') AS p_orphan \gset
SELECT probe.rebuy_leg(:'t', :'p', '2026-09-09 05:27:55.790+00');
SELECT probe.rebuy_leg(:'t', :'p', '2026-09-09 05:28:32.179+00');
SELECT probe.bust(:'t', :'tb', :'p', 9166239, 30000, '2026-09-10 15:02:20.300+00') AS p_real \gset

-- q: two orphans, each followed by its own leg, then the real bust.
SELECT probe.bust(:'t', :'tb', :'q', 8260161, 5439, '2026-09-08 18:05:29.700+00') AS q_first \gset
SELECT probe.rebuy_leg(:'t', :'q', '2026-09-08 18:05:31.548+00');
SELECT probe.bust(:'t', :'tb', :'q', 8300000, 4000, '2026-09-08 20:00:00+00') AS q_second \gset
SELECT probe.rebuy_leg(:'t', :'q', '2026-09-08 20:00:05+00');
SELECT probe.bust(:'t', :'tb', :'q', 9303810, 15000, '2026-09-11 01:33:10.821+00') AS q_real \gset

SELECT probe.door(:'t', :'p', 4) AS p_result \gset
SELECT probe.check((:'p_result'::jsonb->>'claimed')::boolean,
                   'the real bust is accepted, not refused for the bought-back generation: ' || :'p_result');
SELECT probe.check(:'p_result'::jsonb->'rebought_generations' = jsonb_build_array(:'p_orphan'::text),
                   'the receipt names the generation the rebuy closed');
SELECT probe.check(probe.state(:'p_orphan') = 'rebought', 'the orphan is resolved to rebought');
SELECT probe.check((SELECT resolved_at IS NOT NULL FROM public.tournament_knockout_candidates
                     WHERE id = :'p_orphan'), 'with a resolution time');
SELECT probe.check(probe.state(:'p_real') = 'eliminated', 'the real bust is the one consumed');
SELECT probe.check(probe.eliminated_at(:'t', :'p') = '2026-09-10 15:02:20.300+00',
                   'and it is stamped with the real bust, not the orphan');

SELECT probe.door(:'t', :'q', 3) AS q_result \gset
SELECT probe.check((:'q_result'::jsonb->>'claimed')::boolean, 'two proven orphans do not block either');
SELECT probe.check(probe.state(:'q_first') = 'rebought' AND probe.state(:'q_second') = 'rebought',
                   'each orphan is closed by its own leg');
SELECT probe.check(probe.state(:'q_real') = 'eliminated', 'the real bust is consumed');
