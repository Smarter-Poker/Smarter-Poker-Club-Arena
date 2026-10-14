-- 20261012063036_the_mini_jackpot_names_its_bad_beat_holder.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG
--
-- D1. Every Mini Bad Beat Jackpot was SHOWN with its two players swapped.
--     The money was always right. bbj_atomic_payout_v2 (the main jackpot)
--     stores bbj_payouts.winner_user_id = the bad-beat holder (the player who
--     LOST the hand and takes 50%) and loser_user_id = the hand winner (25%).
--     fn_bbj_mini_payout stores it the other way round: winner_user_id = the
--     hand winner, loser_user_id = the bad-beat holder, and its bbj_winners
--     row follows suit (winner_id / winner_display_name = the hand winner).
--     Verified on production 2026-10-12: in 112 of 112 minis the 50% share
--     went to loser_user_id. Both readers assumed the main shape:
--       fn_bbj_recent_hits   - bad_beat_* columns, the recipients 'role' labels
--       fn_bbj_hand_detail   - jackpot.badBeatUserId / handWinnerUserId, the
--                              recipients 'role' labels, and the pruned-hand
--                              branch's names read from bbj_winners
--     so payout 559c6366-9388-4273-a81e-2a151aef8036 named SlyViking (the hand
--     winner, A8, 175.00) as the jackpot winner and sam1982 (the K7 bad-beat
--     holder, 349.98) as the hand winner.
--
-- D2. bbj_winners.winner_hand / loser_hand were NULL on 112 of 112 minis,
--     because fn_bbj_mini_payout never wrote them. The engine always sent the
--     names in the payout metadata: 'loser_hand' = the bad-beat holder's hand,
--     'winner_hand' = the hand winner's (verified on all 112; they agree with
--     the main-convention 'winner_hand_name' / 'loser_hand_name' copies).
--
-- THE FIX (root, not a sweep)
--
--   1. Both readers become kind-aware: bad-beat holder = CASE WHEN
--      COALESCE(kind,'main') = 'mini' THEN loser_user_id ELSE winner_user_id
--      END, the hand winner the reverse, applied to the ids, names, hands,
--      amounts, cards, role labels and the pruned-hand branch. For a mini
--      whose bbj_winners row has no hand name they fall back to the payout
--      metadata, so every historical mini shows its hands. Main rows read
--      exactly what they read before (verified: identical output for main
--      payout 5dbdd309-ea1a-42f0-b74a-013d96c2d5da).
--   2. fn_bbj_mini_payout's bbj_winners INSERT now writes winner_hand /
--      loser_hand (in the mini's own convention: winner_hand = the hand
--      winner's). That INSERT's column list and values are the ONLY change;
--      locking, idempotency, refusals, allocation and every credit are
--      byte-identical. Its stored winner/loser convention is NOT changed.
--
-- NO PAYOUT ROW IS CHANGED. This migration contains no INSERT, UPDATE or
-- DELETE against any table: not one amount, recipient or row of bbj_payouts,
-- bbj_payout_recipients, bbj_winners or any wallet moves. Past payouts stay
-- exactly as paid (owner ruling 2026-10-11).
--
-- SAFETY. Each function's live definition, owner and grants are asserted
-- against what was read on 2026-10-12 before it is replaced, so a definition
-- that moved since aborts the whole transaction instead of being overwritten.
-- After replacement the new definitions and the unchanged grants are asserted
-- again. CREATE OR REPLACE keeps signature, return shape, SECURITY DEFINER,
-- search_path, owner and ACL. One transaction, one schema-cache reload
-- (CLAUDE.md section 2, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The definitions this replaces, exactly as read from production on 2026-10-12.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_recent_hits(uuid,integer,timestamp with time zone,uuid,text)') AND md5(pg_get_functiondef(oid)) = '84cd1e7615912965307ae78a37950e4d' AND pg_get_userbyid(proowner) = 'postgres' AND proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_PRIOR_DEFINITION_CHANGED: %', 'public.fn_bbj_recent_hits(uuid,integer,timestamp with time zone,uuid,text)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_hand_detail(uuid)') AND md5(pg_get_functiondef(oid)) = '9d04f50938f10831d50dcf4137430cfd' AND pg_get_userbyid(proowner) = 'postgres' AND proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_PRIOR_DEFINITION_CHANGED: %', 'public.fn_bbj_hand_detail(uuid)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)') AND md5(pg_get_functiondef(oid)) = '0340a2106dcaae261c08986a235b4410' AND pg_get_userbyid(proowner) = 'postgres' AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_PRIOR_DEFINITION_CHANGED: %', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)';
  END IF;
