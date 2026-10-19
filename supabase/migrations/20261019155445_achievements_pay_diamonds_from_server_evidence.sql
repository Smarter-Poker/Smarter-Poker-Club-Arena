-- 20261019155445_achievements_pay_diamonds_from_server_evidence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TIER:         3 (diamond payouts)
-- AUTHOR:       Claude (session 01W3nmcKsCqUwigTu6f8FYgL) on Dan's 2026-10-19
--               rulings "Pay achievement rewards as diamonds through
--               award_diamonds_v2." and "NO, ONLY FROM NOW ON" (no back-pay).
-- AFFECTS:      public.training_achievement_definitions (new column evidence,
--               thresholds and rewards filled, browser writes revoked),
--               public.fn_achievement_record_progress (body; same signature),
--               public.fn_notify_achievement_unlocked (adds the diamonds paid),
--               new public.fn_achievement_unlock_server,
--               new public.fn_achievement_record_login,
--               new public.tr_hand_history_royal_flush_achievement + its
--               AFTER INSERT trigger on public.hand_history,
--               UPDATE (login_streak, last_login_date) on public.profiles
--               revoked from browsers,
--               public.diamond_transactions + profiles.diamonds only through
--               award_diamonds_v2, and only on an unlock that happens after
--               this is installed.
-- IRREVERSIBLE: no. Nothing is paid by this migration itself (asserted below).
--
-- WHAT WAS WRONG, READ FROM ROWS ON 2026-10-19:
--
--   * Three of the 23 achievements carry a reward in the client catalog
--     (src/services/AchievementService.ts): royal_flush 500, streak_30 100,
--     streak_100 500. It was paid in chips through add_to_promo_wallet from
--     the browser, which never worked (not executable by authenticated, and
--     refused for anything but owner disbursement since 2026-09-03). That call
--     was removed in #7424. Zero 'achievement' diamond_transactions exist.
--   * fn_achievement_record_progress takes the TARGET from the browser
--     (GREATEST(p_target, 1)), and the progress too. A player could send
--     target 1 and unlock anything, or progress 100 for streak_100.
--   * The server already holds a definitions table,
--     training_achievement_definitions, with the same 23 ids - but threshold
--     and reward_diamonds are 0 on every row, so nothing read it.
--   * The login streak behind streak_7/30/100 (profiles.login_streak,
--     last_login_date) is written by the browser itself
--     (AchievementTriggerService.onLogin); authenticated holds column UPDATE
--     on both. A streak the player can type cannot be paid.
--   * The engine already records, for every dealt player, the strongest hand
--     that won them a pot: hand_history.daily_mission_events[*]
--     .magnitudes.strong_hands, 10 = Royal Flush (dailyMissionEvents.ts).
--     Measured: 5 such hands in the 3 hours to 15:50 UTC. That is a record no
--     browser writes.
--
-- WHAT THIS DOES:
--
--   1. The definitions table becomes the canonical list: threshold and
--      reward_diamonds are filled from the client catalog (same numbers,
--      paid as diamonds: there is no documented chip->diamond conversion for
--      achievements, so the numbers are kept), and a new column `evidence`
--      names the server record that proves the achievement. A CHECK makes a
--      reward impossible without evidence, so a browser-reported badge can
--      never be made to pay. Browser writes on the table are revoked.
--   2. fn_achievement_record_progress (the browser's door) reads the target
--      from the definition and ignores p_target, refuses an unknown id, and
--      writes NOTHING for an achievement that has server evidence. What it
--      still accepts can only ever unlock a badge that pays nothing.
--   3. fn_achievement_unlock_server is the one place an evidence-backed
--      achievement is recorded and paid: on the transition to unlocked,
--      award_diamonds_v2(user, 'achievement', 'achievement:<id>:<user>') with
--      achievement_diamonds = the definition's reward. The reference id makes
--      it once per player per achievement for ever. A row already unlocked
--      before this migration is never paid (Dan: "ONLY FROM NOW ON").
--      If the award is refused because issuance is frozen, the catalog row is
--      inactive or the profile is missing, the unlock is rolled back with it,
--      so the next qualifying event pays. Any other refusal is
--      award_diamonds_v2's own rule (the 1,000-a-month achievement allowance)
--      and the unlock stands.
--   4. Royal Flush: an AFTER INSERT trigger on hand_history, filtered in its
--      WHEN clause to hands whose events carry strong_hands = 10, so every
--      other hand pays one jsonpath test and nothing else. Every player is
--      treated alike - horses included (CLAUDE.md 10.5). Each player is
--      settled in its own savepoint: an achievement can never fail a hand.
--   5. Login streaks: fn_achievement_record_login() counts the day on the
--      server clock (UTC day, the rule onLogin already used), maintains
--      profiles.login_streak / last_login_date itself, and records
--      streak_7/30/100 at that streak through (3). Browser UPDATE on those two
--      columns is revoked; max login_streak on 2026-10-19 is 17, so no stored
--      streak is anywhere near a reward.
--   6. The unlock notification (fn_notify_achievement_unlocked) now says what
--      was paid: data.diamonds_awarded and "+N Diamonds" in the message,
--      read from a transaction-local setting the unlock writes just before
--      the row, so it reports the amount actually credited, never a guess.
--
-- WHY THIS IS NOT A BAND-AID (CLAUDE.md 10.12): no job, sweep or reconciler.
-- The hand write and the login are the live paths, and each pays at the
-- moment the fact lands. Nothing is back-paid.
--
-- PRE-IMAGE (live, 2026-10-19 15:5x UTC):
--   md5(pg_get_functiondef(fn_achievement_record_progress(uuid,text,numeric,numeric)))
--     = a7a3141b2ab6edb3a6b557e245ec0146
--   md5(pg_get_functiondef(fn_notify_achievement_unlocked()))
--     = ff113dbcc77a23bd8cb2187d5d72577b
--   md5(prosrc of award_diamonds_v2(uuid,text,text,text,jsonb))
--     = 2218957f43bc6c653f7827b6344164ea (called, not changed)
--   The two achievement bodies live are their 2026-08-30 migrations with the
--   comments stripped (md5(prosrc) e3055777... / 0ad6dc7f..., identical to the
--   production capture in scripts/ci/probes/bbj-bank-replay/.../10-historical-
--   schema.sql). scripts/ci/test-achievement-diamonds-postgres.py installs
--   exactly those, applies this file byte for byte and proves every rule here.
--
-- ROLLBACK (reverts the mechanism; anything already paid stays paid):
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_hand_history_royal_flush_achievement ON public.hand_history;
--   DROP FUNCTION IF EXISTS public.tr_hand_history_royal_flush_achievement();
--   DROP FUNCTION IF EXISTS public.fn_achievement_record_login();
--   DROP FUNCTION IF EXISTS public.fn_achievement_unlock_server(uuid, text, numeric, jsonb);
--   -- re-apply 20260830050000 (record_progress) and 20260830051000 (notify)
--   GRANT UPDATE (login_streak, last_login_date) ON public.profiles TO authenticated;
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
DECLARE
    v_ids text[];
BEGIN
    IF md5(pg_get_functiondef('public.fn_achievement_record_progress(uuid,text,numeric,numeric)'::regprocedure))
       IS DISTINCT FROM 'a7a3141b2ab6edb3a6b557e245ec0146' THEN
        RAISE EXCEPTION 'pre-image: fn_achievement_record_progress is not the body this migration was written against';
    END IF;
    IF md5(pg_get_functiondef('public.fn_notify_achievement_unlocked()'::regprocedure))
       IS DISTINCT FROM 'ff113dbcc77a23bd8cb2187d5d72577b' THEN
        RAISE EXCEPTION 'pre-image: fn_notify_achievement_unlocked is not the body this migration was written against';
    END IF;
    IF (SELECT md5(p.prosrc) FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.award_diamonds_v2(uuid,text,text,text,jsonb)'))
       IS DISTINCT FROM '2218957f43bc6c653f7827b6344164ea' THEN
        RAISE EXCEPTION 'pre-image: award_diamonds_v2 is not the body whose achievement branch this relies on';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.diamond_reward_catalog c
                    WHERE c.action_key = 'achievement' AND c.active
                      AND NOT c.counts_toward_daily_cap AND NOT c.lifetime
                      AND c.max_per_day IS NULL) THEN
        RAISE EXCEPTION 'pre-flight: the achievement catalog row is not active, uncapped-daily and non-lifetime';
    END IF;
    SELECT array_agg(d.id ORDER BY d.id) INTO v_ids FROM public.training_achievement_definitions d;
    IF v_ids IS DISTINCT FROM ARRAY['bad_beat','biggest_pot_500','clubs_3','friends_25','friends_5',
            'hands_100','hands_1000','hands_10000','hands_100000','profit_1000','profit_10000',
            'quads','royal_flush','straight_flush','streak_100','streak_30','streak_7',
            'tourney_played_50','tourney_top3_10','tourney_win_1','wins_10','wins_100','wins_1000'] THEN
        RAISE EXCEPTION 'pre-flight: training_achievement_definitions is not the 23 Club Arena achievements: %', v_ids;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'training_achievement_definitions'
                  AND column_name = 'evidence')
       OR to_regprocedure('public.fn_achievement_unlock_server(uuid,text,numeric,jsonb)') IS NOT NULL
       OR to_regprocedure('public.fn_achievement_record_login()') IS NOT NULL
       OR to_regprocedure('public.tr_hand_history_royal_flush_achievement()') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_hand_history_royal_flush_achievement') THEN
        RAISE EXCEPTION 'pre-flight: an object this migration creates already exists';
    END IF;
    -- No achievement has ever been paid in diamonds; this migration pays none.
    IF EXISTS (SELECT 1 FROM public.diamond_transactions t
                WHERE t.reference_id LIKE 'achievement:%') THEN
        RAISE EXCEPTION 'pre-flight: an achievement:* diamond credit already exists';
    END IF;
