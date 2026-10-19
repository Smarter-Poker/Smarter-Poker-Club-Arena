-- 20261019092248_every_confirmed_referral_is_paid_once_and_the_pending_one_co.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TIER:         3 (diamond payouts)
-- AUTHOR:       Claude (session 01NeFtpaosJDSLE13ps9HZgX), Phase 1A of Dan's
--               launch-day programme ("START PHASE 1."), on his 2026-10-17
--               instruction "YES PAY OUT DIAMONDS FOR ALL REFERRALS".
-- SUPERSEDES:   20261017223126_a_referral_is_recorded_and_paid_when_the_new_player_confirms.sql
--               (merged in #7326, never installed; now marked SUPERSEDED BY
--               this version on its first line so it can never run).
-- AFFECTS:      public.referrals, public.profiles.referred_by,
--               public.diamond_transactions (only through award_diamonds_v2),
--               new fn_signup_referrer, fn_settle_signup_referral, two trigger
--               functions, two triggers on auth.users, one on public.referrals.
-- IRREVERSIBLE: the backfill payouts are (diamonds are never clawed back);
--               the functions and triggers are reversible (rollback below).
--
-- WHAT WAS WRONG, READ FROM ROWS ON 2026-10-19:
--
--   * The 2026-10-17 file merged but was never installed: it is absent from
--     supabase_migrations.schema_migrations and none of its functions or
--     triggers exist. No referral has ever been paid: zero referral_*
--     diamond_transactions rows exist.
--   * It could not be installed as written. Its backfill accepted EXACTLY
--     Papa, Dinodollars and TomTomTamale and aborted on anything else. A
--     fourth player, ChaseOryan45 (signed up 2026-10-18 17:04 UTC on kingfish's
--     invite link, email confirmed 17:05:29.508), has since confirmed, so the
--     old file would abort the whole transaction.
--   * ChaseOryan45 already has a public.referrals row (c4966bba..., status
--     'pending', neither reward claimed). fn_club_invite_claim wrote it 0.3 s
--     AFTER his email was confirmed. That ordering is the live gap: a
--     confirmation trigger alone fires before the row exists, so a referral
--     whose sign-up record did not carry the invite link would stay pending
--     for ever. fn_club_invite_claim pays nothing; it only records.
--
-- WHAT THIS DOES:
--
--   * fn_settle_signup_referral(referee) stays the ONE place a referral is
--     recorded and paid (500 referral_qualified to the referrer, 100
--     referral_referee to the new player, through award_diamonds_v2 with the
--     reference ids /api/rewards/referral always used, so no door pays twice).
--     A referral already on record keeps its referrer; an existing PENDING row
--     is completed: the INSERT is ON CONFLICT DO NOTHING and the UPDATE after
--     the two awards sets status 'completed', both reward flags and
--     completed_at. A self-referral is refused.
--   * It settles at whichever of the two facts arrives LAST:
--       - the email is confirmed (UPDATE of email_confirmed_at) or the account
--         is created already confirmed (INSERT, e.g. OAuth): triggers on
--         auth.users;
--       - the referral row is recorded (fn_club_invite_claim's INSERT into
--         public.referrals): a trigger on public.referrals.
--     Each trigger runs the settlement in a savepoint, so a referral can never
--     fail a sign-up or an invite claim. A settlement in progress marks itself
--     (ca.settling_referral) so its own INSERT does not re-enter it.
--   * Backfill: every confirmed account that arrived with a referral - from
--     its sign-up record OR from a public.referrals row - is settled now. The
--     set is found at run time, never hard-coded. Proved first in a
--     self-aborting probe on 2026-10-19 (one call, one DO block ending in
--     RAISE EXCEPTION), which found exactly four, all referred by kingfish
--     (player #1, 47965354-...) through his Club Arena invite link:
--       Papa          ed50427d-...  +100, kingfish +500
--       Dinodollars   41da1807-...  +100, kingfish +500
--       TomTomTamale  b52f183b-...  +100, kingfish +500
--       ChaseOryan45  b8645a41-...  +100, kingfish +500 (pending row completed)
--     kingfish +2,000 in all; 2,400 diamonds issued. Every multiplier involved
--     is 1.00. The assertions below require those four, require every settled
--     referral to hold exactly one 100 referee credit and exactly one 500
--     referrer credit under the canonical reference ids, and require every
--     referral row to be completed. A player who confirms between the probe
--     and the install is settled by the same rule and checked the same way.
--     MrWick007 (same link, email still unconfirmed) is paid by the trigger
--     the moment he confirms.
--   * Idempotent: a second call of fn_settle_signup_referral for the same
--     player pays nobody and leaves the row completed. "Paid" is read from the
--     journal rows under the canonical references, not from the refusal's
--     reason: the 2026-10-19 probe showed a same-day repeat is refused
--     'action_limit' (referral_referee is one a day), which the 2026-10-17
--     file read as unpaid and used to flip a completed row back to pending.
--     A completed row is never downgraded.
--
-- WHY THIS IS NOT A BAND-AID (CLAUDE.md 10.12): no job, sweep or reconciler is
-- added. The live paths themselves pay, at the moment the second fact lands.
-- The backfill is the one-time settlement of damage already done (10.9).
--
-- PRE-IMAGE: this replaces no live function (the preflight refuses if any of
-- the new names already exists). award_diamonds_v2 is called, not changed.
--
-- ROLLBACK (reverts the mechanism; payouts already made stay paid):
--   BEGIN;
--   DROP TRIGGER IF EXISTS on_referral_recorded_settles_referral ON public.referrals;
--   DROP TRIGGER IF EXISTS on_auth_user_email_confirmed_referral ON auth.users;
--   DROP TRIGGER IF EXISTS on_auth_user_inserted_confirmed_referral ON auth.users;
--   DROP FUNCTION IF EXISTS public.tr_referral_recorded_settles_referral();
--   DROP FUNCTION IF EXISTS public.tr_auth_user_confirmed_settles_referral();
--   DROP FUNCTION IF EXISTS public.fn_settle_signup_referral(uuid);
--   DROP FUNCTION IF EXISTS public.fn_signup_referrer(uuid);
--   COMMIT;
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- Triggers land on auth.users and public.referrals: never queue sign-ups
-- behind this. The triggers are created LAST so the lock is held briefly.
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
    IF to_regprocedure('public.award_diamonds_v2(uuid,text,text,text,jsonb)') IS NULL THEN
        RAISE EXCEPTION 'pre-flight failed: award_diamonds_v2 not found';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.referrals'::regclass AND contype = 'u'
           AND pg_get_constraintdef(oid) = 'UNIQUE (referee_id)'
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: referrals.referee_id is not unique';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.diamond_reward_catalog
                    WHERE action_key = 'referral_qualified' AND active AND diamonds = 500)
       OR NOT EXISTS (SELECT 1 FROM public.diamond_reward_catalog
                       WHERE action_key = 'referral_referee' AND active AND diamonds = 100 AND lifetime) THEN
        RAISE EXCEPTION 'pre-flight failed: referral catalog rows are not 500 qualified / 100 lifetime referee';
    END IF;
    IF to_regprocedure('public.fn_signup_referrer(uuid)') IS NOT NULL
       OR to_regprocedure('public.fn_settle_signup_referral(uuid)') IS NOT NULL
       OR to_regprocedure('public.tr_auth_user_confirmed_settles_referral()') IS NOT NULL
       OR to_regprocedure('public.tr_referral_recorded_settles_referral()') IS NOT NULL THEN
        RAISE EXCEPTION 'pre-flight failed: a referral settlement function already exists; this migration replaces nothing';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname IN ('on_auth_user_email_confirmed_referral',
                                 'on_auth_user_inserted_confirmed_referral',
                                 'on_referral_recorded_settles_referral')) THEN
        RAISE EXCEPTION 'pre-flight failed: a referral settlement trigger already exists';
    END IF;
