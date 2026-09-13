-- ═══════════════════════════════════════════════════════════════════════════
--  THE NEAR-MISS LOG HAS A READER
--  BBJ programme, post-audit phase 3 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  `bbj_near_misses` was created on 2026-09-07 because the jackpot had paid
--  nothing for seventeen days on record volume and NOTHING IN THIS DATABASE
--  COULD SAY WHETHER THAT WAS THE RULES WORKING OR THE RULES BROKEN - "no
--  qualifying hand occurred" and "a qualifying hand occurred and something
--  refused it" were the same observation. Its own table comment cites
--  CLAUDE.md 10.86 for that.
--
--  10.86 RULE 3 IS "A GUARD MUST HAVE A READER, AND YOU MUST NAME THEM."
--  Four days later the table has three writers - the main near miss, the mini
--  near miss, and `mini_refused:*` from the mini payout - and, measured across
--  the whole tree on 2026-09-11, NOT ONE SELECT. 57 rows have accumulated that
--  nobody on this platform can see. A log written by a detector that cites the
--  reader rule, and then has no reader, is the exact failure that rule names;
--  it is also worse than no log, because the question reads as answered.
--
--  This is the reader. `fn_bbj_near_miss_summary(pool, days)` groups the log
--  by the gate that refused, for one pool, for a club admin of that pool or a
--  platform admin. It lands under `days_since_last_hit` on BBJAdminAnalytics -
--  the number that has been sitting on an operator's screen posing the
--  question with nothing beside it to answer.
--
--  ── THREE THINGS READ FROM THE ROWS, NOT ASSUMED ────────────────────────────
--
--   * THE REASON VOCABULARY IN THE CREATING MIGRATION IS FICTION. The block
--     comment in 20260907201404 lists `pot_below_floor`, `not_enough_dealt`,
--     `no_ace_in_hand`, `both_cards_did_not_play`, `winner_not_strong_enough`.
--     NO WRITER EMITS ANY OF THOSE FIVE. The engine emits, from
--     `RakeConfig.ts`, four main gates - `not_enough_players`, `pot_too_small`,
--     `winner_not_quads`, `both_cards_must_play` - and five mini gates
--     prefixed `mini_`, plus `mini_refused:<reason>` from settlement. All 57
--     live rows carry one of the four main names. A reader built from that
--     comment would have labelled five gates that never fire and had no label
--     for the four that do. The truth goes on the COLUMN, in the database,
--     where the next reader actually looks; the applied file is left alone
--     because its SQL ran and only its prose was wrong.
--
--   * `mini_refused:*` IS NOT A NEAR MISS AND MUST NOT BE COUNTED AS ONE. The
--     other two writers mean "a hand did not clear the bar". This one means a
--     hand DID clear the bar and the platform turned the payout away - reserve
--     at floor, tier disabled, variant not eligible. A player made the hand and
--     was not paid. It is the one row on this table that is an incident, so it
--     comes back under its own `kind` and the panel prints it in its own
--     colour. Nothing has written one yet, which is a fact worth being able to
--     see rather than infer.
--
--   * THE POOL IS DERIVED, NOT RECORDED. The engine writes `club_id`; pools
--     are owned by a club or by a union. This maps exactly the way
--     `fn_bbj_analytics` maps its own authorisation, and the mapping was
--     checked against production before it was written: pool
--     a7a65cfc (club-owned, Deep Stack Society) reaches 30 rows, pool f9806a7f
--     (union-owned, Midway Union, 3 clubs) reaches 27, and 30 + 27 is every
--     row on the table. A club that changes union therefore moves its history
--     between pools. That is the honest behaviour for the question being asked
--     - "why is MY pool not paying", asked of today's clubs - and it is
--     written down here rather than discovered later.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
--  Not a monitor standing in for a fix (10.11, 10.12). It moves no money,
--  gates nothing, schedules nothing, repairs nothing, and no payout can fail
--  because of it. The near-miss log's own writer docstring makes the same
--  declaration for the same reason. It exists so that the strictness of the
--  jackpot rules is a question anyone can answer from rows.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

