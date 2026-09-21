-- 20260921130516_a_frozen_tournament_does_not_resume_on_a_stale_ante.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  A FROZEN TOURNAMENT DOES NOT RESUME ON A STALE ANTE
 *  2026-09-21
 * ===========================================================================
 *
 * WHAT IS ARMED RIGHT NOW. 45 RUNNING tournaments are not dealing: 39 are
 * held on a break that expired at 2026-09-18 22:00:00+00 (~63 hours ago) and
 * 6 own no row in engine_tournament_leases. Between them, 171 live rows in
 * public.tables - 25 tournaments, every one of them past the end of its
 * authored blind structure - store
 *
 *     ante = big_blind        EXACTLY, on every one of the 171
 *
 * against structures that author an ante of 0.120 to 0.1333 x bigBlind. That
 * is 7.5x to 8.33x the authored ante, measured this morning.
 *
 * THE ANTE IS NOT DORMANT. public.tables.ante_enabled is false on all 171,
 * and for a CASH table that would end the matter. It does not here:
 * server/src/engine/ServerTableEngine.ts:174 reads
 *
 *     const on = info.tournament_id ? true : (info.ante_enabled ?? true);
 *
 * and ServerTableEngineDealing.ts:2666 does the same, deliberately, because
 * ante_enabled is false on every one of the estate's table rows and gating a
 * tournament ante on it meant no ante was ever posted. A tournament takes the
 * ante its LEVEL specifies. big_blind_ante_enabled is false on all 171 too,
 * so HandController takes the per-player arm at :536 -
 *
 *     const amount = Math.min(this.config.ante, player.stack);
 *
 * - which has no ceiling of any kind. Every seated player posts a FULL BIG
 * BLIND every hand, and Math.min(ante, stack) blinds a short stack off
 * completely in a single hand. AnteMath.anteOrbitCostBB puts the orbit cost
 * at `ante x seats / bigBlind`: 9 big blinds per orbit at a nine-handed
 * table where the structure authored 1.125.
 *
 * WHY IT HAS NOT COST ANYTHING YET, AND WHY THAT IS ABOUT TO CHANGE. These 25
 * tournaments are frozen, so no hand has been dealt from these rows since
 * 2026-09-18. The stale ante survives BECAUSE the tournament is stuck:
 * fn_publish_tournament_blind_level is the only writer of these columns, it
 * returns ok:false/'paused' while on_break is true, and it cannot be asked to
 * republish a level the tournament is already on (p_next_level<=p_previous_level
 * raises 22023). There is no path by which these rows correct themselves.
 *
 * Both freezes already have merged repairs waiting on a deploy that has been
 * failing for two days (the engine is still on 8825af51):
 *
 *   #4993 6719761a7b  an adopted break that has expired is released, or tried
 *                     again  - TournamentManagerBase.clearPersistedBreak
 *   #5010 a44c565601  a manager that owns nothing is not a manager
 *                     - quarantinedTournamentManagers.ts
 *
 * The instant that deploy lands, both populations are adopted and resume. A
 * manager adopting mid-level does NOT publish a level - resumeLifecycle
 * restarts the level clock from level_started_at and the tables deal from
 * whatever public.tables already holds - so every hand between resume and the
 * next level boundary would be anted at 7.5-8.33x. Unfreezing these events
 * without this migration converts a frozen-tournament problem into a money
 * problem.
 *
 * ORDERING, STATED AS THE PROPERTY THAT MAKES THIS SAFE. This migration
 * touches ONLY rows whose tournament is provably not dealing - on an expired
 * break, or holding no lease. Neither population can deal a hand until an
 * engine process adopts it, and adoption reads public.tables fresh
 * (ServerTableEngineBase.ts:7478 selects `ante` in the table row load). So the
 * correction is strictly ordered BEFORE any resumption, by construction and
 * not by timing: there is no interleaving in which a hand is dealt from a row
 * this migration is about to correct. A row belonging to a tournament that IS
 * dealing is refused outright by the guard below, because changing blinds
 * under live players is the publish path's job and not a migration's.
 *
 * WHAT CORRECT MEANS, TAKEN FROM THE RESOLVER AND NOT INVENTED HERE.
 * fn_resolve_tournament_blinds is finished, verified and NOT TOUCHED. Its
 * mtt_overflow branch already states the rule that these rows predate:
 *
 *     v_ante_ceiling := v_bb * v_anchor_ante / v_anchor_bb;
 *     IF v_ante > v_ante_ceiling THEN v_ante := GREATEST(1,floor(v_ante_ceiling));
 *
 * where the anchor is the last non-break authored level. This migration
 * applies THAT expression, unchanged, to the stored rows, using each table's
 * OWN stored big_blind. Three consequences, each of which is asserted below:
 *
 *   - small_blind, big_blind and stakes are never touched. The level these
 *     players are playing does not change; only the ante comes down to the
 *     share the structure authored.
 *   - it is a CEILING and never a floor. No ante is raised, so no level
 *     becomes more expensive than it is today.
 *   - it is applied ONLY where the resolver would apply it: current_level >=
 *     jsonb_array_length(blind_structure), the `v_index<v_len` test the
 *     resolver uses to return a persisted level verbatim. An authored level's
 *     ante is whatever the structure says and is left alone. Tournament
 *     7c6277e7 sits at level 15 of 30 with ante 200 against big blind 1500;
 *     the resolver returns {"ante":200,"source":"persisted"} for it and this
 *     migration does not select it.
 *
 * A structure that authors a BIG BLIND ANTE (anchor ante >= anchor bigBlind;
 * AnteMath.ts makes `ante >= bigBlind` the engine's type test for one) has a
 * proportion of 1 and is excluded explicitly, exactly as the resolver excludes
 * it. tournaments.big_blind_ante = true is excluded as well. 2,437 live rows
 * legitimately carry ante = big_blind on that basis and none of them is
 * selected.
 *
 * NOT IN SCOPE.
 *   - fn_resolve_tournament_blinds and the small-blind share repair (#5018):
 *     finished and verified, not touched. Every stored small blind in the
 *     selected population is already exactly bigBlind/2, its authored share.
 *   - fn_publish_tournament_blind_level: pinned as a pre-image because the
 *     ordering argument depends on its body, and otherwise unchanged. The
 *     ante > big_blind refusal #5014 added stays the outer bound; this is the
 *     authored-share rule inside it.
 *   - The 2,965 suspect rows on CLOSED tables (748 tournaments). The publish
 *     UPDATE's own status filter excludes them permanently, no hand will ever
 *     be dealt from them, and rewriting settled history is not a defect fix.
 *   - Releasing the break or reclaiming the lease. #4993 and #5010 own those
 *     and are merged; this migration is the precondition that makes their
 *     deploy safe, not a second implementation of them.
 */
--
-- HOW A READER SEES THIS IS LIVE. This migration creates no persistent object:
-- it corrects stored rows, so scripts/ci/check-migrations-are-live.mjs has
-- nothing to look up in the catalogue and the end state is stated as its own
-- proof - no live tournament table past its authored structure stores an ante
-- above the share that structure authored.
-- @live-proof: (SELECT count(*) = 0 FROM public.tables tb JOIN public.tournaments t ON t.id = tb.tournament_id CROSS JOIN LATERAL (SELECT (SELECT e.value FROM jsonb_array_elements(t.blind_structure::jsonb) WITH ORDINALITY AS e(value, ord) WHERE lower(COALESCE(e.value->>'isBreak','false')) <> 'true' ORDER BY e.ord DESC LIMIT 1) AS lvl) a WHERE t.status = 'RUNNING' AND COALESCE(t.big_blind_ante,false) = false AND t.blind_structure IS NOT NULL AND jsonb_typeof(t.blind_structure::jsonb) = 'array' AND COALESCE(t.current_level,0) >= jsonb_array_length(t.blind_structure::jsonb) AND NOT COALESCE(tb.is_deleted,false) AND lower(COALESCE(tb.status::text,'')) NOT IN ('closed','deleted','completed','cancelled','finished') AND tb.ante > 0 AND tb.big_blind > 0 AND a.lvl IS NOT NULL AND COALESCE(CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'bigBlind')::numeric END, CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'big_blind')::numeric END, 0) > COALESCE(CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'ante')::numeric END, 0) AND COALESCE(CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'ante')::numeric END, 0) > 0 AND tb.ante > tb.big_blind * COALESCE(CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'ante')::numeric END, 0) / COALESCE(CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'bigBlind')::numeric END, CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'big_blind')::numeric END, 0) AND tb.ante > GREATEST(1, floor(tb.big_blind * COALESCE(CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'ante')::numeric END, 0) / COALESCE(CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'bigBlind')::numeric END, CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$' THEN (a.lvl->>'big_blind')::numeric END, 0))))
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The two functions this migration reasons from, pinned exactly: definition,
-- body, owner, ACL, search_path, security mode and volatility. NEITHER IS
-- ALTERED. fn_resolve_tournament_blinds supplies the ante-ceiling expression
-- reproduced below, and fn_publish_tournament_blind_level is the sole writer
-- of the columns being corrected - the ordering argument in the header is a
-- statement about its body. If either has moved, the rule this migration
-- replays is not the rule in force and we stop rather than correct rows
-- against a contract we did not read.
DO $pin$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)')
       AND md5(pg_get_functiondef(oid)) = '0e61fee391a67a566d6eb07883d13792'
       AND md5(prosrc) = 'de3ac198f9b883f6bc90ff5d2539e751'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'STALE_ANTE_RESOLVER_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)')
       AND md5(pg_get_functiondef(oid)) = '29dcd44b8e4fcb2d2db60568acd58cba'
       AND md5(prosrc) = '642ae4a87ed5503622dfe7eac5b72737'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'STALE_ANTE_PUBLISHER_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