END $preflight$;

-- ── 1. The canonical definitions ────────────────────────────────────────────
ALTER TABLE public.training_achievement_definitions ADD COLUMN evidence text;

DO $definitions$
DECLARE
    v_rows integer;
BEGIN
    UPDATE public.training_achievement_definitions d
       SET threshold = v.threshold, reward_diamonds = v.reward_diamonds, evidence = v.evidence
      FROM (VALUES
          ('hands_100',          100, 0, NULL),
          ('hands_1000',        1000, 0, NULL),
          ('hands_10000',      10000, 0, NULL),
          ('hands_100000',    100000, 0, NULL),
          ('wins_10',             10, 0, NULL),
          ('wins_100',           100, 0, NULL),
          ('wins_1000',         1000, 0, NULL),
          ('friends_5',            5, 0, NULL),
          ('friends_25',          25, 0, NULL),
          ('clubs_3',              3, 0, NULL),
          ('profit_1000',       1000, 0, NULL),
          ('profit_10000',     10000, 0, NULL),
          ('biggest_pot_500',    500, 0, NULL),
          ('tourney_win_1',        1, 0, NULL),
          ('tourney_top3_10',     10, 0, NULL),
          ('tourney_played_50',   50, 0, NULL),
          ('royal_flush',          1, 500, 'engine_royal_flush'),
          ('straight_flush',       1, 0, NULL),
          ('quads',                1, 0, NULL),
          ('bad_beat',             1, 0, NULL),
          ('streak_7',             7, 0, 'server_login_streak'),
          ('streak_30',           30, 100, 'server_login_streak'),
          ('streak_100',         100, 500, 'server_login_streak')
      ) AS v(id, threshold, reward_diamonds, evidence)
     WHERE d.id = v.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 23 THEN
        RAISE EXCEPTION 'definitions: expected 23 rows filled, filled %', v_rows;
    END IF;