/* THE TRUE VOCABULARY, ON THE COLUMN. Derived from the writers, not from the
   creating migration's prose - see the header. If a new gate is added to
   `RakeConfig.ts`, this comment and `theNearMissLogHasAReader.law.test.ts`
   are the two places that have to learn about it. */
COMMENT ON COLUMN public.bbj_near_misses.reason IS
  'Which gate refused, exactly as the engine wrote it. Main: not_enough_players, pot_too_small, winner_not_quads, both_cards_must_play. Mini: mini_not_enough_players, mini_pot_too_small, mini_winner_not_quads, mini_loser_below_bar, mini_double_board. And mini_refused:<reason>, which is NOT a near miss - it is a hand that qualified for the mini and was turned away by the payout, so it is an incident rather than a statistic. "unspecified" means a writer passed no reason, which is the thing CLAUDE.md 10.86 forbids.';

CREATE OR REPLACE FUNCTION public.fn_bbj_near_miss_summary(
  p_pool_id uuid,
  p_days    integer DEFAULT 30
)
RETURNS TABLE(
  kind        text,
  reason      text,
  refusals    bigint,
  last_at     timestamptz,
  biggest_pot numeric,
  example     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id  uuid;
  v_union_id uuid;
  v_allowed  boolean := false;
  v_days     integer;
BEGIN
  /* THE CALLER IS NAMED HERE, AT THIS FUNCTION'S OWN SURFACE, rather than one
     call down inside fn_is_club_admin_uid where check-definer-authorization
     cannot see it. On 2026-09-11 that guard refused `fn_bbj_drill_arms` for
     exactly that shape and cited fn_bbj_unclaimed_shares(), which shipped as a
     SECURITY DEFINER set-returning function with no argument and handed every
     unpaid share on the platform to any account that could log in. This one
     takes a pool, so it can be scoped, and says out loud that it read who is
     asking. */
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized: the near-miss log is operator telemetry';
  END IF;

  /* 1..365. An operator asking for a decade of a table indexed on `at DESC`
     gets a year; a caller passing 0 or a negative gets a day rather than an
     empty answer that reads like "nothing was refused". */
  v_days := LEAST(365, GREATEST(1, COALESCE(p_days, 30)));

  SELECT bp.club_id, bp.union_id INTO v_club_id, v_union_id
    FROM public.bbj_pools bp WHERE bp.id = p_pool_id;

  IF v_club_id IS NULL AND v_union_id IS NULL THEN
    RAISE EXCEPTION 'BBJ pool not found';
  END IF;

  /* The same test fn_bbj_analytics applies to the same screen: an admin of the
     owning club, or of ANY club in the owning union. A platform admin sees
     every pool, because the platform admin is who runs the drill and reads the
     arms roster and is the person asking this question across the estate. */
  IF public.fn_is_platform_admin() THEN
    v_allowed := true;
  ELSIF v_club_id IS NOT NULL THEN
    v_allowed := public.fn_is_club_admin_uid(v_club_id);
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.union_id = v_union_id
         AND public.fn_is_club_admin_uid(c.id)
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized: club admin role required for this jackpot pool';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT nm.*
      FROM public.bbj_near_misses nm
     WHERE nm.at > now() - make_interval(days => v_days)
       AND (
             (v_club_id IS NOT NULL AND nm.club_id = v_club_id)
          OR (v_union_id IS NOT NULL AND nm.club_id IN (
                SELECT c.id FROM public.clubs c WHERE c.union_id = v_union_id))
           )
  ),
  classified AS (
    SELECT
      /* Derived from the writers' own prefixes. `mini_refused:` is tested
         FIRST because it also starts with `mini_` and means the opposite. */
      CASE
        WHEN s.reason LIKE 'mini\_refused:%' THEN 'mini_refused'
        WHEN s.reason LIKE 'mini\_%'         THEN 'mini'
        ELSE 'main'
      END AS kind,
      s.reason,
      s.at,
      s.pot_size,
      s.message
    FROM scoped s
  )
  SELECT
    c.kind,
    c.reason,
    COUNT(*)::bigint,
    MAX(c.at),
    COALESCE(MAX(c.pot_size), 0),
    /* The sentence the engine already wrote for a player, from the most
       recent one. Writing a second set of words here would be a second
       vocabulary to keep in step with the first. */
    (ARRAY_AGG(c.message ORDER BY c.at DESC) FILTER (WHERE c.message IS NOT NULL))[1]
  FROM classified c
  GROUP BY c.kind, c.reason
  /* Incidents first, then the commonest gate. An operator reading top-down
     meets a hand that was turned away before a hand that never qualified. */
  ORDER BY (c.kind = 'mini_refused') DESC, COUNT(*) DESC, c.reason;
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) IS
  'Why the jackpot did not pay: the near-miss log grouped by the gate that refused, for one pool, over a window of 1-365 days. For a club admin of that pool (or of any club in its union) and for a platform admin - the caller is read from auth.uid() at this function''s own surface. `kind` separates main from mini, and both from mini_refused, which is a hand that qualified and was turned away rather than one that never qualified. Moves no money and gates nothing.';