END
$guard$;

-- fn_bbj_recent_hits: kind-aware bad-beat holder, hand winner and role labels; mini hands fall back to the payout metadata.
CREATE OR REPLACE FUNCTION public.fn_bbj_recent_hits(p_pool_id uuid, p_limit integer DEFAULT 5, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_kind text DEFAULT NULL::text)
 RETURNS TABLE(payout_id uuid, awarded_at timestamp with time zone, hand_number bigint, total_payout numeric, bad_beat_user_id uuid, bad_beat_player_number text, bad_beat_avatar_url text, bad_beat_name text, bad_beat_hand text, bad_beat_amount numeric, bad_beat_cards jsonb, hand_winner_name text, hand_winner_hand text, hand_winner_amount numeric, hand_winner_cards jsonb, board jsonb, game_variant text, small_blind numeric, big_blind numeric, table_player_count integer, recipients jsonb, total_hits integer, kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool_total AS (
    SELECT count(*)::int AS n FROM public.bbj_payouts p
     WHERE p.pool_id = p_pool_id
       AND (p_kind IS NULL OR COALESCE(p.kind, 'main') = p_kind)
  ),
  top_payouts AS (
    SELECT p.* FROM public.bbj_payouts p
    WHERE p.pool_id = p_pool_id
      AND (p_kind IS NULL OR COALESCE(p.kind, 'main') = p_kind)
      AND (
        p_before IS NULL
        OR (p_before_id IS NULL AND p.created_at < p_before)
        OR (p_before_id IS NOT NULL AND (p.created_at, p.id) < (p_before, p_before_id))
      )
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT GREATEST(1, LEAST(p_limit, 25))
  ),
  hits AS (
    SELECT p.*, w.winner_hand, w.loser_hand, w.winner_display_name, w.loser_display_name,
           h.board AS raw_board, h.hole_cards, h.game_variant, h.small_blind, h.big_blind,
           -- WHICH PLAYER IS WHICH DEPENDS ON THE KIND (2026-10-12). The main
           -- payout stores the bad-beat holder as winner_user_id; the mini
           -- stores the hand winner there and the bad-beat holder as
           -- loser_user_id, and its bbj_winners row is the same way round.
           -- The money was always right; only this reader assumed one shape.
           CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN p.loser_user_id ELSE p.winner_user_id END AS bb_user_id,
           CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN p.winner_user_id ELSE p.loser_user_id END AS hw_user_id,
           CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN w.loser_display_name ELSE w.winner_display_name END AS bb_display_name,
           CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN w.winner_display_name ELSE w.loser_display_name END AS hw_display_name,
           -- A mini written before 2026-10-12 has no hand names in bbj_winners;
           -- the engine always sent them in the payout metadata ('loser_hand'
           -- = the bad-beat holder's hand, 'winner_hand' = the hand winner's).
           CASE WHEN COALESCE(p.kind, 'main') = 'mini'
                THEN COALESCE(NULLIF(w.loser_hand, ''), NULLIF(NULLIF(p.metadata->>'loser_hand', ''), 'Unknown'))
                ELSE w.winner_hand END AS bb_hand,
           CASE WHEN COALESCE(p.kind, 'main') = 'mini'
                THEN COALESCE(NULLIF(w.winner_hand, ''), NULLIF(NULLIF(p.metadata->>'winner_hand', ''), 'Unknown'))
                ELSE w.loser_hand END AS hw_hand
    FROM top_payouts p
    LEFT JOIN public.bbj_winners w ON w.table_id = p.table_id AND w.hand_number = p.hand_number
    LEFT JOIN public.hand_history h ON h.table_id = p.table_id AND h.hand_number = p.hand_number
  )
  SELECT
    x.id,
    x.created_at,
    x.hand_number,
    x.total_amount,
    x.bb_user_id,
    bb.player_number::text,
    -- THE CLUB AVATAR. profiles.arena_avatar_url is Club Arena's own column
    -- (library art); profiles.avatar_url is the social media photo and is not
    -- ours to display. No fallback to it, exactly as the felt does it - an
    -- unset arena avatar draws the generated monogram client-side instead.
    NULLIF(bb.arena_avatar_url, ''),
    COALESCE(public.fn_arena_name(bb.alias, bb.username, bb.display_name, bb.first_name, bb.last_name, bb.full_name), x.bb_display_name, 'Player'),
    x.bb_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.bb_user_id),
    x.hole_cards -> (x.bb_user_id::text),
    COALESCE(public.fn_arena_name(hw.alias, hw.username, hw.display_name, hw.first_name, hw.last_name, hw.full_name), x.hw_display_name, 'Player'),
    x.hw_hand,
    (SELECT r.amount FROM public.bbj_payout_recipients r
      WHERE r.payout_id = x.id AND r.user_id = x.hw_user_id),
    x.hole_cards -> (x.hw_user_id::text),
    CASE
      WHEN jsonb_typeof(x.raw_board) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(
                 jsonb_build_object(
                   'rank', regexp_replace(card, '(hearts|diamonds|clubs|spades)$', ''),
                   'suit', substring(card from '(hearts|diamonds|clubs|spades)$')
                 ) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements_text(x.raw_board) WITH ORDINALITY AS arr(card, ord)
        WHERE substring(card from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      )
      ELSE '[]'::jsonb
    END,
    x.game_variant,
    x.small_blind,
    x.big_blind,
    x.table_player_count,
    COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'name', COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, 'Player'),
                 'amount', r.amount,
                 'role', CASE
                           WHEN r.user_id = x.bb_user_id THEN 'bad_beat'
                           WHEN r.user_id = x.hw_user_id THEN 'hand_winner'
                           ELSE 'table'
                         END
               ) ORDER BY r.amount DESC)
      FROM public.bbj_payout_recipients r
      LEFT JOIN public.profiles pr ON pr.id = r.user_id
      WHERE r.payout_id = x.id
    ), '[]'::jsonb),
    (SELECT n FROM pool_total),
    COALESCE(x.kind, 'main')
  FROM hits x
  LEFT JOIN public.profiles bb ON bb.id = x.bb_user_id
  LEFT JOIN public.profiles hw ON hw.id = x.hw_user_id
  ORDER BY x.created_at DESC, x.id DESC;