END $preflight$;

-- The referrer a new account arrived with, from its own sign-up record.
CREATE OR REPLACE FUNCTION public.fn_signup_referrer(p_referee uuid)
RETURNS TABLE (referrer_id uuid, player_number text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_meta jsonb;
    v_num  text;
BEGIN
    SELECT u.raw_user_meta_data INTO v_meta FROM auth.users u WHERE u.id = p_referee;
    IF v_meta IS NULL THEN RETURN; END IF;

    v_num := NULLIF(btrim(v_meta ->> 'referral_player_number'), '');
    -- A typed or shared legacy referral code (SP-56737B) names its owner directly.
    IF v_num IS NULL AND NULLIF(btrim(v_meta ->> 'referral_code'), '') IS NOT NULL THEN
        RETURN QUERY
            SELECT p.id, p.player_number
              FROM public.profiles p
             WHERE p.referral_code = upper(btrim(v_meta ->> 'referral_code'))
               AND p.id <> p_referee;
        RETURN;
    END IF;
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
$fn$;

CREATE OR REPLACE FUNCTION public.fn_settle_signup_referral(p_referee uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
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

    -- One settlement per new player at a time (the triggers and the endpoint can race).
    PERFORM pg_advisory_xact_lock(1799876947, hashtext(p_referee::text));
    -- This settlement's own INSERT into public.referrals must not re-enter it
    -- through on_referral_recorded_settles_referral.
    PERFORM set_config('ca.settling_referral', p_referee::text, true);

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
    IF v_referrer = p_referee THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'self_referral');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_referee) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_profile');
    END IF;

    -- A pending row (fn_club_invite_claim records one) is kept and completed below.
    INSERT INTO public.referrals (referrer_id, referee_id, referral_code_used, status)
    VALUES (v_referrer, p_referee, COALESCE(v_number, ''), 'pending')
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

    -- Paid is read from the journal, never from the refusal's wording. A
    -- repeat call the same day is refused 'action_limit' (referral_referee is
    -- one a day) before 'already_claimed' is ever reached, and must not undo a
    -- completed referral.
    v_ok_referrer := COALESCE((v_referrer_r ->> 'success')::boolean, false)
        OR EXISTS (SELECT 1 FROM public.diamond_transactions t
                    WHERE t.user_id = v_referrer AND t.amount > 0
                      AND t.reference_id = 'referral_qualified_' || v_referrer || '_' || p_referee);
    v_ok_referee := COALESCE((v_referee_r ->> 'success')::boolean, false)
        OR EXISTS (SELECT 1 FROM public.diamond_transactions t
                    WHERE t.user_id = p_referee AND t.amount > 0
                      AND t.transaction_type = 'referral_referee');

    UPDATE public.referrals
       SET reward_claimed_referrer = COALESCE(reward_claimed_referrer, false) OR v_ok_referrer,
           reward_claimed_referee  = COALESCE(reward_claimed_referee, false) OR v_ok_referee,
           status       = CASE WHEN v_ok_referrer AND v_ok_referee THEN 'completed' ELSE status END,
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
$fn$;