REVOKE ALL ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) TO authenticated, service_role;

DO $$
DECLARE
  v_src      text;
  v_n        bigint;
  v_answered boolean := false;
  v_refusal  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_near_miss_summary';

  IF position('auth.uid()' in v_src) = 0 THEN
    RAISE EXCEPTION 'the near-miss reader cannot be shown to know who is asking';
  END IF;
  IF has_function_privilege('anon', 'public.fn_bbj_near_miss_summary(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can read the near-miss log';
  END IF;

  /* THE TABLE ITSELF STAYS SHUT. The reader is the only way in; the 2026-09-07
     revoke must survive this migration. */
  IF has_table_privilege('anon', 'public.bbj_near_misses', 'SELECT')
     OR has_table_privilege('authenticated', 'public.bbj_near_misses', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read the near-miss table directly';
  END IF;

  /* Running as postgres, auth.uid() is null, so the reader must REFUSE -
     proving the gate is a refusal and not decoration.

     THE RAISE THAT REPORTS FAILURE CANNOT LIVE INSIDE THE BLOCK THAT CATCHES
     FAILURE. Written the obvious way, the `EXCEPTION WHEN raise_exception`
     handler swallows this migration's own alarm and the assertion passes
     whatever happens - a check that answers when it cannot tell, which is the
     10.86 shape this whole phase is about. So the outcome is recorded in a
     flag and judged after the handler has finished. */
  BEGIN
    SELECT count(*) INTO v_n
      FROM public.fn_bbj_near_miss_summary('00000000-0000-0000-0000-000000000000'::uuid, 30);
    v_answered := true;
  EXCEPTION
    WHEN OTHERS THEN
      v_refusal := SQLERRM;
  END;

  IF v_answered THEN
    RAISE EXCEPTION 'the near-miss reader answered an unauthenticated caller';
  END IF;

  /* And it refused for the RIGHT reason. The auth test runs before the pool
     lookup, so a caller with no session is turned away as unauthenticated
     rather than being told the pool does not exist - if this ever reports
     "pool not found", the auth gate has moved below the lookup and a signed-out
     caller is being told which pool ids are real. */
  IF v_refusal IS NULL OR position('Not authorized' in v_refusal) = 0 THEN
    RAISE EXCEPTION 'the near-miss reader refused, but not on the authorisation gate: %',
      COALESCE(v_refusal, '(no error captured)');
  END IF;
END $$;

COMMIT;
