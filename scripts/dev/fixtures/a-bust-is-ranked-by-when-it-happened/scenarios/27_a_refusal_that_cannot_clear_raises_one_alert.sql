-- FIXED. An older knockout generation nothing proves bought back makes both
-- doors refuse the player's newer bust (unresolved_knockout_generation_chain);
-- at the bounty door that now includes a generation whose head was never
-- collected (22). No newer generation can prove the older one, so the player
-- stays 'playing' at zero chips and the event can never finish - and the engine
-- skips the player after three refusals, and cron 304 only looks at events with
-- one player left, so nothing said so. Each door now writes one critical
-- financial_alerts row per player
-- (knockout_door.payout_blocked_by_unrecordable_bust) while it stays open, and
-- a door that records a bust writes none. The same alert for a generation the
-- player played on from is proved in 20.
\set ON_ERROR_STOP on
\set t '27000000-0000-4000-8000-000000000001'
\set k '27000000-0000-4000-8000-000000000002'
\set tb '27000000-0000-4000-8000-0000000000ab'
\set kb '27000000-0000-4000-8000-0000000000ac'
\set u1 '27000000-0000-4000-8000-000000000011'
\set u2 '27000000-0000-4000-8000-000000000012'
\set u3 '27000000-0000-4000-8000-000000000013'
INSERT INTO public.tournaments (id, status) VALUES (:'t', 'RUNNING');
INSERT INTO public.tournaments (id, status, is_bounty, bounty_amount) VALUES (:'k', 'RUNNING', true, 1.00);
INSERT INTO public.tables (id, tournament_id) VALUES (:'tb', :'t'), (:'kb', :'k');
SELECT probe.player(:'t', '27000000-0000-4000-8000-0000000000ff', 9000);
SELECT probe.player(:'t', '27000000-0000-4000-8000-0000000000fe', 9000);
SELECT probe.player(:'k', '27000000-0000-4000-8000-0000000000ff', 9000);
SELECT probe.player(:'k', '27000000-0000-4000-8000-0000000000fe', 9000);

-- u1 (non-bounty): an older pending generation and no rebuy leg at all
SELECT probe.player(:'t', :'u1');
SELECT probe.bust(:'t', :'tb', :'u1', 2700001, 100, '2026-09-10 10:00:00+00');
SELECT probe.bust(:'t', :'tb', :'u1', 2700002, 100, '2026-09-10 11:00:00+00');
-- u2 (bounty): a rebuy leg after the older generation, but no obligation ever named its head
SELECT probe.player(:'k', :'u2');
SELECT probe.bust(:'k', :'kb', :'u2', 2700011, 100, '2026-09-10 10:00:00+00');
SELECT probe.rebuy_leg(:'k', :'u2', '2026-09-10 10:00:05+00');
SELECT probe.bust(:'k', :'kb', :'u2', 2700012, 100, '2026-09-10 11:00:00+00');
-- u3 (non-bounty): an ordinary bust
SELECT probe.player(:'t', :'u3');
SELECT probe.bust(:'t', :'tb', :'u3', 2700021, 100, '2026-09-10 12:00:00+00');

SELECT probe.door(:'t', :'u1', 5) AS r1 \gset
SELECT probe.claim(:'k', :'u2', 5) AS r2 \gset
SELECT probe.door(:'t', :'u3', 5) AS r3 \gset
SELECT probe.check(:'r1'::jsonb->>'reason' = 'unresolved_knockout_generation_chain'
                   AND :'r2'::jsonb->>'reason' = 'unresolved_knockout_generation_chain',
                   'both doors refuse: ' || :'r1' || ' ' || :'r2');
SELECT probe.check((:'r3'::jsonb->>'claimed')::boolean, 'the ordinary bust is recorded: ' || :'r3');
SELECT probe.check((SELECT count(*) FROM public.financial_alerts
                     WHERE source = 'knockout_door.payout_blocked_by_unrecordable_bust' AND severity = 'critical'
                       AND NOT resolved
                       AND context->>'reason' = 'unresolved_knockout_generation_chain'
                       AND ((context->>'tournament_id' = :'t' AND context->>'user_id' = :'u1'
                             AND (context->>'hand_number')::bigint = 2700002)
                         OR (context->>'tournament_id' = :'k' AND context->>'user_id' = :'u2'
                             AND (context->>'hand_number')::bigint = 2700012))) = 2,
                   'each door names its stuck player and the bust it would not record ('
                   || (SELECT count(*) FROM public.financial_alerts)::text || ' alerts)');
SELECT probe.check(NOT EXISTS (SELECT 1 FROM public.financial_alerts WHERE context->>'user_id' = :'u3'),
                   'a recorded bust raises nothing');

-- refused again while the alert is open: nothing is added
SELECT probe.door(:'t', :'u1', 5) AS again1 \gset
SELECT probe.claim(:'k', :'u2', 5) AS again2 \gset
SELECT probe.check((SELECT count(*) FROM public.financial_alerts) = 2,
                   'a refusal repeated while its alert is open adds none');
-- once an operator closes it without a ruling, the next refusal says so again
UPDATE public.financial_alerts SET resolved = true, resolved_at = now()
 WHERE context->>'user_id' = :'u1';
SELECT probe.door(:'t', :'u1', 5) AS again3 \gset
SELECT probe.check((SELECT count(*) FROM public.financial_alerts WHERE context->>'user_id' = :'u1') = 2
                   AND (SELECT count(*) FROM public.financial_alerts
                         WHERE context->>'user_id' = :'u1' AND NOT resolved) = 1,
                   'a closed alert whose player is still stuck is raised again');