$function$;

-- fn_bbj_hand_detail: kind-aware badBeatUserId / handWinnerUserId, role labels and pruned-hand names and hands.
CREATE OR REPLACE FUNCTION public.fn_bbj_hand_detail(p_payout_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- WHICH PLAYER IS WHICH DEPENDS ON THE KIND (2026-10-12). The main payout
  -- stores the bad-beat holder as winner_user_id; the mini stores the hand
  -- winner there and the bad-beat holder as loser_user_id, and its bbj_winners
  -- row is the same way round. bb_user_id / hw_user_id say it once.
  WITH pay AS (SELECT p.*,
                      CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN p.loser_user_id ELSE p.winner_user_id END AS bb_user_id,
                      CASE WHEN COALESCE(p.kind, 'main') = 'mini' THEN p.winner_user_id ELSE p.loser_user_id END AS hw_user_id
                 FROM public.bbj_payouts p WHERE p.id = p_payout_id),
  hh AS (
    SELECT h.* FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC LIMIT 1
  ),
  win AS (
    SELECT w.* FROM public.bbj_winners w
    JOIN pay ON w.table_id = pay.table_id AND w.hand_number = pay.hand_number
    LIMIT 1
  ),
  seats AS (
    SELECT e.value AS p FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          -- The CLUB avatar. profiles.avatar_url is the social media photo and
          -- is not Club Arena's to display.
          'avatarUrl',    NULLIF(pr.arena_avatar_url, ''),
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards',        COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh), 'null'::jsonb)
        ) ORDER BY NULLIF(s.p->>'seat', '')::int), '[]'::jsonb) AS v
    FROM seats s LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                 'suit', substring(c from '(hearts|diamonds|clubs|spades)$')) ORDER BY ord)
        FROM unnest((SELECT community_cards FROM hh)) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      ), '[]'::jsonb)
    END AS v
  ),
  extra_boards AS (
    SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb) AS v
    FROM (
      SELECT e.value AS b, e.ordinality AS ord
      FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.rit_boards, '[]'::jsonb))
                       WITH ORDINALITY e(value, ordinality)
      UNION ALL
      SELECT to_jsonb(hh.community_cards2), 1000
      FROM hh WHERE hh.community_cards2 IS NOT NULL
                AND array_length(hh.community_cards2, 1) > 0
    ) t
  ),
  recips AS (
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'userId', r.user_id,
               'name',   COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, 'Player'),
               -- The summary card has no seat roster to look a number up in,
               -- so it travels with the recipient.
               'playerNumber', pr.player_number::text,
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT bb_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT hw_user_id FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM public.bbj_payout_recipients r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id
    WHERE r.payout_id = p_payout_id
  ),
  jackpot AS (
    SELECT jsonb_build_object(
             'payoutId',         p_payout_id,
             -- 2026-09-11: which jackpot this was. A mini hand opened looking
             -- exactly like a main one; the row always knew.
             'kind',             COALESCE((SELECT kind FROM pay), 'main'),
             'total',            (SELECT total_amount FROM pay),
             'badBeatUserId',    (SELECT bb_user_id FROM pay),
             'handWinnerUserId', (SELECT hw_user_id FROM pay),
             'recipients',       (SELECT v FROM recips)) AS v
  )
  SELECT CASE
    -- No such payout. A genuine nothing, and still a NULL.
    WHEN (SELECT count(*) FROM pay) = 0 THEN NULL

    -- THE HAND IS GONE. Everything the payout ledger knows, and an honest flag
    -- saying the street-by-street part is not coming.
    WHEN (SELECT count(*) FROM hh) = 0 THEN jsonb_build_object(
      'handAvailable', false,
      'kind',          COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',    (SELECT hand_number FROM pay),
      'playedAt',      (SELECT created_at FROM pay),
      'gameVariant',   NULL,
      'tablePlayerCount', (SELECT table_player_count FROM pay),
      -- bbj_winners names the two hands. On a MAIN row "winner" is the
      -- winner OF THE JACKPOT (the bad-beat holder, who LOST the hand). On a
      -- MINI row it is the other way round: "winner" is the hand winner and
      -- "loser" the bad-beat holder. A mini written before 2026-10-12 has no
      -- hand names there, so its hands come from the payout metadata
      -- ('loser_hand' = bad-beat holder, 'winner_hand' = hand winner).
      'badBeatName',   (SELECT COALESCE(NULLIF(CASE WHEN COALESCE(pay.kind, 'main') = 'mini' THEN w.loser_display_name ELSE w.winner_display_name END,''), 'Player') FROM win w CROSS JOIN pay),
      'badBeatHand',   (SELECT CASE WHEN COALESCE(pay.kind, 'main') = 'mini'
                                    THEN COALESCE((SELECT NULLIF(NULLIF(w.loser_hand, ''), 'Unknown') FROM win w), NULLIF(NULLIF(pay.metadata->>'loser_hand', ''), 'Unknown'))
                                    ELSE (SELECT NULLIF(w.winner_hand, 'Unknown') FROM win w) END FROM pay),
      'handWinnerName',(SELECT COALESCE(NULLIF(CASE WHEN COALESCE(pay.kind, 'main') = 'mini' THEN w.winner_display_name ELSE w.loser_display_name END,''), 'Player') FROM win w CROSS JOIN pay),
      'handWinnerHand',(SELECT CASE WHEN COALESCE(pay.kind, 'main') = 'mini'
                                    THEN COALESCE((SELECT NULLIF(NULLIF(w.winner_hand, ''), 'Unknown') FROM win w), NULLIF(NULLIF(pay.metadata->>'winner_hand', ''), 'Unknown'))
                                    ELSE (SELECT NULLIF(w.loser_hand, 'Unknown') FROM win w) END FROM pay),
      'poolAtHit',     (SELECT pool_amount_at_hit FROM win),
      'jackpot',       (SELECT v FROM jackpot)
    )

    ELSE jsonb_build_object(
      'handAvailable', true,
      'kind',        COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',  (SELECT hand_number FROM hh),
      'playedAt',    COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant', (SELECT game_variant FROM hh),
      'smallBlind',  (SELECT small_blind FROM hh),
      'bigBlind',    (SELECT big_blind FROM hh),
      'potSize',     (SELECT pot_size FROM hh),
      'rakeAmount',  (SELECT rake_amount FROM hh),
      'bbjAmount',   (SELECT bbj_amount FROM hh),
      'buttonSeat',  (SELECT button_seat FROM hh),
      'board',       (SELECT v FROM board_out),
      'extraBoards', (SELECT v FROM extra_boards),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'showdown',    (SELECT COALESCE(showdown, '[]'::jsonb) FROM hh),
      'pots',        (SELECT COALESCE(pots, '[]'::jsonb) FROM hh),
      'jackpot',     (SELECT v FROM jackpot)
    )
  END;
