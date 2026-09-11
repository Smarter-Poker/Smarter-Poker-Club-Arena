-- D1 ruling only. The reviewed R2 wake is a separate subsequent operation.
-- Requires the audited invalidation schema and fresh current source pins.
-- No prize, wallet, ledger, obligation, escrow, or other player's chips change.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL timezone='UTC';
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $window$ BEGIN
  IF extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC')>=50
    OR extract(minute FROM clock_timestamp() AT TIME ZONE 'UTC')<3 THEN
    RAISE EXCEPTION 'D1 refuses to run inside the :50-:03 UTC break window';
  END IF;
END $window$;
SELECT public.fn_ca_lock_settlement_lane_global();
SELECT id FROM public.tournaments WHERE id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' FOR UPDATE;
SELECT count(*) FROM (SELECT id FROM public.tournament_players
  WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' ORDER BY id FOR UPDATE) locked;
SELECT id FROM public.tournament_knockout_candidates
  WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'
    AND eliminated_user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'
  ORDER BY hand_number,id FOR UPDATE;
DO $pre$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'
    AND status='RUNNING' AND prize_pool=204.40 AND prize_pool_finalized
    AND NOT is_bounty AND NOT is_pko AND NOT is_mystery_bounty)
    OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d')<>385
    OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' AND status='playing')<>4
    OR NOT EXISTS(SELECT 1 FROM public.tournament_players
      WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'
        AND user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'
        AND status='eliminated' AND chips=0 AND rebuys=0 AND position=12 AND prize=4.68
        AND elimination_sequence=21794 AND eliminated_at='2026-09-10 12:49:51.282399+00') THEN
    RAISE EXCEPTION 'D1 current event/player snapshot changed; reconcile before ruling';
  END IF;
  IF (SELECT count(*) FROM public.tournament_knockout_candidates
      WHERE tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d'
        AND eliminated_user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a')<>2
    OR NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k JOIN public.hand_atomic_commits a
      ON a.table_id=k.table_id AND a.hand_number=k.hand_number AND a.hand_id=k.hand_id
      WHERE k.id='266af3b0-7791-4681-8e49-752a62deeb45' AND k.state='rebought'
        AND k.hand_number=8775892 AND k.hand_id='836f5a38-f2ed-41a7-810c-ec122748a13c'
        AND k.seat_id='59841fb4-0f0b-4ef1-8623-e7bd3e228636'
        AND k.seat_joined_at='2026-09-09 22:34:25.081124+00'
        AND a.committed_at='2026-09-09 22:35:09.777892+00')
    OR NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates k JOIN public.hand_atomic_commits a
      ON a.table_id=k.table_id AND a.hand_number=k.hand_number AND a.hand_id=k.hand_id
      WHERE k.id='bea72c06-dde6-4d97-b3d5-dd003627a676' AND k.state='eliminated'
        AND k.hand_number=8803695 AND k.hand_id='9b6e5be9-d990-4916-ba7d-b76a6fb8094a'
        AND k.seat_id='c198f227-bb3d-42a2-9bf6-81c31f0f01bf'
        AND k.seat_joined_at='2026-09-09 22:40:01.958437+00'
        AND a.committed_at='2026-09-10 02:00:40.822288+00') THEN
    RAISE EXCEPTION 'D1 exact true-bust and invalid repair-generation witnesses changed';
  END IF;
END $pre$;
INSERT INTO public.tournament_knockout_invalidations
  (id,invalid_candidate_id,source_candidate_id,tournament_id,user_id,
   invalid_before,source_before,player_before,invalid_commit,source_commit,reason)
SELECT '566fdb5e-2b18-59e4-9283-5c27a4a9b9e1',bad.id,real_bust.id,p.tournament_id,p.user_id,
  to_jsonb(bad),to_jsonb(real_bust),to_jsonb(p),
  to_jsonb(bad_hand)-ARRAY['post_commit_payload','post_commit_request_hash','post_commit_payload_hash','post_commit_completed_at','post_commit_result'],
  to_jsonb(real_hand)-ARRAY['post_commit_payload','post_commit_request_hash','post_commit_payload_hash','post_commit_completed_at','post_commit_result'],
  'D1 authorized true-bust ruling: tankChamp actually busted in committed hand 8775892 at 2026-09-09 22:35:09.777892 UTC. The later chair generation began at 22:40:01.958437 after a since-deleted repair created 115000 chips; it was not a purchased rebuy. Retain both accepted hands and candidate identities, invalidate only the repair-created generation, and restore the original bust as the ranking witness. Other players keep chips won; no money is clawed back. Normal settlement must place tankChamp 36th for 1.94 and move the 23 intervening true-order finishers up one place.'