REVOKE ALL ON FUNCTION public.fn_signup_referrer(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_signup_referral(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_signup_referral(uuid) TO service_role;

-- A referral never blocks a sign-up: the settlement runs in a savepoint.
CREATE OR REPLACE FUNCTION public.tr_auth_user_confirmed_settles_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
    BEGIN
        PERFORM public.fn_settle_signup_referral(NEW.id);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'referral settlement for % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tr_auth_user_confirmed_settles_referral() FROM PUBLIC, anon, authenticated;

-- A referral recorded after the email was confirmed (fn_club_invite_claim runs
-- after confirmation) is settled the moment it is recorded. Never blocks the claim.
CREATE OR REPLACE FUNCTION public.tr_referral_recorded_settles_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
    IF current_setting('ca.settling_referral', true) IS DISTINCT FROM NEW.referee_id::text THEN
        BEGIN
            PERFORM public.fn_settle_signup_referral(NEW.referee_id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'referral settlement for % failed: % (%)', NEW.referee_id, SQLERRM, SQLSTATE;
        END;
    END IF;
    RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tr_referral_recorded_settles_referral() FROM PUBLIC, anon, authenticated;

-- Backfill: every confirmed account that arrived with a referral, found at run time.
DO $backfill$
DECLARE
    c_kingfish   constant uuid := '47965354-0e56-43ef-931c-ddaab82af765';
    -- The four the 2026-10-19 probe found. Each must be among those settled.
    c_probed     constant uuid[] := ARRAY[
        'ed50427d-046e-4685-b1f6-f3952442758a'::uuid,  -- Papa
        '41da1807-7cd1-4e0e-b60c-38ffe0d962e9'::uuid,  -- Dinodollars
        'b52f183b-c0fc-4dcc-8d96-7d2a1cdb7216'::uuid,  -- TomTomTamale
        'b8645a41-f619-4c0e-accd-5c4779120583'::uuid   -- ChaseOryan45 (pending row)
    ];
    v_settled    uuid[] := '{}';
    v_res        jsonb;
    v_referrer   uuid;
    v_n          integer;
    v_amt        bigint;
    v_kingfish_owed  bigint := 0;
    v_kingfish_paid  bigint;
    v_issued     bigint;
    v_pre_refs   integer;
    r            record;
BEGIN
    -- Credits that already existed under the canonical references (none on
    -- 2026-10-19). What this run must issue is derived from what is missing.
    SELECT count(*) INTO v_pre_refs FROM public.diamond_transactions t
     WHERE t.transaction_type IN ('referral_qualified', 'referral_referee')
       AND (t.reference_id LIKE 'referral_qualified_%' OR t.reference_id LIKE 'referral_referee_%');

    FOR r IN
        SELECT u.id
          FROM auth.users u
         WHERE u.email_confirmed_at IS NOT NULL
           AND (EXISTS (SELECT 1 FROM public.fn_signup_referrer(u.id))
                OR EXISTS (SELECT 1 FROM public.referrals x WHERE x.referee_id = u.id))
         ORDER BY u.created_at, u.id
    LOOP
        v_res := public.fn_settle_signup_referral(r.id);
        IF NOT COALESCE((v_res ->> 'ok')::boolean, false) THEN
            RAISE EXCEPTION 'backfill: referral for % did not settle: %', r.id, v_res;
        END IF;
        v_settled := v_settled || r.id;
    END LOOP;

    IF NOT (v_settled @> c_probed) THEN
        RAISE EXCEPTION 'backfill: expected Papa, Dinodollars, TomTomTamale and ChaseOryan45 among the settled; settled %', v_settled;
    END IF;

    FOR r IN SELECT unnest(v_settled) AS referee LOOP
        SELECT x.referrer_id INTO v_referrer FROM public.referrals x
         WHERE x.referee_id = r.referee AND x.status = 'completed'
           AND x.reward_claimed_referrer AND x.reward_claimed_referee AND x.completed_at IS NOT NULL;
        IF v_referrer IS NULL THEN
            RAISE EXCEPTION 'backfill: referral row for % is not completed with both rewards claimed', r.referee;
        END IF;
        IF r.referee = ANY (c_probed) AND v_referrer <> c_kingfish THEN
            RAISE EXCEPTION 'backfill: % was expected to be referred by kingfish, found %', r.referee, v_referrer;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.referee AND p.referred_by = v_referrer) THEN
            RAISE EXCEPTION 'backfill: profiles.referred_by for % is not its referrer', r.referee;
        END IF;

        SELECT count(*), COALESCE(sum(t.amount), 0) INTO v_n, v_amt FROM public.diamond_transactions t
         WHERE t.user_id = r.referee AND t.transaction_type = 'referral_referee' AND t.amount > 0;
        IF v_n <> 1 OR v_amt <> 100 THEN
            RAISE EXCEPTION 'backfill: % must hold exactly one 100 referral_referee credit; found % rows totalling %', r.referee, v_n, v_amt;
        END IF;

        SELECT count(*), COALESCE(sum(t.amount), 0) INTO v_n, v_amt FROM public.diamond_transactions t
         WHERE t.user_id = v_referrer AND t.transaction_type = 'referral_qualified'
           AND t.reference_id = 'referral_qualified_' || v_referrer || '_' || r.referee;
        IF v_n <> 1 OR v_amt <> 500 THEN
            RAISE EXCEPTION 'backfill: referrer % must hold exactly one 500 credit for %; found % rows totalling %', v_referrer, r.referee, v_n, v_amt;
        END IF;
        IF v_referrer = c_kingfish THEN
            v_kingfish_owed := v_kingfish_owed + 500;
        END IF;
    END LOOP;

    -- kingfish: 500 per referee settled here, all issued by this transaction.
    SELECT COALESCE(sum(t.amount), 0) INTO v_kingfish_paid FROM public.diamond_transactions t
     WHERE t.user_id = c_kingfish AND t.transaction_type = 'referral_qualified' AND t.created_at = now();
    IF v_pre_refs = 0 AND v_kingfish_paid <> v_kingfish_owed THEN
        RAISE EXCEPTION 'backfill: kingfish expected +% from this settlement, got +%', v_kingfish_owed, v_kingfish_paid;
    END IF;
    IF v_kingfish_owed < 2000 THEN
        RAISE EXCEPTION 'backfill: kingfish is owed at least 2000 (four referees); derived %', v_kingfish_owed;
    END IF;

    -- Everything this transaction issued is exactly 600 per referral settled now.
    SELECT COALESCE(sum(t.amount), 0) INTO v_issued FROM public.diamond_transactions t
     WHERE t.transaction_type IN ('referral_qualified', 'referral_referee') AND t.created_at = now();
    IF v_pre_refs = 0 AND v_issued <> 600 * array_length(v_settled, 1) THEN
        RAISE EXCEPTION 'backfill: expected % diamonds issued (600 x % referrals), got %',
            600 * array_length(v_settled, 1), array_length(v_settled, 1), v_issued;
    END IF;

    RAISE NOTICE 'referral backfill: settled % referrals, issued %, kingfish +%',
        array_length(v_settled, 1), v_issued, v_kingfish_paid;
END $backfill$;

-- Named to sort after on_auth_user_created*, so the profile row exists first.
-- No DROP TRIGGER IF EXISTS: the preflight already proved none exists, and a
-- DROP takes ACCESS EXCLUSIVE on auth.users, which would stall every sign-in
-- until COMMIT. CREATE TRIGGER takes SHARE ROW EXCLUSIVE, which readers pass.
CREATE TRIGGER on_auth_user_email_confirmed_referral
    AFTER UPDATE OF email_confirmed_at ON auth.users
    FOR EACH ROW
    WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
    EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral();

CREATE TRIGGER on_auth_user_inserted_confirmed_referral
    AFTER INSERT ON auth.users
    FOR EACH ROW
    WHEN (NEW.email_confirmed_at IS NOT NULL)
    EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral();

CREATE TRIGGER on_referral_recorded_settles_referral
    AFTER INSERT ON public.referrals
    FOR EACH ROW
    WHEN (NEW.status = 'pending' AND NEW.referee_id IS NOT NULL)
    EXECUTE FUNCTION public.tr_referral_recorded_settles_referral();

-- Post-image: the installed bodies are the bodies in this file, the doors are
-- closed to browsers, and the three triggers are armed.
DO $postimage$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(e.sig || ' expected ' || e.md5 || ' got ' || COALESCE(md5(p.prosrc), 'missing'), '; ')
      INTO v_bad
      FROM (VALUES
          ('public.fn_signup_referrer(uuid)', '30dd8ec201510e12f2d8e69a24fb0eda'),
          ('public.fn_settle_signup_referral(uuid)', '339778bf71c7df28520c718d7c8bc0c1'),
          ('public.tr_auth_user_confirmed_settles_referral()', 'c9cff0b39a39c8d3406d0bf203ba4090'),
          ('public.tr_referral_recorded_settles_referral()', 'ce8f326fcee5a4d917b62fd5b1f280c4')
      ) AS e(sig, md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
     WHERE p.oid IS NULL OR md5(p.prosrc) <> e.md5;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'post-image: installed bodies differ from this file: %', v_bad;
    END IF;

    IF has_function_privilege('anon', 'public.fn_settle_signup_referral(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.fn_settle_signup_referral(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.fn_signup_referrer(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.fn_signup_referrer(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.fn_settle_signup_referral(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-image: referral settlement privileges are not service-role only';
    END IF;

    IF (SELECT count(*) FROM pg_trigger t
         WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
           AND ((t.tgrelid = 'auth.users'::regclass AND t.tgname IN
                    ('on_auth_user_email_confirmed_referral', 'on_auth_user_inserted_confirmed_referral'))
             OR (t.tgrelid = 'public.referrals'::regclass AND t.tgname = 'on_referral_recorded_settles_referral'))) <> 3 THEN
        RAISE EXCEPTION 'post-image: the three referral settlement triggers are not all armed';
    END IF;
END $postimage$;

COMMIT;