END $pin$;

DO $mig$
DECLARE
  /* The exact rows this migration inspected and will correct, materialised
     ONCE. Every assertion and both UPDATEs are driven from this same value,
     so the migration cannot correct a row it did not first measure. */
  v_plan jsonb;
  v_state_plan jsonb;
  v_n integer;
  v_rows integer;
  v_bad integer;
BEGIN
  WITH anchor AS (
    SELECT t.id AS tournament_id,
           (SELECT e.value
              FROM jsonb_array_elements(t.blind_structure::jsonb) WITH ORDINALITY AS e(value, ord)
             WHERE lower(COALESCE(e.value->>'isBreak','false')) <> 'true'
             ORDER BY e.ord DESC LIMIT 1) AS lvl
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.big_blind_ante,false) = false
       AND t.blind_structure IS NOT NULL
       AND jsonb_typeof(t.blind_structure::jsonb) = 'array'
       -- The resolver returns a persisted level verbatim while
       -- v_index < v_len. Only past that does the anchor share govern.
       AND COALESCE(t.current_level,0) >= jsonb_array_length(t.blind_structure::jsonb)
       -- PROVABLY NOT DEALING. An expired break, or no engine lease at all.
       AND ( (COALESCE(t.on_break,false) AND t.break_ends_at < now())
          OR NOT EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                          WHERE l.tournament_id = t.id) )
  ), share AS (
    SELECT a.tournament_id,
           COALESCE(
             CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (a.lvl->>'bigBlind')::numeric END,
             CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (a.lvl->>'big_blind')::numeric END,
             0) AS anchor_bb,
           COALESCE(
             CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
                  THEN (a.lvl->>'ante')::numeric END,
             0) AS anchor_ante
      FROM anchor a WHERE a.lvl IS NOT NULL
  ), ceil AS (
    -- anchor_ante >= anchor_bb is a BIG BLIND ANTE. The resolver holds those
    -- at v_bb and so does this: they are not selected at all.
    SELECT tournament_id, anchor_bb, anchor_ante FROM share
     WHERE anchor_bb > 0 AND anchor_ante > 0 AND anchor_ante < anchor_bb
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'table_id', tb.id, 'tournament_id', tb.tournament_id,
           'small_blind', tb.small_blind, 'big_blind', tb.big_blind,
           'stakes', tb.stakes, 'old_ante', tb.ante,
           'new_ante', GREATEST(1, floor(tb.big_blind * c.anchor_ante / c.anchor_bb))
         ) ORDER BY tb.id), '[]'::jsonb)
    INTO v_plan
    FROM public.tables tb
    JOIN ceil c ON c.tournament_id = tb.tournament_id
   WHERE NOT COALESCE(tb.is_deleted,false)
     AND lower(COALESCE(tb.status::text,'')) NOT IN ('closed','deleted','completed','cancelled','finished')
     AND tb.ante > 0 AND tb.big_blind > 0
     -- The resolver's own trigger condition, compared unrounded ...
     AND tb.ante > (tb.big_blind * c.anchor_ante / c.anchor_bb)
     -- ... and, independently, the guarantee that the assigned value is
     -- STRICTLY LOWER than what is stored. A ceiling never raises an ante.
     AND tb.ante > GREATEST(1, floor(tb.big_blind * c.anchor_ante / c.anchor_bb));

  v_n := jsonb_array_length(v_plan);

  -- Measured 2026-09-21 12:5x UTC: 171 rows across 25 tournaments, every
  -- correction between 7.5x and 8.33x. Replay finds nothing and is a no-op;
  -- a population an order of magnitude larger than the one inspected is not
  -- this defect and is refused rather than corrected blind.
  IF v_n > 400 THEN
    RAISE EXCEPTION 'STALE_ANTE_POPULATION_UNRECOGNISED: % rows, inspected 171', v_n
      USING ERRCODE = '55000';
  END IF;

  IF v_n > 0 THEN
    -- Independently re-asserted rather than trusted from the predicate: not
    -- one selected row may belong to a tournament that can deal a hand.
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(v_plan) e
      JOIN public.tournaments t ON t.id = (e->>'tournament_id')::uuid
     WHERE NOT ( (COALESCE(t.on_break,false) AND t.break_ends_at < now())
              OR NOT EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                              WHERE l.tournament_id = t.id) );
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STALE_ANTE_WOULD_TOUCH_A_DEALING_TOURNAMENT: % rows', v_bad
        USING ERRCODE = '55000';
    END IF;

    -- No ante is raised, and none is driven to zero or below one chip.
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_plan) e
     WHERE (e->>'new_ante')::numeric >= (e->>'old_ante')::numeric
        OR (e->>'new_ante')::numeric < 1;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STALE_ANTE_PLAN_WOULD_NOT_LOWER_AN_ANTE: % rows', v_bad
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.tables tb
       SET ante = (e->>'new_ante')::numeric
      FROM jsonb_array_elements(v_plan) e
     WHERE tb.id = (e->>'table_id')::uuid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_n THEN
      RAISE EXCEPTION 'STALE_ANTE_TABLE_WRITE_NOT_ACKNOWLEDGED: % of %', v_rows, v_n
        USING ERRCODE = '55000';
    END IF;

    /* A trigger may suppress or alter a write without raising an SQL error,
       so the surviving row is read back against the plan: the ante is the
       corrected one, and the small blind, the big blind and the stakes string
       are byte-identical to what was measured. */
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(v_plan) e
      JOIN public.tables tb ON tb.id = (e->>'table_id')::uuid
     WHERE tb.ante IS DISTINCT FROM (e->>'new_ante')::numeric
        OR tb.small_blind IS DISTINCT FROM (e->>'small_blind')::numeric
        OR tb.big_blind IS DISTINCT FROM (e->>'big_blind')::numeric
        OR tb.stakes IS DISTINCT FROM (e->>'stakes');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STALE_ANTE_TABLE_POSTIMAGE_REFUSED: % rows', v_bad
        USING ERRCODE = '55000';
    END IF;
  END IF;

  /* The tournament-level durable anchor agrees with the bad table rows on all
     25, so it is corrected in the same transaction and by the same rule, read
     from blind_level_state's own big_blind. A cold reader - the lobby, a
     resumed manager comparing its proposal - must never see the two disagree. */
  WITH anchor AS (
    SELECT t.id AS tournament_id, t.blind_level_state AS st,
           (SELECT e.value
              FROM jsonb_array_elements(t.blind_structure::jsonb) WITH ORDINALITY AS e(value, ord)
             WHERE lower(COALESCE(e.value->>'isBreak','false')) <> 'true'
             ORDER BY e.ord DESC LIMIT 1) AS lvl
      FROM public.tournaments t
     WHERE t.status = 'RUNNING'
       AND COALESCE(t.big_blind_ante,false) = false
       AND t.blind_structure IS NOT NULL
       AND jsonb_typeof(t.blind_structure::jsonb) = 'array'
       AND jsonb_typeof(t.blind_level_state) = 'object'
       AND COALESCE(t.current_level,0) >= jsonb_array_length(t.blind_structure::jsonb)
       AND ( (COALESCE(t.on_break,false) AND t.break_ends_at < now())
          OR NOT EXISTS (SELECT 1 FROM public.engine_tournament_leases l
                          WHERE l.tournament_id = t.id) )
  ), sh AS (
    SELECT a.tournament_id, a.st,
      COALESCE(
        CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
             THEN (a.lvl->>'bigBlind')::numeric END,
        CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
             THEN (a.lvl->>'big_blind')::numeric END, 0) AS anchor_bb,
      COALESCE(
        CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
             THEN (a.lvl->>'ante')::numeric END, 0) AS anchor_ante,
      CASE WHEN COALESCE(a.st->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (a.st->>'big_blind')::numeric END AS state_bb,
      CASE WHEN COALESCE(a.st->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
           THEN (a.st->>'ante')::numeric END AS state_ante
      FROM anchor a WHERE a.lvl IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tournament_id', tournament_id, 'old_ante', state_ante,
           'new_ante', GREATEST(1, floor(state_bb * anchor_ante / anchor_bb))
         ) ORDER BY tournament_id), '[]'::jsonb)
    INTO v_state_plan
    FROM sh
   WHERE anchor_bb > 0 AND anchor_ante > 0 AND anchor_ante < anchor_bb
     AND state_bb > 0 AND state_ante > 0
     AND state_ante > (state_bb * anchor_ante / anchor_bb)
     AND state_ante > GREATEST(1, floor(state_bb * anchor_ante / anchor_bb));

  IF jsonb_array_length(v_state_plan) > 0 THEN
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(v_state_plan) e
     WHERE (e->>'new_ante')::numeric >= (e->>'old_ante')::numeric
        OR (e->>'new_ante')::numeric < 1;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STALE_ANTE_STATE_PLAN_WOULD_NOT_LOWER_AN_ANTE: % rows', v_bad
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.tournaments t
       SET blind_level_state = jsonb_set(t.blind_level_state, '{ante}',
             to_jsonb((e->>'new_ante')::numeric))
      FROM jsonb_array_elements(v_state_plan) e
     WHERE t.id = (e->>'tournament_id')::uuid;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> jsonb_array_length(v_state_plan) THEN
      RAISE EXCEPTION 'STALE_ANTE_STATE_WRITE_NOT_ACKNOWLEDGED: % of %',
        v_rows, jsonb_array_length(v_state_plan) USING ERRCODE = '55000';
    END IF;

    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements(v_state_plan) e
      JOIN public.tournaments t ON t.id = (e->>'tournament_id')::uuid
     WHERE (t.blind_level_state->>'ante')::numeric IS DISTINCT FROM (e->>'new_ante')::numeric;
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'STALE_ANTE_STATE_POSTIMAGE_REFUSED: % rows', v_bad
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RAISE NOTICE 'stale ante corrected: % table rows, % blind_level_state anchors',
    v_n, jsonb_array_length(v_state_plan);