FROM public.tournament_knockout_candidates bad
JOIN public.tournament_knockout_candidates real_bust ON real_bust.id='266af3b0-7791-4681-8e49-752a62deeb45'
JOIN public.tournament_players p ON p.tournament_id=bad.tournament_id AND p.user_id=bad.eliminated_user_id
JOIN public.hand_atomic_commits bad_hand ON bad_hand.table_id=bad.table_id AND bad_hand.hand_number=bad.hand_number AND bad_hand.hand_id=bad.hand_id
JOIN public.hand_atomic_commits real_hand ON real_hand.table_id=real_bust.table_id AND real_hand.hand_number=real_bust.hand_number AND real_hand.hand_id=real_bust.hand_id
WHERE bad.id='bea72c06-dde6-4d97-b3d5-dd003627a676';
UPDATE public.tournament_knockout_candidates k
SET state=CASE WHEN k.id=e.invalid_candidate_id THEN 'invalidated' ELSE 'eliminated' END,
  resolved_at=e.created_at
FROM public.tournament_knockout_invalidations e
WHERE e.id='566fdb5e-2b18-59e4-9283-5c27a4a9b9e1'
  AND k.id IN (e.invalid_candidate_id,e.source_candidate_id);
UPDATE public.tournament_players p
SET eliminated_at=(e.source_commit->>'committed_at')::timestamptz
  + (SELECT count(*) FROM public.tournament_knockout_candidates s
       WHERE s.tournament_id=e.tournament_id AND s.table_id=(e.source_before->>'table_id')::uuid
         AND s.hand_id=(e.source_before->>'hand_id')::uuid
         AND s.hand_number=(e.source_before->>'hand_number')::bigint
         AND (s.stack_before,s.eliminated_user_id)<((e.source_before->>'stack_before')::numeric,e.user_id))::integer*interval '1 microsecond'
FROM public.tournament_knockout_invalidations e
WHERE e.id='566fdb5e-2b18-59e4-9283-5c27a4a9b9e1'
  AND p.tournament_id=e.tournament_id AND p.user_id=e.user_id;
SET CONSTRAINTS assert_knockout_invalidation_closed IMMEDIATE;
DO $rank$ DECLARE v_place integer;v_amount numeric; BEGIN
  WITH busts AS (
    SELECT p.user_id,p.id,p.elimination_sequence,
      COALESCE((SELECT COALESCE(a.committed_at,(SELECT min(g.created_at)
        FROM public.tournament_knockout_candidates g WHERE g.tournament_id=k.tournament_id
          AND g.table_id=k.table_id AND g.hand_number=k.hand_number AND g.hand_id=k.hand_id))
        +(SELECT count(*) FROM public.tournament_knockout_candidates s
          WHERE s.tournament_id=k.tournament_id AND s.table_id=k.table_id
            AND s.hand_number=k.hand_number AND s.hand_id=k.hand_id
            AND (s.stack_before,s.eliminated_user_id)<(k.stack_before,k.eliminated_user_id))::integer*interval '1 microsecond'
        FROM (SELECT c.* FROM public.tournament_knockout_candidates c
          WHERE c.tournament_id=p.tournament_id AND c.eliminated_user_id=p.user_id AND c.state='eliminated'
          ORDER BY c.hand_number DESC,c.id DESC LIMIT 1) k
        LEFT JOIN public.hand_atomic_commits a ON a.table_id=k.table_id
          AND a.hand_number=k.hand_number AND a.hand_id=k.hand_id),p.eliminated_at) AS bust_at
    FROM public.tournament_players p
    WHERE p.tournament_id='7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d' AND p.status='eliminated'
  ), ranked AS (
    SELECT user_id,4+row_number() OVER(ORDER BY bust_at DESC,elimination_sequence DESC,id) AS place FROM busts
  ) SELECT place INTO v_place FROM ranked WHERE user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a';
  SELECT amount INTO v_amount FROM public.fn_ca_tournament_place_amounts('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d') WHERE place=v_place;
  IF v_place IS DISTINCT FROM 36 OR v_amount IS DISTINCT FROM 1.94 THEN
    RAISE EXCEPTION 'D1 true-bust projection changed: place %, amount %',v_place,v_amount;
  END IF;
END $rank$;
COMMIT;
