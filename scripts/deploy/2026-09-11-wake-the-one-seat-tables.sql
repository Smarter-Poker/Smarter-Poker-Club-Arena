-- 2026-09-11-wake-the-one-seat-tables.sql
--
-- OPERATIONAL UNBLOCK, applied by the orchestrator as ONE transaction, outside
-- the :50-:03 UTC window (a wake that lands inside the maintenance freeze is
-- spent on a sweep that skips the balancer, which is the defect itself).
-- Writes only tournament_manager_wakes rows, through the platform's own emitter.
-- Not needed once fix/a-frozen-sweep-owes-the-balancer-a-pass-after-the-thaw is
-- deployed: the next restart's thaw then asks for the same pass by itself.
--
-- WHY. 57 RUNNING events (402 funded players, all horses; 17,572.20 in prize
-- pools) have every live table holding exactly one funded player and no table
-- holding two, so none can deal and none produces a wake. Their managers were
-- re-adopted at 10:56 and 11:56 inside the maintenance freeze; the adoption
-- sweep skipped balancing and nothing asked again. A durable wake makes the
-- manager run one ordinary sweep outside the freeze; its balance stage breaks
-- one table per pass and re-arms itself every 5 s until the field is merged.
--
-- ORDER. Seven of these events hold paid-range standings out of true bust order
-- (7aa16fa7, f922df63, 8e16cdb4, bee519fa, 313a274b, e3ef32fd, d7997aef). They
-- must be re-sequenced FIRST (inputs: 2026-09-11-resequence-inputs.sql); this
-- script refuses while any listed event still has a paid-range standing out of
-- true bust order, because once dealing resumes those events can finish and
-- fn_settle_tournament_places pays in elimination_sequence order.
--
-- Reason 'bounty_settled' is used as the neutral wake: GameServer admits it as
-- a plain sweep (only 'late_registration' and 'deal_vote' carry side effects).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE one_seat_events (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO one_seat_events (id) VALUES
    ('5e1f17e4-8801-4b7d-9d75-6ae3917c9301'),
    ('b1c5c8e9-7885-462a-893b-183796ba7f72'),
    ('78617cab-31a5-4a7b-976d-a0c81b25c8cd'),
    ('bfadfccb-55f4-4204-b0d4-b2ad545958ea'),
    ('5964d09d-a31a-4e94-a80b-80820bc0b002'),
    ('2960a276-46db-4487-8a99-6ed82137f603'),
    ('27f8f241-c013-4ec3-ac36-3014fb313d8a'),
    ('01f1a800-e32b-4f79-b907-8505d87e8646'),
    ('c74935b9-84d9-4004-b125-a0724ceddd26'),
    ('bee519fa-ff07-438c-9542-d386fc821908'),
    ('5d555bb1-d86d-42a3-b93a-14e27c0e5299'),
    ('cef15ddb-f65e-443d-b11d-58788edeef24'),
    ('5a5c5e27-e705-4844-b1c1-31302f55ec31'),
    ('ac0f62ca-666e-490e-a7fe-49a4b248df8e'),
    ('7f521f47-c943-4f4d-a802-488d4776d2e9'),
    ('c30cbdee-cc14-45c7-a988-541b1207852d'),
    ('f922df63-a780-4482-86c4-55d8a4199311'),
    ('456963df-1be3-4a71-8540-3d1463d6fd32'),
    ('19402dec-1a13-4854-ac5d-e06859a6ee4e'),
    ('33883f12-0840-43c7-a3c2-18a3f8e9fe84'),
    ('f9e22dd2-2d50-4fc6-be3b-ab18e7f62c13'),
    ('2dbc9bb6-fd3f-4a92-9589-f9f1bf0a879c'),
    ('ed1bc5ab-9e06-4a72-9e4a-36ec41f37e48'),
    ('d7997aef-0a69-4c0a-b074-aa63d8ba40fe'),
    ('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'),
    ('5bd4927b-673b-47af-b87f-3b17d97e8052'),
    ('8e16cdb4-d763-47d5-8545-fdc1c151d364'),
    ('75eead55-020e-4e3c-a231-e725ad19737a'),
    ('4065ef36-7f08-405a-85e7-2045cad04b5c'),
    ('313a274b-0cc8-4b90-bada-f4a4e7deae6a'),
    ('6f4e96d7-4e5a-4670-bb85-2ad4cfb4ca64'),
    ('72989413-a18c-4db5-8c84-6f1409dd4bd9'),
    ('d2910755-21bb-4d87-b317-012f78bd998a'),
    ('8a99264d-c307-4c38-af48-3f8a7b9b5917'),
    ('86bc3818-b881-4c5d-9f6a-c25e39c46500'),
    ('d7e6300c-a6ef-4207-b59b-dbdf222c2cb4'),
    ('cd6328ec-e45b-4fc3-a7b5-aa46baddc2cc'),
    ('dd3dc44a-da68-41b3-999a-fdfc84bc28b2'),
    ('28c46112-5645-4138-8aa4-ce26ba4de79e'),
    ('fc02d2b4-3f82-4c0f-a2d9-05c3a833a6ee'),
    ('dbf7e308-827c-4a66-b61d-663571068e0a'),
    ('d04da598-d472-4521-99ff-5609403bac44'),
    ('7d6f3d3b-e4bf-40a7-9d15-7a82e63d00ee'),
    ('4f52c049-9d33-4065-971a-cff9d6c6004a'),
    ('b7de8289-604e-493d-811c-2f796b77d81d'),
    ('a8556857-8404-477c-8595-6301f25074a2'),
    ('1e361036-5757-4184-81b2-95c4314a3f92'),
    ('8cc23002-adfc-4a90-a3b1-e8514085034b'),
    ('645f6cc7-fe07-443e-8ea2-5c13c7d04017'),
    ('22dfe2e4-086f-4845-a5c0-c86c2889f973'),
    ('eb5a947c-af12-4f2c-851f-473838219815'),
    ('57a417c5-312a-40dc-a093-ea30176e2f5c'),
    ('69076c4b-d417-49ed-a4eb-cf87358fc8ae'),
    ('1ddfeba4-5e50-4880-994b-b0a5c8bb5824'),
    ('abff41cd-dfee-4d72-82aa-8994b94f1075'),
    ('98d82974-381f-4fc9-86d7-44005c2de25c'),
    ('e3ef32fd-0d93-4469-a249-392b408fff84');

DO $pre$
DECLARE
  v_n integer;
  v_mis integer;
BEGIN
  IF extract(minute FROM clock_timestamp()) >= 50 OR extract(minute FROM clock_timestamp()) < 3 THEN
    RAISE EXCEPTION 'inside the :50-:03 window';
  END IF;

  -- still RUNNING, still two or more funded players, still no table holding two
  SELECT count(*) INTO v_n
    FROM one_seat_events s JOIN public.tournaments t ON t.id = s.id
   WHERE t.status = 'RUNNING'
     AND (SELECT count(*) FROM public.tournament_players x
           WHERE x.tournament_id = t.id AND x.status = 'playing') >= 2
     AND NOT EXISTS (
       SELECT 1 FROM public.tables tb
         JOIN public.table_seats ts ON ts.table_id = tb.id AND ts.left_at IS NULL
        WHERE tb.tournament_id = t.id AND tb.status IN ('running', 'waiting')
        GROUP BY tb.id HAVING count(*) >= 2);
  IF v_n <> 57 THEN
    RAISE EXCEPTION 'expected 57 one-seat events, found % (re-run the sweep query and adjust)', v_n;
  END IF;

  -- no listed event may still hold a paid-range standing out of true bust order
  WITH ev AS (
    SELECT t.id,
           (SELECT count(*) FROM public.tournament_players x
             WHERE x.tournament_id = t.id AND x.status IN ('playing', 'winner')) AS playing,
           jsonb_array_length(t.payout_structure::jsonb) AS paid
      FROM public.tournaments t JOIN one_seat_events s ON s.id = t.id
  ), kc AS (
    SELECT DISTINCT ON (k.tournament_id, k.eliminated_user_id)
           k.tournament_id, k.eliminated_user_id, k.stack_before, h.committed_at
      FROM public.tournament_knockout_candidates k
      JOIN ev ON ev.id = k.tournament_id
      LEFT JOIN public.hand_atomic_commits h ON h.hand_number = k.hand_number
     WHERE k.state = 'eliminated'
     ORDER BY k.tournament_id, k.eliminated_user_id, k.hand_number DESC, k.created_at DESC
  ), pl AS (
    SELECT tp.tournament_id, ev.paid,
           ev.playing + row_number() OVER w_seq AS seq_pos,
           ev.playing + rank() OVER w_true AS true_lo,
           count(*) OVER (PARTITION BY tp.tournament_id, kc.committed_at, kc.stack_before) AS tie_n
      FROM public.tournament_players tp
      JOIN ev ON ev.id = tp.tournament_id
      LEFT JOIN kc ON kc.tournament_id = tp.tournament_id AND kc.eliminated_user_id = tp.user_id
     WHERE tp.status = 'eliminated'
    WINDOW w_seq AS (PARTITION BY tp.tournament_id ORDER BY tp.elimination_sequence DESC NULLS LAST),
           w_true AS (PARTITION BY tp.tournament_id ORDER BY kc.committed_at DESC NULLS LAST,
                                                           kc.stack_before DESC NULLS LAST)
  )
  SELECT count(*) INTO v_mis FROM pl
   WHERE (seq_pos < true_lo OR seq_pos > true_lo + tie_n - 1)
     AND (seq_pos <= paid OR true_lo <= paid);
  IF v_mis <> 0 THEN
    RAISE EXCEPTION '% paid-range standing(s) still out of true bust order - re-sequence first', v_mis;
  END IF;
END
$pre$;

DO $write$
DECLARE v_n integer;
BEGIN
  SELECT count(public.fn_emit_tournament_manager_wake(s.id, 'bounty_settled'))
    INTO v_n FROM one_seat_events s;
  IF v_n <> 57 THEN RAISE EXCEPTION 'expected 57 wakes, emitted %', v_n; END IF;
END
$write$;

COMMIT;

-- AFTER (read-only): within ~1 minute every wake is consumed
--   select count(*) from tournament_manager_wakes where reason = 'bounty_settled'
--      and consumed_at is null and created_at > now() - interval '10 minutes';   -- 0
-- and the one-seat query shrinks as "[Tournament:xxxxxxxx] Breaking table ..."
-- lines appear for these ids; a 43-table field needs ~40 passes at 5 s.