$function$;

-- fn_bbj_mini_payout: the bbj_winners INSERT writes winner_hand / loser_hand. Nothing else changes.
CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_tier_id text, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, refused text, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, backup_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_backup numeric; v_floor numeric; v_amount numeric; v_enabled boolean;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric; v_per numeric;
  v_payout_id uuid; v_existing uuid; v_table_ids uuid[]; v_n_table integer;
  v_club_id uuid; v_uid uuid; v_remainder numeric; v_hand_id uuid;
  v_loser_name text; v_winner_name text; v_pending record;
  v_pool_mini_enabled boolean;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout is service only' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
              WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  IF p_pool_id IS NULL OR p_table_id IS NULL OR p_hand_number IS NULL
     OR p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'mini jackpot requires a hand and two distinct recipients'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(backup_balance,0), COALESCE(mini_reserve_floor, 0), club_id,
         COALESCE(mini_enabled, true)
    INTO v_backup, v_floor, v_club_id, v_pool_mini_enabled
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pool_not_found'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* IDEMPOTENT ON THE HAND, and BEFORE the switch is tested: a club that turns
     its mini off after a hit was queued must still have that hit's parked
     shares settled. The switch decides whether a NEW mini is owed, never
     whether an owed one is paid. */
  SELECT id INTO v_existing FROM public.bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share, bp.table_player_count
      INTO v_total, v_loser, v_winner, v_table, v_n_table
      FROM public.bbj_payouts bp WHERE bp.id = v_existing;
    FOR v_pending IN SELECT u.user_id,u.amount FROM public.bbj_unclaimed_shares u
      WHERE u.payout_id=v_existing AND u.paid_at IS NULL ORDER BY u.user_id
    LOOP
      PERFORM public.bbj_credit_one_recipient(v_existing,p_table_id,v_pending.user_id,v_pending.amount,
        EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id
          AND s.user_id=v_pending.user_id AND s.left_at IS NULL));
    END LOOP;
    SELECT COALESCE(backup_balance,0) INTO v_backup FROM public.bbj_pools WHERE id = p_pool_id;
    RETURN QUERY SELECT false, true, NULL::text, v_existing, v_total, v_loser, v_winner,
      v_table, CASE WHEN v_n_table > 0 THEN v_table / v_n_table ELSE 0::numeric END, v_backup;
    RETURN;
  END IF;

  /* THE CLUB'S OWN SWITCH (Dan 2026-09-11). Read from the row locked above, so
     it cannot change between this test and the debit below. A refusal here is
     recorded as a near miss by the engine, exactly like the floor refusal. */
  IF NOT v_pool_mini_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_club'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT amount, enabled INTO v_amount, v_enabled
    FROM public.bbj_mini_tiers WHERE tier_id = p_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'no_mini_amount_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  IF v_backup - public.fn_bbj_parked_reserve(p_pool_id,'backup') - v_amount < v_floor THEN
    RETURN QUERY SELECT false, false, 'reserve_at_floor'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x IS NOT NULL AND x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  v_total  := round(v_amount, 2);
  v_loser  := round(v_total * 0.50, 2);
  v_winner := round(v_total * 0.25, 2);
  v_table  := round(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := round(v_table / v_n_table, 2);
    v_remainder := v_table - v_per * v_n_table;
    v_loser := v_loser + v_remainder;
    v_table := v_per * v_n_table;
  ELSE
    v_per := 0;
    v_loser := round(v_loser + v_table, 2);
    v_table := 0;
  END IF;

  IF v_loser < 0 OR v_winner < 0 OR v_table < 0
     OR v_loser + v_winner + v_table <> v_total THEN
    RAISE EXCEPTION 'mini jackpot allocation does not conserve its funded total';
  END IF;

  SELECT id INTO v_hand_id FROM public.hand_history
   WHERE table_id = p_table_id AND hand_number = p_hand_number
   ORDER BY created_at DESC LIMIT 1;

  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);
  UPDATE public.bbj_pools
     SET backup_balance = GREATEST(0, COALESCE(backup_balance,0) - v_total),
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = now()
   WHERE id = p_pool_id
   RETURNING COALESCE(backup_balance,0) INTO v_backup;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count, kind, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,
          v_total, v_winner, v_loser, v_table, v_n_table, 'mini',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('tier_id', p_tier_id, 'funded_from', 'backup_reserve'))
  RETURNING id INTO v_payout_id;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser,
            p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner,
            p_winner_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  IF v_n_table > 0 AND v_per > 0 THEN
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per,
                v_uid = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END LOOP;

  END IF;

  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_loser_name FROM public.profiles pr WHERE pr.id = p_loser_user_id;
  SELECT COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name),
                  pr.username, 'Player')
    INTO v_winner_name FROM public.profiles pr WHERE pr.id = p_winner_user_id;

  INSERT INTO public.bbj_winners
    (club_id, pool_id, loser_id, winner_id, loser_payout, winner_payout,
     table_share_payout, total_payout, pool_amount_at_hit, stakes_tier,
     table_id, hand_number, awarded_at, winner_display_name, loser_display_name, kind,
     winner_hand, loser_hand)
  VALUES (v_club_id, p_pool_id, p_loser_user_id, p_winner_user_id, v_loser, v_winner,
          v_table, v_total, v_backup + v_total, p_tier_id,
          p_table_id, p_hand_number, now(), v_winner_name, v_loser_name, 'mini',
          NULLIF(p_metadata->>'winner_hand', ''), NULLIF(p_metadata->>'loser_hand', ''))
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;

  RETURN QUERY SELECT true, false, NULL::text, v_payout_id, v_total, v_loser, v_winner,
    v_table, v_per, v_backup;