END $definitions$;

-- A reward needs server evidence; a browser-reported badge can never pay.
-- 500 is award_diamonds_v2's single achievement ceiling.
ALTER TABLE public.training_achievement_definitions
    ADD CONSTRAINT training_achievement_definitions_reward_needs_evidence
    CHECK (reward_diamonds >= 0 AND reward_diamonds <= 500
           AND (reward_diamonds = 0 OR evidence IS NOT NULL)
           AND (evidence IS NULL OR evidence IN ('engine_royal_flush', 'server_login_streak')));

COMMENT ON COLUMN public.training_achievement_definitions.evidence IS
    'The server record that proves this achievement: engine_royal_flush (hand_history.daily_mission_events strong_hands = 10) or server_login_streak (fn_achievement_record_login). NULL = progress reported by the player''s browser, which can never carry a reward (CHECK). Added 2026-10-19.';

-- The definitions decide money now. Reads stay public; writes are the owner's.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.training_achievement_definitions FROM PUBLIC, anon, authenticated;

-- ── 2. The notification says what was paid ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_achievement_unlocked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_name     text;
  v_paid     text;
  v_diamonds integer := 0;
BEGIN
  -- Transition only: NULL -> non-NULL. On INSERT, OLD is NULL.
  IF NEW.unlocked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.unlocked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT d.name INTO v_name
      FROM public.training_achievement_definitions d
     WHERE d.id::text = NEW.achievement_id::text;

    -- fn_achievement_unlock_server writes '<achievement id>:<diamonds credited>'
    -- just before the row, for this transaction only. Nothing else sets it.
    v_paid := current_setting('ca.achievement_diamonds_awarded', true);
    IF v_paid LIKE NEW.achievement_id::text || ':%'
       AND split_part(v_paid, ':', 2) ~ '^[0-9]{1,9}$' THEN
      v_diamonds := split_part(v_paid, ':', 2)::integer;
    END IF;

    INSERT INTO public.notifications (user_id, type, title, message, data)
    VALUES (
      NEW.user_id,
      'achievement',
      'Achievement Unlocked',
      COALESCE(NULLIF(btrim(v_name), ''), NEW.achievement_id::text)
        || CASE WHEN v_diamonds > 0
                THEN ': +' || to_char(v_diamonds, 'FM999,999,999') || ' Diamonds'
                ELSE '' END,
      jsonb_build_object(
        'achievement_id', NEW.achievement_id,
        'achievement_name', COALESCE(NULLIF(btrim(v_name), ''), NEW.achievement_id::text),
        'diamonds_awarded', v_diamonds
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- A player earned the achievement. Failing to announce it must never undo
    -- it, and must never fail the write that earned it.
    RAISE WARNING 'fn_notify_achievement_unlocked failed for user % achievement %: %',
      NEW.user_id, NEW.achievement_id, SQLERRM;
  END;

  RETURN NEW;
END
$fn$;

-- ── 3. The one place an evidence-backed achievement is recorded and paid ────
CREATE OR REPLACE FUNCTION public.fn_achievement_unlock_server(
    p_user_id        uuid,
    p_achievement_id text,
    p_progress       numeric,
    p_evidence       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_def          record;
    v_target       numeric;
    v_old_progress numeric;
    v_was_unlocked boolean := false;
    v_progress     numeric;
    v_transition   boolean;
    v_award        jsonb;
    v_awarded      integer := 0;
    v_reference    text;
BEGIN
    IF p_user_id IS NULL OR p_achievement_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input', 'unlocked', false, 'diamonds_awarded', 0);
    END IF;

    SELECT d.id, d.threshold, d.reward_diamonds, d.evidence INTO v_def
      FROM public.training_achievement_definitions d
     WHERE d.id = p_achievement_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'fn_achievement_unlock_server: unknown achievement %', p_achievement_id;
    END IF;
    IF v_def.evidence IS NULL THEN
        RAISE EXCEPTION 'fn_achievement_unlock_server: % is reported by the browser, not proved by the server', p_achievement_id;
    END IF;
    v_target := GREATEST(COALESCE(v_def.threshold, 1), 1);

    -- One writer per player per achievement (the hand trigger and a login can race).
    PERFORM pg_advisory_xact_lock(1799876948, hashtext(p_user_id::text || ':' || p_achievement_id));

    SELECT a.progress, (a.unlocked_at IS NOT NULL)
      INTO v_old_progress, v_was_unlocked
      FROM public.training_user_achievements a
     WHERE a.user_id = p_user_id AND a.achievement_id = p_achievement_id
       FOR UPDATE;
    v_was_unlocked := COALESCE(v_was_unlocked, false);

    -- Progress only rises and never passes the target.
    v_progress   := LEAST(GREATEST(COALESCE(v_old_progress, 0), COALESCE(p_progress, 0), 0), v_target);
    v_transition := NOT v_was_unlocked AND v_progress >= v_target;

    IF v_transition AND v_def.reward_diamonds > 0 THEN
        v_reference := 'achievement:' || p_achievement_id || ':' || p_user_id::text;
        v_award := public.award_diamonds_v2(
            p_user_id, 'achievement', v_reference, p_achievement_id,
            jsonb_build_object(
                'achievement_diamonds', v_def.reward_diamonds,
                'achievement_id', p_achievement_id,
                'evidence', v_def.evidence,
                'proof', COALESCE(p_evidence, '{}'::jsonb),
                'source', 'fn_achievement_unlock_server'
            )
        );
        IF COALESCE((v_award ->> 'success')::boolean, false) THEN
            v_awarded := COALESCE((v_award ->> 'awarded')::integer, 0);
        ELSIF v_award ->> 'reason' IN ('diamond_issuance_frozen', 'unknown_action', 'user_not_found', 'invalid_input') THEN
            -- Not this player's doing: keep the achievement unearned so the
            -- next qualifying event records and pays it.
            RAISE EXCEPTION 'fn_achievement_unlock_server: % for % not recorded, award refused: %',
                p_achievement_id, p_user_id, v_award ->> 'reason';
        END IF;
        -- Any other refusal is award_diamonds_v2's own rule (the monthly
        -- achievement allowance, an existing credit under this reference):
        -- the achievement stands and the journal says why nothing was paid.
        PERFORM set_config('ca.achievement_diamonds_awarded', p_achievement_id || ':' || v_awarded::text, true);
    END IF;

    INSERT INTO public.training_user_achievements
                (user_id, achievement_id, progress, target, unlocked_at, unlocked)
         VALUES (p_user_id, p_achievement_id, v_progress, v_target,
                 CASE WHEN v_progress >= v_target THEN now() END,
                 v_progress >= v_target)
    ON CONFLICT (user_id, achievement_id) DO UPDATE
       SET progress    = v_progress,
           target      = v_target,
           unlocked_at = COALESCE(public.training_user_achievements.unlocked_at,
                                  CASE WHEN v_progress >= v_target THEN now() END),
           unlocked    = COALESCE(public.training_user_achievements.unlocked_at,
                                  CASE WHEN v_progress >= v_target THEN now() END) IS NOT NULL;

    PERFORM set_config('ca.achievement_diamonds_awarded', '', true);

    RETURN jsonb_build_object(
        'ok', true,
        'achievement_id', p_achievement_id,
        'progress', v_progress,
        'target', v_target,
        'unlocked', v_transition,
        'diamonds_awarded', v_awarded,
        'award', v_award
    );
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_achievement_unlock_server(uuid, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_achievement_unlock_server(uuid, text, numeric, jsonb) IS
    'Records an achievement the server can prove (definitions.evidence) and, on the transition to unlocked, pays its reward_diamonds once through award_diamonds_v2(achievement, reference achievement:<id>:<user>). Owner-only: called by tr_hand_history_royal_flush_achievement and fn_achievement_record_login. Never pays a row unlocked before 2026-10-19 (no back-pay). Added 2026-10-19.';

-- ── 4. The browser's door: canonical target, known ids, no evidence-backed writes
CREATE OR REPLACE FUNCTION public.fn_achievement_record_progress(
  p_user_id uuid, p_achievement_id text, p_progress numeric, p_target numeric
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller       uuid := auth.uid();
  v_target       numeric;
  v_threshold    integer;
  v_evidence     text;
  v_was_unlocked boolean;
  v_now_unlocked boolean;
BEGIN
  IF p_user_id IS NULL OR p_achievement_id IS NULL THEN
    RETURN false;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'fn_achievement_record_progress: a caller without a session cannot write achievements';
  END IF;

  IF v_caller <> p_user_id THEN
    RAISE EXCEPTION 'fn_achievement_record_progress: refusing to write achievements for another user';
  END IF;

  -- The target is the server's, never the caller's: p_target is accepted for
  -- the deployed signature and ignored (2026-10-19: a caller sending 1 unlocked
  -- anything). An id the server does not define is refused.
  SELECT d.threshold, d.evidence INTO v_threshold, v_evidence
    FROM public.training_achievement_definitions d
   WHERE d.id = p_achievement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_achievement_record_progress: unknown achievement %', p_achievement_id;
  END IF;

  -- An achievement the server proves from its own records (and the only kind
  -- that can carry a reward) takes nothing from a browser.
  IF v_evidence IS NOT NULL THEN
    RETURN false;
  END IF;

  v_target := GREATEST(COALESCE(v_threshold, 1), 1);

  SELECT (unlocked_at IS NOT NULL) INTO v_was_unlocked
    FROM public.training_user_achievements
   WHERE user_id = p_user_id AND achievement_id = p_achievement_id;

  INSERT INTO public.training_user_achievements
              (user_id, achievement_id, progress, target, unlocked_at, unlocked)
       VALUES (p_user_id, p_achievement_id,
               LEAST(GREATEST(COALESCE(p_progress, 0), 0), v_target),
               v_target,
               CASE WHEN COALESCE(p_progress, 0) >= v_target THEN now() ELSE NULL END,
               COALESCE(p_progress, 0) >= v_target)
  ON CONFLICT (user_id, achievement_id) DO UPDATE
     SET progress    = LEAST(GREATEST(public.training_user_achievements.progress,
                                      COALESCE(EXCLUDED.progress, 0)), v_target),
         target      = v_target,
         unlocked_at = COALESCE(
                         public.training_user_achievements.unlocked_at,
                         CASE WHEN LEAST(GREATEST(public.training_user_achievements.progress,
                                                  COALESCE(EXCLUDED.progress, 0)), v_target) >= v_target
                              THEN now() END),
         unlocked    = COALESCE(
                         public.training_user_achievements.unlocked_at,
                         CASE WHEN LEAST(GREATEST(public.training_user_achievements.progress,
                                                  COALESCE(EXCLUDED.progress, 0)), v_target) >= v_target
                              THEN now() END) IS NOT NULL
  RETURNING unlocked INTO v_now_unlocked;

  RETURN COALESCE(v_now_unlocked, false) AND NOT COALESCE(v_was_unlocked, false);
END $function$;

REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_achievement_record_progress(uuid, text, numeric, numeric) IS
  'Records browser-reported achievement progress for the CALLING user. The target is read from training_achievement_definitions (p_target is ignored), an unknown id is refused, and an achievement with server evidence (the only kind that can carry a reward) is never written here. Requires a session; anon has no EXECUTE. Called from src/services/AchievementService.ts.';

-- ── 5. Login streaks, counted on the server ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_achievement_record_login()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_uid      uuid := auth.uid();
    v_today    date := (now() AT TIME ZONE 'UTC')::date;
    v_last     date;
    v_streak   integer;
    v_res      jsonb;
    v_unlocked jsonb := '[]'::jsonb;
    r          record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'fn_achievement_record_login: a caller without a session has no login to count';
    END IF;

    SELECT COALESCE(p.login_streak, 0), p.last_login_date
      INTO v_streak, v_last
      FROM public.profiles p
     WHERE p.id = v_uid
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_profile', 'counted', false, 'streak', 0, 'unlocked', v_unlocked);
    END IF;

    -- Already counted today: nothing to write, nothing to award.
    IF v_last = v_today THEN
        RETURN jsonb_build_object('ok', true, 'counted', false, 'streak', v_streak, 'unlocked', v_unlocked);
    END IF;

    v_streak := CASE WHEN v_last = v_today - 1 THEN v_streak + 1 ELSE 1 END;

    UPDATE public.profiles
       SET login_streak = v_streak, last_login_date = v_today
     WHERE id = v_uid;

    FOR r IN
        SELECT d.id FROM public.training_achievement_definitions d
         WHERE d.evidence = 'server_login_streak'
         ORDER BY d.threshold, d.id
    LOOP
        -- Each achievement in its own savepoint: one refused award never
        -- un-counts the day or the other two.
        BEGIN
            v_res := public.fn_achievement_unlock_server(
                v_uid, r.id, v_streak,
                jsonb_build_object('login_streak', v_streak, 'day', v_today));
            IF COALESCE((v_res ->> 'unlocked')::boolean, false) THEN
                v_unlocked := v_unlocked || jsonb_build_array(jsonb_build_object(
                    'achievement_id', r.id,
                    'diamonds_awarded', COALESCE((v_res ->> 'diamonds_awarded')::integer, 0)));
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'fn_achievement_record_login: % for % not recorded: % (%)',
                r.id, v_uid, SQLERRM, SQLSTATE;
        END;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'counted', true, 'streak', v_streak, 'unlocked', v_unlocked);
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_achievement_record_login() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_achievement_record_login() TO authenticated;

COMMENT ON FUNCTION public.fn_achievement_record_login() IS
    'Counts the calling player''s login day on the server clock (UTC day), maintains profiles.login_streak / last_login_date, and records streak_7/30/100 through fn_achievement_unlock_server, which pays streak_30 (100) and streak_100 (500) diamonds once. Browsers no longer hold UPDATE on those two columns. Added 2026-10-19.';

-- The streak is the server's now.
REVOKE UPDATE (login_streak, last_login_date) ON public.profiles FROM PUBLIC, anon, authenticated;

-- ── 6. Royal Flush, from the hand the engine recorded ───────────────────────
CREATE OR REPLACE FUNCTION public.tr_hand_history_royal_flush_achievement()
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
        -- (server/src/engine/dailyMissionEvents.ts): 10 is a Royal Flush.
        -- Every dealt player is in the list, horses included (CLAUDE.md 10.5).
        FOR r IN
            SELECT DISTINCT u #>> '{}' AS user_id
              FROM jsonb_path_query(NEW.daily_mission_events,
                                    '$[*] ? (@.magnitudes.strong_hands == 10).user_id') AS u
        LOOP
            IF r.user_id IS NULL
               OR r.user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                CONTINUE;
            END IF;
            BEGIN
                PERFORM public.fn_achievement_unlock_server(
                    r.user_id::uuid, 'royal_flush', 1,
                    jsonb_build_object('hand_id', NEW.id, 'table_id', NEW.table_id,
                                       'hand_number', NEW.hand_number));
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'royal flush achievement for % in hand % not recorded: % (%)',
                    r.user_id, NEW.id, SQLERRM, SQLSTATE;
            END;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'royal flush achievements for hand % not read: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.tr_hand_history_royal_flush_achievement() FROM PUBLIC, anon, authenticated;

-- Last, so the lock on hand_history is held for the shortest time. Every hand
-- that is not a winning Royal Flush pays one jsonpath test in this WHEN.
CREATE TRIGGER trg_hand_history_royal_flush_achievement
    AFTER INSERT ON public.hand_history
    FOR EACH ROW
    WHEN (NEW.daily_mission_events IS NOT NULL
          AND jsonb_path_exists(NEW.daily_mission_events, '$[*] ? (@.magnitudes.strong_hands == 10)'))
    EXECUTE FUNCTION public.tr_hand_history_royal_flush_achievement();

-- ── Post-image ──────────────────────────────────────────────────────────────
DO $postimage$
BEGIN
    IF (SELECT count(*) FROM public.training_achievement_definitions
         WHERE reward_diamonds > 0) <> 3
       OR (SELECT string_agg(id || '=' || reward_diamonds || '/' || threshold || '/' || evidence, ',' ORDER BY id)
             FROM public.training_achievement_definitions WHERE reward_diamonds > 0)
          <> 'royal_flush=500/1/engine_royal_flush,streak_100=500/100/server_login_streak,streak_30=100/30/server_login_streak' THEN
        RAISE EXCEPTION 'post-image: the three rewards are not royal_flush 500, streak_30 100, streak_100 500';
    END IF;
    IF EXISTS (SELECT 1 FROM public.training_achievement_definitions WHERE threshold < 1) THEN
        RAISE EXCEPTION 'post-image: a definition has no threshold';
    END IF;

    IF has_function_privilege('anon', 'public.fn_achievement_record_progress(uuid,text,numeric,numeric)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.fn_achievement_record_progress(uuid,text,numeric,numeric)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.fn_achievement_record_login()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.fn_achievement_record_login()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.fn_achievement_unlock_server(uuid,text,numeric,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.fn_achievement_unlock_server(uuid,text,numeric,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.tr_hand_history_royal_flush_achievement()', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-image: achievement function privileges are not as declared';
    END IF;

    IF has_column_privilege('authenticated', 'public.profiles', 'login_streak', 'UPDATE')
       OR has_column_privilege('authenticated', 'public.profiles', 'last_login_date', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.training_achievement_definitions', 'UPDATE')
       OR has_table_privilege('anon', 'public.training_achievement_definitions', 'INSERT') THEN
        RAISE EXCEPTION 'post-image: a browser can still write the streak or the definitions';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.hand_history'::regclass
                      AND t.tgname = 'trg_hand_history_royal_flush_achievement'
                      AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
        RAISE EXCEPTION 'post-image: the royal flush trigger is not armed on hand_history';
    END IF;

    IF pg_get_functiondef('public.fn_achievement_record_progress(uuid,text,numeric,numeric)'::regprocedure)
       LIKE '%GREATEST(COALESCE(p_target%' THEN
        RAISE EXCEPTION 'post-image: the browser target is still trusted';
    END IF;

    -- Nothing was paid by installing this: no back-pay.
    IF EXISTS (SELECT 1 FROM public.diamond_transactions t WHERE t.reference_id LIKE 'achievement:%') THEN
        RAISE EXCEPTION 'post-image: an achievement credit was written by the migration';
    END IF;
END $postimage$;

COMMIT;
