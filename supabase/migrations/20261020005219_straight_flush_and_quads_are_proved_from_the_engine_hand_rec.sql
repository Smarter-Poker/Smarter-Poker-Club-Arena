-- SUPERSEDED BY 20261020022215: never installed; Apply Merged Migration run 39358146943 was refused (55P03 lock timeout, nothing committed) because DROP TRIGGER needs ACCESS EXCLUSIVE on hand_history, which waits behind every reader. The replacement leaves the Royal Flush trigger alone and only CREATEs a second trigger (SHARE ROW EXCLUSIVE, which readers do not block).
-- 20261020005219_straight_flush_and_quads_are_proved_from_the_engine_hand_rec.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AFFECTS:      public.training_achievement_definitions (evidence for quads and
--               straight_flush; CHECK widened by one evidence value),
--               trigger trg_hand_history_royal_flush_achievement and function
--               tr_hand_history_royal_flush_achievement (DROPPED, replaced by)
--               trg_hand_history_winning_hand_achievements /
--               tr_hand_history_winning_hand_achievements (NEW).
-- MONEY:        none new. Straight Flush and Four Of A Kind pay 0 diamonds, as
--               before. Royal Flush still pays its 500 once, through the same
--               fn_achievement_unlock_server -> award_diamonds_v2 path and the
--               same reference (achievement:royal_flush:<user>), so a player
--               already paid can never be paid again.
--
-- WHAT WAS WRONG (read 2026-10-20 on main 5a62abf20d7 and production):
--
--   1. "Hit A Straight Flush" and "Hit Quads" could never unlock. The browser
--      reported them: TablePage passed the winning hand's DISPLAY name
--      ("Straight Flush", "Four of a Kind", from PokerEngine.evaluate5Cards)
--      and AchievementService.checkSpecialHand only recognised the snake keys
--      straight_flush / four_of_a_kind. Zero players hold either badge.
--   2. Even with the names mapped, the browser read winnersArray[0]'s hand -
--      the FIRST winner of the hand, not necessarily this player - so a
--      player who won a side pot with a pair would have been credited the
--      main-pot winner's quads.
--   3. Horses have no browser, so a horse could never earn either badge
--      (CLAUDE.md 10.5: horses are players, identically).
--
-- THE ROOT FIX: the engine already records, per dealt player and horses
-- included, the strongest hand that won that player a pot:
-- hand_history.daily_mission_events[*].magnitudes.strong_hands
-- (server/src/engine/dailyMissionEvents.ts dailyMissionHandStrength:
-- 10 Royal Flush, 9 Straight Flush, 8 Four Of A Kind, named from the engine's
-- own evaluator names, so Short Deck and every variant agree). The Royal Flush
-- trigger already read it for 10. This replaces it with one trigger that reads
-- 8, 9 and 10 and records exactly that achievement for exactly that player:
--   10 -> royal_flush, 9 -> straight_flush, 8 -> quads.
-- A Royal Flush is not also recorded as a Straight Flush (the badges name the
-- hand, as the browser mapping did). quads and straight_flush get server
-- evidence 'engine_winning_hand', so fn_achievement_record_progress (the
-- browser door) writes nothing for them from now on, and the client stops
-- sending them (src/services/AchievementService.ts, serverProved).
--
-- NOT DONE HERE, deliberately: no historical hands are scanned to award past
-- straight flushes or quads. They are zero-reward badges, the scan would read
-- millions of hand_history rows, and DDL on hand_history must hold its lock
-- for milliseconds, not minutes (CLAUDE.md section 2 rule 7).
--
-- LOAD: measured on production 2026-10-20 00:50 UTC, 21,887 hands in 20
-- minutes carried 36 winning quads and 4 straight flushes - about two calls a
-- minute to fn_achievement_unlock_server, each one advisory lock and one row.
--
-- ROLLBACK (re-arms the Royal Flush-only trigger; badges already recorded stay):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_hand_history_winning_hand_achievements ON public.hand_history;
--   DROP FUNCTION IF EXISTS public.tr_hand_history_winning_hand_achievements();
--   -- re-run section 6 of 20261019155445 (function + trigger)
--   UPDATE public.training_achievement_definitions SET evidence = NULL
--    WHERE id IN ('quads', 'straight_flush');
--   COMMIT;
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- The trigger swap touches hand_history, which the engine writes all the
-- time: never queue hands behind this. The trigger work is done LAST.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
    IF md5(pg_get_functiondef('public.tr_hand_history_royal_flush_achievement()'::regprocedure))
       IS DISTINCT FROM 'cbf2fe49d7d2cca72b6168b65e5dc92b' THEN
        RAISE EXCEPTION 'pre-image: tr_hand_history_royal_flush_achievement is not the 20261019155445 body';
    END IF;
    IF md5(pg_get_functiondef('public.fn_achievement_unlock_server(uuid,text,numeric,jsonb)'::regprocedure))
       IS DISTINCT FROM '08e5453a84bafb83a84ddd61cb94c957' THEN
        RAISE EXCEPTION 'pre-image: fn_achievement_unlock_server is not the 20261019155445 body this relies on';
    END IF;
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
    IF to_regprocedure('public.tr_hand_history_winning_hand_achievements()') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hand_history_winning_hand_achievements') THEN
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