END;
$function$;

-- The new definitions are exactly the ones above, and the grants did not move.
-- THE GRANTS, STATED (no-ops against the live ACLs the guard above pinned).
-- CREATE OR REPLACE keeps a function's ACL, and none of these three has ever
-- been executable by PUBLIC or anon: the two readers serve logged-in players,
-- the payout serves the engine. Saying so here is what lets
-- check-definer-authorization read it from this file.
REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamp with time zone, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamp with time zone, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_hand_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_hand_detail(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) TO service_role;

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_recent_hits(uuid,integer,timestamp with time zone,uuid,text)') AND md5(pg_get_functiondef(oid)) = '23ecd89556294aad22f4b273f6ba697c' AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_NEW_DEFINITION_NOT_IN_FORCE: %', 'public.fn_bbj_recent_hits(uuid,integer,timestamp with time zone,uuid,text)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_hand_detail(uuid)') AND md5(pg_get_functiondef(oid)) = '56aab3f69613b3a3ecac43014fb3945e' AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_NEW_DEFINITION_NOT_IN_FORCE: %', 'public.fn_bbj_hand_detail(uuid)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)') AND md5(pg_get_functiondef(oid)) = '27dff9938352bd684fecbb23234f39e9' AND pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION 'BBJ_MINI_DISPLAY_NEW_DEFINITION_NOT_IN_FORCE: %', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)';
  END IF;
END
$check$;

COMMIT;