END $mig$;

/* THE END STATE, asserted independently of the plan that produced it and
   over the WHOLE live estate rather than the rows this migration selected:
   no live tournament table past the end of its authored structure stores an
   ante above the share that structure authored. This is the same expression
   as the @live-proof line above. */
DO $post$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tables tb
    JOIN public.tournaments t ON t.id = tb.tournament_id
    CROSS JOIN LATERAL (
      SELECT (SELECT e.value
                FROM jsonb_array_elements(t.blind_structure::jsonb) WITH ORDINALITY AS e(value, ord)
               WHERE lower(COALESCE(e.value->>'isBreak','false')) <> 'true'
               ORDER BY e.ord DESC LIMIT 1) AS lvl) a
   WHERE t.status = 'RUNNING'
     AND COALESCE(t.big_blind_ante,false) = false
     AND t.blind_structure IS NOT NULL
     AND jsonb_typeof(t.blind_structure::jsonb) = 'array'
     AND COALESCE(t.current_level,0) >= jsonb_array_length(t.blind_structure::jsonb)
     AND NOT COALESCE(tb.is_deleted,false)
     AND lower(COALESCE(tb.status::text,'')) NOT IN ('closed','deleted','completed','cancelled','finished')
     AND tb.ante > 0 AND tb.big_blind > 0
     AND a.lvl IS NOT NULL
     AND COALESCE(
           CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.lvl->>'ante')::numeric END, 0) > 0
     AND COALESCE(
           CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.lvl->>'bigBlind')::numeric END,
           CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.lvl->>'big_blind')::numeric END, 0)
         > COALESCE(
           CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (a.lvl->>'ante')::numeric END, 0)
     AND tb.ante > GREATEST(1, floor(tb.big_blind
           * COALESCE(CASE WHEN COALESCE(a.lvl->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
                           THEN (a.lvl->>'ante')::numeric END, 0)
           / COALESCE(CASE WHEN COALESCE(a.lvl->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
                           THEN (a.lvl->>'bigBlind')::numeric END,
                      CASE WHEN COALESCE(a.lvl->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
                           THEN (a.lvl->>'big_blind')::numeric END, 0)));
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STALE_ANTE_STILL_LIVE_AFTER_CORRECTION: % rows', v_bad
      USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
