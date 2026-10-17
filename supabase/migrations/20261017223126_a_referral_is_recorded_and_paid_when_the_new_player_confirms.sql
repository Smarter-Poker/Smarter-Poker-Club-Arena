-- ═══════════════════════════════════════════════════════════════════════
-- 20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:         3 (diamond payouts)
-- AUTHOR:       Claude (session 0185wCa4L91BZ3wXmm1vysNZ), on Dan's instruction
-- AFFECTS:      public.referrals, public.profiles.referred_by,
--               public.diamond_transactions (through award_diamonds_v2),
--               new fn_settle_signup_referral, two triggers on auth.users
-- IRREVERSIBLE: the backfill payouts are (diamonds are never clawed back);
--               the function and triggers are reversible (rollback below)
--
-- WHY:
--   No sign-up referral was ever recorded. public.referrals held zero rows
--   and profiles.referred_by was NULL for every account on 2026-10-17. The
--   sign-up page parked the referrer in the browser's localStorage, and the
--   only reader (/api/rewards/referral) looked the pair up in public.referrals,
--   which nothing ever wrote. That endpoint also withheld payment until the
--   referee had a verified phone, a seven-day-old account and five login days.
--
--   Dan, 2026-10-17: "YES PAY OUT DIAMONDS FOR ALL REFERRALS".
--
-- HOW:
--   * fn_settle_signup_referral(referee) is the ONE place a referral is
--     recorded and paid. It reads the referrer from the account's own sign-up
--     record (auth.users.raw_user_meta_data): referral_player_number, written
--     by the sign-up page, else the ref=<player number> carried in
--     club_join_path, the Club Arena invite link the player arrived on.
--     It records public.referrals and profiles.referred_by, then pays
--     500 (referral_qualified) to the referrer and 100 (referral_referee) to
--     the new player through award_diamonds_v2, the platform's idempotent
--     award path. The reference ids are the ones /api/rewards/referral always
--     used, so no door can pay a referral twice.
--   * The only condition is a confirmed email: a referral pays the moment the
--     new player confirms, by code or by link, on any device.
--   * Two triggers on auth.users call it when an email is confirmed (UPDATE)
--     or an account is created already confirmed (INSERT, e.g. OAuth). The
--     call runs in a savepoint so a referral can never block a sign-up; the
--     World Hub calls the same function again after verification, so a
--     failed attempt is retried by the next live door, not by a sweep.
--   * Backfill: every confirmed account that arrived with a referral is
--     settled now. On 2026-10-17 that is exactly three players, all referred
--     by kingfish (player #1) through his Club Arena invite link:
--       Papa         (2026-10-16 14:01 UTC) 100 to Papa, 500 to kingfish
--       Dinodollars  (2026-10-17 00:43 UTC) 100 to Dinodollars, 500 to kingfish
--       TomTomTamale (2026-10-17 13:54 UTC) 100 to TomTomTamale, 500 to kingfish
--     MrWick007 arrived the same way but has not confirmed his email; the
--     trigger pays him and kingfish the moment he does. Every multiplier
--     involved is 1.00, so the amounts are exact; the assertions below abort
--     the whole migration if anything else is found.
--
-- ROLLBACK (reverts the mechanism; payouts already made stay paid):
--   BEGIN;
--   DROP TRIGGER IF EXISTS on_auth_user_email_confirmed_referral ON auth.users;
--   DROP TRIGGER IF EXISTS on_auth_user_inserted_confirmed_referral ON auth.users;
--   DROP FUNCTION IF EXISTS public.tr_auth_user_confirmed_settles_referral();
--   DROP FUNCTION IF EXISTS public.fn_settle_signup_referral(uuid);
--   DROP FUNCTION IF EXISTS public.fn_signup_referrer(uuid);
--   COMMIT;
--
-- WHERE THIS LIVES: the database is shared with the World Hub, whose sign-up
-- page (pages/auth/signup.js) writes referral_player_number and whose
-- /api/rewards/referral calls fn_settle_signup_referral as the second door.
-- It is applied from this repo through Apply Merged Migration, the sanctioned
-- route that sends the merged file's own bytes.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- Two triggers land on auth.users: never queue sign-ups behind this.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF to_regprocedure('public.award_diamonds_v2(uuid,text,text,text,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: award_diamonds_v2 not found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'referrals_referee_id_key') THEN
        RAISE EXCEPTION 'pre-flight failed: referrals.referee_id is not unique';
    END IF;
    IF (SELECT count(*) FROM public.diamond_reward_catalog
         WHERE action_key IN ('referral_qualified', 'referral_referee') AND active) <> 2 THEN
        RAISE EXCEPTION 'pre-flight failed: referral catalog rows missing or inactive';
    END IF;
END $$;

-- The referrer a new account arrived with, from its own sign-up record.
CREATE OR REPLACE FUNCTION public.fn_signup_referrer(p_referee uuid)
RETURNS TABLE (referrer_id uuid, player_number text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_meta jsonb;
    v_num  text;
BEGIN
    SELECT u.raw_user_meta_data INTO v_meta FROM auth.users u WHERE u.id = p_referee;
    IF v_meta IS NULL THEN RETURN; END IF;

    v_num := NULLIF(btrim(v_meta ->> 'referral_player_number'), '');
    IF v_num IS NULL THEN
        v_num := substring(COALESCE(v_meta ->> 'club_join_path', '') FROM '[?&]ref=([0-9]{1,9})(?:[&#]|\Z)');
    END IF;
    IF v_num IS NULL OR v_num !~ '^[0-9]{1,9}$' OR v_num::bigint <= 0 THEN RETURN; END IF;
    v_num := v_num::bigint::text;

    RETURN QUERY
        SELECT p.id, p.player_number
          FROM public.profiles p
         WHERE p.player_number = v_num
           AND p.id <> p_referee;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_settle_signup_referral(p_referee uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_confirmed  timestamptz;
    v_referrer   uuid;
    v_number     text;
    v_referrer_r jsonb;
    v_referee_r  jsonb;
    v_ok_referrer boolean;
    v_ok_referee  boolean;
BEGIN
    IF p_referee IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
    END IF;

    -- One settlement per new player at a time (trigger and endpoint can race).
    PERFORM pg_advisory_xact_lock(1799876947, hashtext(p_referee::text));

    SELECT u.email_confirmed_at INTO v_confirmed FROM auth.users u WHERE u.id = p_referee;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_user');
    END IF;
    IF v_confirmed IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'email_not_verified');
    END IF;

    -- A referral already on record keeps its referrer; otherwise read the sign-up record.
    SELECT r.referrer_id, r.referral_code_used INTO v_referrer, v_number
      FROM public.referrals r WHERE r.referee_id = p_referee;
    IF v_referrer IS NULL THEN
        SELECT s.referrer_id, s.player_number INTO v_referrer, v_number
          FROM public.fn_signup_referrer(p_referee) s;
    END IF;
    IF v_referrer IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'reason', 'no_referral');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_referee) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_profile');
    END IF;

    INSERT INTO public.referrals (referrer_id, referee_id, referral_code_used, status)
    VALUES (v_referrer, p_referee, v_number, 'pending')
    ON CONFLICT (referee_id) DO NOTHING;

    UPDATE public.profiles SET referred_by = v_referrer
     WHERE id = p_referee AND referred_by IS NULL;

    v_referrer_r := public.award_diamonds_v2(
        v_referrer, 'referral_qualified',
        'referral_qualified_' || v_referrer || '_' || p_referee,
        p_referee::text,
        jsonb_build_object('referee_id', p_referee, 'source', 'fn_settle_signup_referral')
    );
    v_referee_r := public.award_diamonds_v2(
        p_referee, 'referral_referee',
        'referral_referee_' || p_referee || '_' || v_referrer,
        v_referrer::text,
        jsonb_build_object('referrer_id', v_referrer, 'source', 'fn_settle_signup_referral')
    );

    v_ok_referrer := COALESCE((v_referrer_r ->> 'success')::boolean, false)
        OR v_referrer_r ->> 'reason' = 'duplicate';
    v_ok_referee := COALESCE((v_referee_r ->> 'success')::boolean, false)
        OR v_referee_r ->> 'reason' IN ('duplicate', 'already_claimed');

    UPDATE public.referrals
       SET reward_claimed_referrer = v_ok_referrer,
           reward_claimed_referee  = v_ok_referee,
           status       = CASE WHEN v_ok_referrer AND v_ok_referee THEN 'completed' ELSE 'pending' END,
           completed_at = CASE WHEN v_ok_referrer AND v_ok_referee THEN COALESCE(completed_at, now()) ELSE completed_at END
     WHERE referee_id = p_referee;

    RETURN jsonb_build_object(
        'ok', v_ok_referrer AND v_ok_referee,
        'reason', CASE WHEN v_ok_referrer AND v_ok_referee THEN 'paid' ELSE 'award_refused' END,
        'referrer_id', v_referrer,
        'referrer', v_referrer_r,
        'referee', v_referee_r
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_signup_referrer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_signup_referral(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_signup_referral(uuid) TO service_role;

-- A referral never blocks a sign-up: the settlement runs in a savepoint.
CREATE OR REPLACE FUNCTION public.tr_auth_user_confirmed_settles_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    BEGIN
        PERFORM public.fn_settle_signup_referral(NEW.id);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'referral settlement for % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tr_auth_user_confirmed_settles_referral() FROM PUBLIC, anon, authenticated;

-- Named to sort after on_auth_user_created*, so the profile row exists first.
DROP TRIGGER IF EXISTS on_auth_user_email_confirmed_referral ON auth.users;
CREATE TRIGGER on_auth_user_email_confirmed_referral
    AFTER UPDATE OF email_confirmed_at ON auth.users
    FOR EACH ROW
    WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
    EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral();

DROP TRIGGER IF EXISTS on_auth_user_inserted_confirmed_referral ON auth.users;
CREATE TRIGGER on_auth_user_inserted_confirmed_referral
    AFTER INSERT ON auth.users
    FOR EACH ROW
    WHEN (NEW.email_confirmed_at IS NOT NULL)
    EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral();

-- Backfill: every confirmed account that arrived with a referral.
DO $$
DECLARE
    v_kingfish  constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
    v_expected  constant uuid[] := ARRAY[
        'ed50427d-046e-4685-b1f6-f3952442758a'::uuid,
        '41da1807-7cd1-4e0e-b60c-38ffe0d962e9'::uuid,
        'b52f183b-c0fc-4dcc-8d96-7d2a1cdb7216'::uuid
    ];
    v_before_k  bigint;
    v_after_k   bigint;
    v_settled   uuid[] := '{}';
    v_res       jsonb;
    r           record;
BEGIN
    SELECT diamonds INTO v_before_k FROM public.profiles WHERE id = v_kingfish;

    FOR r IN
        SELECT u.id
          FROM auth.users u
         WHERE u.email_confirmed_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.fn_signup_referrer(u.id))
         ORDER BY u.created_at
    LOOP
        v_res := public.fn_settle_signup_referral(r.id);
        IF NOT COALESCE((v_res ->> 'ok')::boolean, false) THEN
            RAISE EXCEPTION 'backfill: referral for % did not settle: %', r.id, v_res;
        END IF;
        v_settled := v_settled || r.id;
    END LOOP;

    IF array_length(v_settled, 1) IS DISTINCT FROM 3
       OR NOT (v_settled @> v_expected AND v_expected @> v_settled) THEN
        RAISE EXCEPTION 'backfill: expected exactly Papa, Dinodollars, TomTomTamale; settled %', v_settled;
    END IF;

    SELECT diamonds INTO v_after_k FROM public.profiles WHERE id = v_kingfish;
    IF v_after_k - v_before_k <> 1500 THEN
        RAISE EXCEPTION 'backfill: kingfish expected +1500, got %', v_after_k - v_before_k;
    END IF;

    IF (SELECT count(*) FROM public.referrals
         WHERE referee_id = ANY (v_expected) AND referrer_id = v_kingfish AND status = 'completed') <> 3 THEN
        RAISE EXCEPTION 'backfill: three completed referral rows expected';
    END IF;
    IF (SELECT count(*) FROM public.diamond_transactions
         WHERE user_id = ANY (v_expected) AND transaction_type = 'referral_referee' AND amount = 100) <> 3 THEN
        RAISE EXCEPTION 'backfill: each referee must hold exactly one 100 referral_referee credit';
    END IF;
END $$;

COMMIT;
