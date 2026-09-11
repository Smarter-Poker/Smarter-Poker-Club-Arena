-- FIXED. The orphan shape in a bounty event: the player busted, a posted 1.00
-- wallet-to-pool rebuy leg bought them back in seconds later, the generation
-- was never marked 'rebought', and the bounty door then refused the player's
-- next, real bust for ever (unresolved_knockout_generation_chain). The leg
-- proves the older generation was bought back; the door now closes it with the
-- newer bust, as the non-bounty door does - when its head is closed too: no
-- bounty obligation names it (p), or the one that does is settled and complete
-- (q). See 22 for the heads that keep it refused.
\set ON_ERROR_STOP on
\set t '21000000-0000-4000-8000-000000000001'
\set tb '21000000-0000-4000-8000-0000000000ab'
\set p '21000000-0000-4000-8000-00000000000a'
\set q '21000000-0000-4000-8000-00000000000b'
\set w '21000000-0000-4000-8000-00000000000f'
INSERT INTO public.tournaments (id, status, is_bounty, bounty_amount) VALUES (:'t', 'RUNNING', true, 1.00);
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t');
SELECT probe.player(:'t', :'w', 90000);
SELECT probe.player(:'t', '21000000-0000-4000-8000-0000000000fe', 90000);
SELECT probe.player(:'t', :'p');
SELECT probe.player(:'t', :'q');

SELECT probe.bust(:'t', :'tb', :'p', 8550341, 2220, '2026-09-09 05:27:52.469+00') AS p_orphan \gset
SELECT probe.rebuy_leg(:'t', :'p', '2026-09-09 05:27:55.790+00');
SELECT probe.bust(:'t', :'tb', :'p', 9166239, 30000, '2026-09-10 15:02:20.300+00') AS p_real \gset

SELECT probe.bust(:'t', :'tb', :'q', 8260161, 5439, '2026-09-08 18:05:29.700+00') AS q_orphan \gset
SELECT probe.rebuy_leg(:'t', :'q', '2026-09-08 18:05:31.548+00');
SELECT probe.bust(:'t', :'tb', :'q', 9303810, 15000, '2026-09-11 01:33:10.821+00') AS q_real \gset
-- q's older head was claimed and paid in full
INSERT INTO public.tournament_bounty_obligations (
  tournament_id, eliminated_user_id, table_id, hand_id, hand_number, settlement_completed_at,
  seat_joined_at, position, prize, mode, head_amount, knocker_user_id, claimants, state, settled_at)
SELECT c.tournament_id, c.eliminated_user_id, c.table_id, c.hand_id, c.hand_number, c.created_at,
       c.seat_joined_at, 3, 0, 'regular', 1.00, :'w', jsonb_build_array(jsonb_build_object('user_id', :'w', 'weight', 1)),
       'settled', c.created_at + interval '5 seconds'
  FROM public.tournament_knockout_candidates c WHERE c.id = :'q_orphan';
INSERT INTO public.tournament_bounties (tournament_id, eliminated_player_id, collector_player_id,
                                        bounty_amount, added_to_collector_bounty, bounty_obligation_id)
SELECT o.tournament_id, o.eliminated_user_id, :'w', 1.00, 0, o.id
  FROM public.tournament_bounty_obligations o WHERE o.tournament_id = :'t' AND o.eliminated_user_id = :'q';

SELECT probe.claim(:'t', :'p', 4) AS p_result \gset
SELECT probe.check((:'p_result'::jsonb->>'claimed')::boolean,
                   'the real bust is accepted, not refused for the bought-back generation: ' || :'p_result');
SELECT probe.check(:'p_result'::jsonb->'rebought_generations' = jsonb_build_array(:'p_orphan'::text),
                   'the receipt names the generation the rebuy closed');
SELECT probe.check(probe.state(:'p_orphan') = 'rebought' AND probe.state(:'p_real') = 'eliminated',
                   'the orphan is resolved to rebought and the real bust consumed');
SELECT probe.check(probe.eliminated_at(:'t', :'p') = '2026-09-10 15:02:20.300+00',
                   'stamped with the real bust, not the orphan');

SELECT probe.claim(:'t', :'q', 3) AS q_result \gset
SELECT probe.check((:'q_result'::jsonb->>'claimed')::boolean,
                   'a generation whose head was settled does not block the bust either: ' || :'q_result');
SELECT probe.check(probe.state(:'q_orphan') = 'rebought' AND probe.state(:'q_real') = 'eliminated',
                   'q''s orphan is resolved, its real bust consumed');
