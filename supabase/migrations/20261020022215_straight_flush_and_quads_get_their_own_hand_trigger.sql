-- 20261020022215_straight_flush_and_quads_get_their_own_hand_trigger.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- SUPERSEDES:   20261020005219 (never installed: its DROP TRIGGER needed ACCESS
--               EXCLUSIVE on hand_history and was refused by lock_timeout in
--               Apply Merged Migration run 39358146943; nothing committed).
-- AFFECTS:      public.training_achievement_definitions (evidence for quads and
--               straight_flush; CHECK widened by one evidence value), NEW
--               function tr_hand_history_straight_flush_quads_achievements and
--               NEW trigger trg_hand_history_straight_flush_quads_achievements.
--               The Royal Flush trigger and function are NOT touched.
-- MONEY:        none. Straight Flush and Four Of A Kind pay 0 diamonds, as
--               before; Royal Flush (500 once) keeps its own unchanged trigger.
--
-- WHAT WAS WRONG (read 2026-10-20 on main 5a62abf20d7 and production):
--
--   1. "Hit A Straight Flush" and "Hit Quads" could never unlock. The browser
--      reported them: TablePage passed the winning hand's DISPLAY name
--      ("Straight Flush", "Four of a Kind", from PokerEngine.evaluate5Cards)
--      and AchievementService.checkSpecialHand only recognised the snake keys
--      straight_flush / four_of_a_kind. Zero players hold either badge.
--   2. Even with the names mapped, the browser read winnersArray[0]'s hand -
--      the FIRST winner of the hand, not necessarily this player.
--   3. Horses have no browser, so a horse could never earn either badge
--      (CLAUDE.md 10.5: horses are players, identically).
--
-- THE ROOT FIX: the engine already records, per dealt player and horses
-- included, the strongest hand that won that player a pot:
-- hand_history.daily_mission_events[*].magnitudes.strong_hands
-- (server/src/engine/dailyMissionEvents.ts dailyMissionHandStrength:
-- 10 Royal Flush, 9 Straight Flush, 8 Four Of A Kind, named from the engine's
-- own evaluator names, so Short Deck and every variant agree). The Royal Flush
-- trigger (20261019155445) already reads 10. This adds a second trigger that
-- reads exactly 9 and 8 and records exactly that achievement for exactly that
-- player: 9 -> straight_flush, 8 -> quads. A Royal Flush (10) is never read
-- here, so it is not also recorded as a Straight Flush and is never handled by
-- two triggers. quads and straight_flush get server evidence
-- 'engine_winning_hand', so fn_achievement_record_progress (the browser door)
-- writes nothing for them from now on, and the client has stopped sending them
-- (src/services/AchievementService.ts, serverProved, #7513).
--
-- LOCKS: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on hand_history, which
-- readers never block (inserts wait milliseconds); the constraint swap takes
-- ACCESS EXCLUSIVE on the 23-row definitions table. Nothing is dropped from
-- hand_history.
--
-- NOT DONE HERE, deliberately: no historical hands are scanned to award past
-- straight flushes or quads. They are zero-reward badges, the scan would read
-- millions of hand_history rows, and DDL on hand_history must hold its lock
-- for milliseconds (CLAUDE.md section 2 rule 7).
--
-- LOAD: measured on production 2026-10-20 00:50 UTC, 21,887 hands in 20
-- minutes carried 36 winning quads and 4 straight flushes - about two calls a
-- minute to fn_achievement_unlock_server, each one advisory lock and one row.
--
-- ROLLBACK (badges already recorded stay):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_hand_history_straight_flush_quads_achievements ON public.hand_history;
--   DROP FUNCTION IF EXISTS public.tr_hand_history_straight_flush_quads_achievements();
--   UPDATE public.training_achievement_definitions SET evidence = NULL
--    WHERE id IN ('quads', 'straight_flush');
--   COMMIT;
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- The trigger lands on hand_history, which the engine writes all the time:
-- never queue hands behind this. The trigger is created LAST.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
    IF md5(pg_get_functiondef('public.fn_achievement_unlock_server(uuid,text,numeric,jsonb)'::regprocedure))
       IS DISTINCT FROM '08e5453a84bafb83a84ddd61cb94c957' THEN
        RAISE EXCEPTION 'pre-image: fn_achievement_unlock_server is not the 20261019155445 body this relies on';
    END IF;
    -- The Royal Flush trigger stays exactly as it is and keeps reading 10.
    IF (SELECT md5(pg_get_triggerdef(t.oid)) FROM pg_trigger t
         WHERE t.tgrelid = 'public.hand_history'::regclass
           AND t.tgname = 'trg_hand_history_royal_flush_achievement')
       IS DISTINCT FROM '1afc462c6520f6c7fcdb7c910f2fec5e' THEN
        RAISE EXCEPTION 'pre-image: trg_hand_history_royal_flush_achievement is not the strong_hands == 10 trigger';
    END IF;
    IF (SELECT string_agg(id || '=' || reward_diamonds || '/' || threshold || '/' || coalesce(evidence, '-'), ','
                          ORDER BY id)
          FROM public.training_achievement_definitions
         WHERE id IN ('quads', 'royal_flush', 'straight_flush'))
       IS DISTINCT FROM 'quads=0/1/-,royal_flush=500/1/engine_royal_flush,straight_flush=0/1/-' THEN
        RAISE EXCEPTION 'pre-flight: quads / royal_flush / straight_flush definitions are not as written against';
    END IF;
    IF to_regprocedure('public.tr_hand_history_straight_flush_quads_achievements()') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hand_history_straight_flush_quads_achievements') THEN
        RAISE EXCEPTION 'pre-flight: an object this migration creates already exists';
    END IF;
END $preflight$;

-- ── 1. Straight Flush and Four Of A Kind are proved by the engine's record ──
ALTER TABLE public.training_achievement_definitions
    DROP CONSTRAINT training_achievement_definitions_reward_needs_evidence;
ALTER TABLE public.training_achievement_definitions
    ADD CONSTRAINT training_achievement_definitions_reward_needs_evidence
    CHECK (reward_diamonds >= 0 AND reward_diamonds <= 500
           AND (reward_diamonds = 0 OR evidence IS NOT NULL)
           AND (evidence IS NULL OR evidence IN ('engine_royal_flush', 'engine_winning_hand',
                                                 'server_login_streak')));

UPDATE public.training_achievement_definitions
   SET evidence = 'engine_winning_hand'
 WHERE id IN ('quads', 'straight_flush');

COMMENT ON COLUMN public.training_achievement_definitions.evidence IS
    'The server record that proves this achievement: engine_royal_flush (hand_history.daily_mission_events strong_hands = 10), engine_winning_hand (strong_hands = 9 straight_flush, 8 quads; added 2026-10-20) or server_login_streak (fn_achievement_record_login). NULL = progress reported by the player''s browser, which can never carry a reward (CHECK). Added 2026-10-19.';

-- ── 2. Straight Flush (9) and Four Of A Kind (8), from the recorded hand ────
CREATE OR REPLACE FUNCTION public.tr_hand_history_straight_flush_quads_achievements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    r record;
BEGIN
    -- An achievement can never fail the hand that earned it: nothing in here
    -- escapes, and each player is settled in a savepoint of their own.
    BEGIN
        IF jsonb_typeof(NEW.daily_mission_events) IS DISTINCT FROM 'array' THEN
            RETURN NULL;
        END IF;
        -- strong_hands is the strongest hand that WON this player a pot
        -- (server/src/engine/dailyMissionEvents.ts): 9 Straight Flush,
        -- 8 Four Of A Kind. 10 (Royal Flush) is the Royal Flush trigger's.
        -- Every dealt player is in the list, horses included (CLAUDE.md 10.5).
        -- A non-numeric value never passes the jsonpath comparison.
        FOR r IN
            SELECT DISTINCT
                   e ->> 'user_id' AS user_id,
                   CASE (e #>> '{magnitudes,strong_hands}')::numeric
                        WHEN 9 THEN 'straight_flush'
                        WHEN 8 THEN 'quads'
                   END AS achievement_id
              FROM jsonb_path_query(NEW.daily_mission_events,
                                    '$[*] ? (@.magnitudes.strong_hands == 9 || @.magnitudes.strong_hands == 8)') AS e
             WHERE jsonb_typeof(e -> 'user_id') = 'string'
        LOOP
            IF r.achievement_id IS NULL
               OR r.user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                CONTINUE;
            END IF;
            BEGIN
                PERFORM public.fn_achievement_unlock_server(
                    r.user_id::uuid, r.achievement_id, 1,
                    jsonb_build_object('hand_id', NEW.id, 'table_id', NEW.table_id,
                                       'hand_number', NEW.hand_number));
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING '% achievement for % in hand % not recorded: % (%)',
                    r.achievement_id, r.user_id, NEW.id, SQLERRM, SQLSTATE;
            END;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'straight flush / quads achievements for hand % not read: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.tr_hand_history_straight_flush_quads_achievements() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tr_hand_history_straight_flush_quads_achievements() IS
    'AFTER INSERT on hand_history: records straight_flush (strong_hands 9) and quads (8) through fn_achievement_unlock_server for every player whose winning hand the engine recorded, horses included. Zero-reward badges. Royal Flush (10) is tr_hand_history_royal_flush_achievement''s. Never fails the hand. Added 2026-10-20.';

-- Last, so the lock on hand_history is held for the shortest time. Every hand
-- that is not a winning Straight Flush or Four Of A Kind pays one jsonpath
-- test in this WHEN.
CREATE TRIGGER trg_hand_history_straight_flush_quads_achievements
    AFTER INSERT ON public.hand_history
    FOR EACH ROW
    WHEN (NEW.daily_mission_events IS NOT NULL
          AND jsonb_path_exists(NEW.daily_mission_events,
                                '$[*] ? (@.magnitudes.strong_hands == 9 || @.magnitudes.strong_hands == 8)'))
    EXECUTE FUNCTION public.tr_hand_history_straight_flush_quads_achievements();

-- ── Post-image ──────────────────────────────────────────────────────────────
DO $postimage$
BEGIN
    IF (SELECT string_agg(id || '=' || reward_diamonds || '/' || threshold || '/' || evidence, ',' ORDER BY id)
          FROM public.training_achievement_definitions WHERE evidence IS NOT NULL)
       IS DISTINCT FROM 'quads=0/1/engine_winning_hand,royal_flush=500/1/engine_royal_flush,'
                     || 'straight_flush=0/1/engine_winning_hand,streak_100=500/100/server_login_streak,'
                     || 'streak_30=100/30/server_login_streak,streak_7=0/7/server_login_streak' THEN
        RAISE EXCEPTION 'post-image: the evidence-backed definitions are not as declared';
    END IF;
    IF (SELECT count(*) FROM public.training_achievement_definitions WHERE reward_diamonds > 0) <> 3 THEN
        RAISE EXCEPTION 'post-image: the rewards changed';
    END IF;
    IF has_function_privilege('authenticated', 'public.tr_hand_history_straight_flush_quads_achievements()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.tr_hand_history_straight_flush_quads_achievements()', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-image: a browser can execute the hand trigger function';
    END IF;
    IF (SELECT count(*) FROM pg_trigger t
         WHERE t.tgrelid = 'public.hand_history'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
           AND t.tgname IN ('trg_hand_history_royal_flush_achievement',
                            'trg_hand_history_straight_flush_quads_achievements')) <> 2 THEN
        RAISE EXCEPTION 'post-image: the Royal Flush and the Straight Flush / quads triggers are not both armed';
    END IF;
END $postimage$;

COMMIT;
