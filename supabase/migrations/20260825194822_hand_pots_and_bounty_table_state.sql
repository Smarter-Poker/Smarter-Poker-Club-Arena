-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825194822; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS pots jsonb NULL;

COMMENT ON COLUMN public.hand_history.pots IS
  'Pot-level settlement for this hand: [{index, amount, eligible[]}] in pot order (0 = main). Written by ServerTableEngineSettlement from the engine''s own calculatePots() snapshot. NULL on rows written before 2026-08-25. Read by attributeKnockout() to credit a knockout to the winner(s) of the pot that held the busted player''s last chips (Dan section 29).';

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
  'Dan section 57 - the mystery bounty awards still open at one table, for a client that reconnected mid-reveal. Withholds amount_cents while the award is still reserved (section 19).';

GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_table_state(uuid) TO authenticated, service_role;
