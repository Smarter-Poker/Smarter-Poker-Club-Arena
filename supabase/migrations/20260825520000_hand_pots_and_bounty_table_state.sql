-- ═══════════════════════════════════════════════════════════════════════════
--  KNOCKOUT ATTRIBUTION NEEDS THE POTS, AND A RECONNECT NEEDS THE OPEN AWARD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- TWO THINGS, BOTH OF THEM MISSING DATA RATHER THAN MISSING LOGIC.
--
-- 1. `hand_history.pots`
--
--    Dan section 29: the bounty belongs to the winner(s) of THE POT THAT
--    CONTAINED THE ELIMINATED PLAYER'S FINAL TOURNAMENT CHIPS — not to
--    whoever won the most money in the hand.
--
--    The engine has always known this. `calculatePots()` returns
--    `{ amount, eligiblePlayers }` per pot, and every Winner already carries
--    the `potIndex` it came from. Both were thrown away at the write:
--    hand_history stored `winners` and nothing about the pots they came out
--    of, so the elimination sweep — which reconstructs the knockout from
--    hand_history and nothing else — had no way to ask which pot held the
--    busted player's chips. It sorted the winners by amount and took the
--    largest, which is the right answer only when there are no side pots.
--
--    The failure is not theoretical and it is not small. A short stack all in
--    for 300 against two players who then build a 12,000 side pot busts to
--    whoever wins the MAIN pot; the side-pot winner took forty times more
--    money and, under the old rule, took the bounty as well. In a mystery
--    event that is an entire chest handed to a player who did not make the
--    knockout.
--
--    Shape, one object per pot, in pot order:
--        [{ "index": 0, "amount": 900, "eligible": ["<uuid>", ...] }, ...]
--
--    Nullable, and null on every historical row. `attributeKnockout()` falls
--    back to the old largest-winner heuristic when it is absent, so the two
--    million rows already stored keep behaving exactly as they do today.
--
-- 2. `fn_mystery_bounty_table_state(p_table_id)`
--
--    Dan section 57: a player who reconnects during pending / waiting / reveal
--    is shown the CURRENT state from the server. Never a re-roll, never a
--    re-pay, never a restarted hand.
--
--    The three bounty tables have RLS on with no SELECT policy — deliberately,
--    because `tournament_bounty_awards.amount_cents` is the number the whole
--    feature exists to keep hidden until the chest opens (section 19). So a
--    reconnecting client cannot read its own pending award, and every existing
--    reader RPC (`fn_mystery_bounty_awards`) filters to
--    `status IN ('revealed','paid','completed')` — by design, since that one
--    feeds the results list.
--
--    This function is the missing half: the OPEN awards at one table, and it
--    withholds `amount_cents` for as long as the award is still `reserved`.
--    A reconnecting spectator gets the chest, the queue counter and the
--    deadline; the amount arrives the same way it does for everyone else, out
--    of `fn_mystery_bounty_reveal`.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. POT-LEVEL SETTLEMENT ON THE HAND
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS pots jsonb NULL;

COMMENT ON COLUMN public.hand_history.pots IS
  'Pot-level settlement for this hand: [{index, amount, eligible[]}] in pot order (0 = main). '
  'Written by ServerTableEngineSettlement from the engine''s own calculatePots() snapshot. '
  'NULL on rows written before 2026-08-25. Read by attributeKnockout() to credit a knockout to '
  'the winner(s) of the pot that held the busted player''s last chips (Dan section 29).';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. THE OPEN AWARDS AT ONE TABLE — RECONNECT / SPECTATOR RESTORE
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_table_state(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'table_id', p_table_id,
    'open', COALESCE((
      SELECT jsonb_agg(row_to_json(r) ORDER BY r.reserved_at)
        FROM (
          SELECT a.id            AS award_id,
                 a.status,
                 a.tournament_id,
                 a.reserved_at,
                 a.reveal_deadline_at,
                 -- SECTION 19. A reserved chest has not been opened, so its
                 -- value does not leave the database. Only once the award is
                 -- 'revealed' (or beyond) does the number become public — at
                 -- which point the whole table has already seen it.
                 CASE WHEN a.status = 'reserved' THEN NULL ELSE a.amount_cents END AS amount_cents,
                 CASE WHEN a.status = 'reserved' THEN NULL ELSE a.tier END          AS tier,
                 CASE WHEN a.status = 'reserved' THEN NULL ELSE a.tier = 'jackpot' END AS is_jackpot,
                 jsonb_build_object(
                   'user_id', a.eliminated_user_id,
                   'username', COALESCE(tp.username, 'Player')) AS eliminated,
                 (SELECT rc.user_id
                    FROM public.tournament_bounty_award_recipients rc
                   WHERE rc.award_id = a.id AND rc.is_designated_revealer
                   LIMIT 1) AS designated_revealer,
                 (SELECT COALESCE(tp2.username, 'Player')
                    FROM public.tournament_bounty_award_recipients rc
                    LEFT JOIN public.tournament_players tp2
                      ON tp2.tournament_id = a.tournament_id AND tp2.user_id = rc.user_id
                   WHERE rc.award_id = a.id AND rc.is_designated_revealer
                   LIMIT 1) AS designated_revealer_name,
                 COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                            'user_id', rc.user_id,
                            'username', COALESCE(tp3.username, 'Player'),
                            -- Same rule: no per-recipient share before the
                            -- reveal, because the shares sum to the chest.
                            'amount_cents',
                              CASE WHEN a.status = 'reserved' THEN NULL ELSE rc.amount_cents END)
                          ORDER BY rc.amount_cents DESC, rc.user_id)
                     FROM public.tournament_bounty_award_recipients rc
                     LEFT JOIN public.tournament_players tp3
                       ON tp3.tournament_id = a.tournament_id AND tp3.user_id = rc.user_id
                    WHERE rc.award_id = a.id), '[]'::jsonb) AS recipients
            FROM public.tournament_bounty_awards a
            LEFT JOIN public.tournament_players tp
              ON tp.tournament_id = a.tournament_id AND tp.user_id = a.eliminated_user_id
           WHERE a.table_id = p_table_id
             AND a.status IN ('reserved', 'revealed')
           ORDER BY a.reserved_at
           LIMIT 20
        ) r
    ), '[]'::jsonb));
$function$;

COMMENT ON FUNCTION public.fn_mystery_bounty_table_state(uuid) IS
  'Dan section 57 — the mystery bounty awards still open at one table, for a client that '
  'reconnected mid-reveal. Withholds amount_cents while the award is still reserved (section 19).';

GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_table_state(uuid) TO authenticated, service_role;
