-- ROOT CAUSE of the 02:10 diamond critical (incident 2aec3eee, 208,000
-- unexplained): handle_new_user grants every new profile 500 diamonds by
-- writing profiles.diamonds directly and never journals it. 417 signups in
-- one hour (bot-fleet burst) = 208,000 diamonds of supply with no
-- diamond_transactions rows. The zero-drift law is every movement journals
-- at the source, so the signup grant now writes its own journal row - only
-- when the grant actually changed supply in this transaction (fresh profile,
-- or a 0-balance top-up), deduped per user, so re-auth of an old
-- 500-diamond account can never inject a phantom journal row.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_player_num BIGINT;
    generated_username TEXT;
    resolved_full_name TEXT;
    v_first_name TEXT;
    v_last_name TEXT;
    v_prev_diamonds INTEGER;
    v_now_diamonds INTEGER;
BEGIN
    resolved_full_name := COALESCE(
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
        NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'name', '')), ''),
        NULLIF(TRIM(
            COALESCE(NEW.raw_user_meta_data->>'given_name', '') || ' ' ||
            COALESCE(NEW.raw_user_meta_data->>'family_name', '')
        ), ''),
        ''
    );

    v_first_name := COALESCE(NEW.raw_user_meta_data->>'first_name', '');
    v_last_name  := COALESCE(NEW.raw_user_meta_data->>'last_name',  '');

    IF v_first_name = '' AND v_last_name = '' AND resolved_full_name <> '' THEN
        v_first_name := split_part(resolved_full_name, ' ', 1);
        v_last_name  := CASE
            WHEN position(' ' in resolved_full_name) > 0
            THEN substring(resolved_full_name from position(' ' in resolved_full_name) + 1)
            ELSE ''
        END;
    END IF;

    generated_username := COALESCE(
        NULLIF(NEW.raw_user_meta_data->>'poker_alias', ''),
        NULLIF(REGEXP_REPLACE(resolved_full_name, '[^a-zA-Z0-9]', '', 'g'), ''),
        SPLIT_PART(COALESCE(NEW.email, ''), '@', 1),
        'Player' || FLOOR(RANDOM() * 10000)::TEXT
    );
    generated_username := LEFT(generated_username, 15);

    -- If the derived username is reserved, fall back to Player<N> so the row
    -- never lands as @admin / @support / @smarterpoker / etc.
    IF public.is_reserved_username(generated_username) THEN
        generated_username := 'Player' || FLOOR(RANDOM() * 100000)::TEXT;
    END IF;

    SELECT nextval('public.profiles_player_number_seq') INTO next_player_num;

    -- ZERO-DRIFT: remember the pre-upsert balance so the signup grant can
    -- journal itself exactly when it changes supply, and never otherwise.
    SELECT diamonds INTO v_prev_diamonds FROM public.profiles WHERE id = NEW.id;

    INSERT INTO public.profiles (
        id, full_name, first_name, last_name, email, username, avatar_url,
        player_number, streak_count, diamonds, diamond_balance, diamond_multiplier, skill_tier,
        access_tier, is_vip, vip_tier, vip_expires_at,
        created_at, updated_at, last_login, last_active, is_online
    ) VALUES (
        NEW.id, resolved_full_name, v_first_name, v_last_name,
        COALESCE(NEW.email, ''), generated_username,
        COALESCE(NEW.raw_user_meta_data->>'avatar_url',
                 NEW.raw_user_meta_data->>'picture', ''),
        next_player_num, 0, 500, 500, 1.0, 'Newcomer',
        CASE
            WHEN NEW.raw_user_meta_data->>'state' IN ('WA','ID','MI','NV','CA') THEN 'Restricted_Tier'
            ELSE 'Full_Access'
        END,
        true, 'monthly', NOW() + INTERVAL '30 days',
        NOW(), NOW(), NOW(), NOW(), true
    )
    ON CONFLICT (id) DO UPDATE SET
        last_login    = NOW(),
        last_active   = NOW(),
        is_online     = true,
        full_name     = CASE WHEN COALESCE(profiles.full_name, '') = '' THEN EXCLUDED.full_name ELSE profiles.full_name END,
        first_name    = CASE WHEN COALESCE(profiles.first_name, '') = '' THEN EXCLUDED.first_name ELSE profiles.first_name END,
        last_name     = CASE WHEN COALESCE(profiles.last_name, '') = '' THEN EXCLUDED.last_name ELSE profiles.last_name END,
        avatar_url    = CASE WHEN COALESCE(profiles.avatar_url, '') = '' THEN EXCLUDED.avatar_url ELSE profiles.avatar_url END,
        player_number = COALESCE(profiles.player_number, EXCLUDED.player_number),
        diamonds      = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        diamond_balance = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        is_vip        = CASE WHEN profiles.is_vip IS NULL OR profiles.is_vip = false THEN true ELSE profiles.is_vip END,
        vip_tier      = CASE WHEN profiles.vip_tier IS NULL THEN 'monthly' ELSE profiles.vip_tier END,
        vip_expires_at= CASE WHEN profiles.vip_expires_at IS NULL THEN NOW() + INTERVAL '30 days' ELSE profiles.vip_expires_at END;

    SELECT diamonds INTO v_now_diamonds FROM public.profiles WHERE id = NEW.id;

    -- The grant fired (0 or no balance became 500): journal it. Deduped per
    -- user so a later re-auth can never double-journal, and skipped entirely
    -- when the upsert left an existing balance alone (no supply change).
    IF COALESCE(v_prev_diamonds, 0) = 0 AND v_now_diamonds = 500 THEN
        INSERT INTO public.diamond_transactions
            (user_id, type, amount, balance_after, description, reference_id, source)
        SELECT NEW.id, 'signup_bonus', 500, 500,
               'Signup Grant Journaled At Creation', 'signup:' || NEW.id::text, 'handle_new_user'
        WHERE NOT EXISTS (
            SELECT 1 FROM public.diamond_transactions t
             WHERE t.user_id = NEW.id AND t.type = 'signup_bonus');
    END IF;

    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    -- Defensive: never block auth.users INSERT, but DO leave a forensic trail.
    BEGIN
      INSERT INTO public.signup_errors (user_id, email, trigger_name, error_code, error_msg, raw_meta)
      VALUES (NEW.id, NEW.email, 'handle_new_user', SQLSTATE, SQLERRM, NEW.raw_user_meta_data);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NEW;
END;
$function$;

-- Self-contained ACL (repo mirror requirement): trigger function, never
-- browser-callable, but the migration says so itself.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role, supabase_auth_admin;