-- ── 2. One trigger reads every winning hand the badges name ────────────────
CREATE OR REPLACE FUNCTION public.tr_hand_history_winning_hand_achievements()
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
        -- (server/src/engine/dailyMissionEvents.ts): 10 Royal Flush,
        -- 9 Straight Flush, 8 Four Of A Kind. Every dealt player is in the
        -- list, horses included (CLAUDE.md 10.5). A non-numeric value never
        -- passes the jsonpath comparison.
        FOR r IN
            SELECT DISTINCT
                   e ->> 'user_id' AS user_id,
                   CASE (e #>> '{magnitudes,strong_hands}')::numeric
                        WHEN 10 THEN 'royal_flush'
                        WHEN 9  THEN 'straight_flush'
                        WHEN 8  THEN 'quads'
                   END AS achievement_id
              FROM jsonb_path_query(NEW.daily_mission_events,
                                    '$[*] ? (@.magnitudes.strong_hands >= 8 && @.magnitudes.strong_hands <= 10)') AS e
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
        RAISE WARNING 'winning hand achievements for hand % not read: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.tr_hand_history_winning_hand_achievements() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tr_hand_history_winning_hand_achievements() IS
    'AFTER INSERT on hand_history: records royal_flush (strong_hands 10, pays 500 diamonds once via fn_achievement_unlock_server), straight_flush (9) and quads (8) for every player whose winning hand the engine recorded, horses included. Never fails the hand. Replaced tr_hand_history_royal_flush_achievement on 2026-10-20.';

-- Last, so the lock on hand_history is held for the shortest time. The old
-- trigger goes in the same transaction the new one arrives, so no hand is
-- read by both and none by neither.
DROP TRIGGER trg_hand_history_royal_flush_achievement ON public.hand_history;
DROP FUNCTION public.tr_hand_history_royal_flush_achievement();

CREATE TRIGGER trg_hand_history_winning_hand_achievements
    AFTER INSERT ON public.hand_history
    FOR EACH ROW
    WHEN (NEW.daily_mission_events IS NOT NULL
          AND jsonb_path_exists(NEW.daily_mission_events, '$[*] ? (@.magnitudes.strong_hands >= 8)'))
    EXECUTE FUNCTION public.tr_hand_history_winning_hand_achievements();

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
    IF has_function_privilege('authenticated', 'public.tr_hand_history_winning_hand_achievements()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.tr_hand_history_winning_hand_achievements()', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-image: a browser can execute the hand trigger function';
    END IF;
    IF to_regprocedure('public.tr_hand_history_royal_flush_achievement()') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hand_history_royal_flush_achievement') THEN
        RAISE EXCEPTION 'post-image: the Royal Flush-only trigger is still armed (a royal would be read twice)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.hand_history'::regclass
                      AND t.tgname = 'trg_hand_history_winning_hand_achievements'
                      AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
        RAISE EXCEPTION 'post-image: the winning hand trigger is not armed on hand_history';
    END IF;
END $postimage$;

COMMIT;
