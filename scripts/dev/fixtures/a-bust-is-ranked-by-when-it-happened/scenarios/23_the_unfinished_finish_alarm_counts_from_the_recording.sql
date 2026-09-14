-- FIXED. fn_ca_tournament_finished_but_not_completed (cron 304) raises a
-- critical alarm when an event has one player left and has not completed for
-- 15 minutes, measured from max(eliminated_at). eliminated_at is now the time
-- of the bust, and a final bust can be recorded long after it happened: x's
-- last bust happened two hours ago and was recorded a minute ago, so the
-- alarm fired the moment the event became finishable. It now measures from
-- the recording - the resolved_at of the generation the door consumed - and
-- still fires for y, whose last bust was recorded half an hour ago.
\set ON_ERROR_STOP on
\set x '23000000-0000-4000-8000-000000000001'
\set y '23000000-0000-4000-8000-000000000002'
\set xb '23000000-0000-4000-8000-0000000000ab'
\set yb '23000000-0000-4000-8000-0000000000ac'
INSERT INTO public.tournaments (id, name, status, started_at)
VALUES (:'x', 'x', 'RUNNING', now() - interval '4 hours'), (:'y', 'y', 'RUNNING', now() - interval '4 hours');
INSERT INTO public.tables (id, tournament_id) VALUES (:'xb', :'x'), (:'yb', :'y');
SELECT probe.player(:'x', '23000000-0000-4000-8000-00000000000f', 9000);
SELECT probe.player(:'y', '23000000-0000-4000-8000-00000000000f', 9000);
DO $setup$
DECLARE r record; h bigint := 2500000;
BEGIN
  -- tournament, player, bust time, recorded time
  FOR r IN SELECT * FROM (VALUES
      ('23000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-0000000000ab'::uuid,
       '23000000-0000-4000-8000-00000000000a'::uuid, now() - interval '3 hours', now() - interval '3 hours'),
      ('23000000-0000-4000-8000-000000000001'::uuid, '23000000-0000-4000-8000-0000000000ab'::uuid,
       '23000000-0000-4000-8000-00000000000b'::uuid, now() - interval '2 hours', now() - interval '1 minute'),
      ('23000000-0000-4000-8000-000000000002'::uuid, '23000000-0000-4000-8000-0000000000ac'::uuid,
       '23000000-0000-4000-8000-00000000000c'::uuid, now() - interval '31 minutes', now() - interval '30 minutes')) v(t, tb, uid, bust_at, recorded_at) LOOP
    h := h + 1;
    PERFORM probe.player(r.t, r.uid);
    PERFORM probe.bust(r.t, r.tb, r.uid, h, 5000, r.bust_at, 'eliminated');
    UPDATE public.tournament_knockout_candidates SET resolved_at = r.recorded_at
     WHERE tournament_id = r.t AND eliminated_user_id = r.uid;
    -- as the knockout door leaves the row: the bust's own time
    UPDATE public.tournament_players SET status = 'eliminated', position = 2 + (h % 2)::integer, eliminated_at = r.bust_at
     WHERE tournament_id = r.t AND user_id = r.uid;
  END LOOP;
END;
$setup$;

SELECT public.fn_ca_tournament_finished_but_not_completed(15) AS alarm \gset
SELECT probe.check((:'alarm'::jsonb->>'stuck')::integer = 1
                   AND :'alarm'::jsonb->'tournaments'->0->>'tournament_id' = :'y',
                   'only y has been finishable for 15 minutes: ' || :'alarm');
SELECT probe.check((SELECT count(*) = 1 FROM public.financial_alerts
                     WHERE source = 'fn_ca_tournament_finished_but_not_completed'
                       AND context->'tournaments'->0->>'tournament_id' = :'y'),
                   'the alarm names y and only y');
