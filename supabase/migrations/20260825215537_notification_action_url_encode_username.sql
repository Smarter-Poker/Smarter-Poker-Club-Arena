-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825215537; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- Follow-up to notification_action_url_backfill.
--
-- WHY: that migration built profile deep links as '/hub/user/' || username,
-- and 232 of 906 usernames (26%) contain characters that are not legal in a
-- URL path segment unencoded -- spaces ('solver steve'), apostrophes
-- ("chase o'ryan"), '@' ('@todd'), and non-ASCII ('ö', 'ü'). Those went into
-- action_url raw, which is exactly the column the push-outbox trigger uses
-- as the notification URL, so a quarter of all friend/follow pushes carried
-- a malformed link.
--
-- HOW: percent-encode the username segment (RFC 3986 unreserved set kept as
-- is, everything else encoded per UTF-8 byte), then re-run the backfill for
-- the affected rows only.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_url_encode_segment(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p IS NULL THEN NULL ELSE COALESCE((
        SELECT string_agg(
            CASE WHEN s.c ~ '^[A-Za-z0-9._~-]$' THEN s.c
                 ELSE (SELECT string_agg('%' || upper(lpad(to_hex(get_byte(convert_to(s.c,'UTF8'), i)), 2, '0')), '')
                       FROM generate_series(0, octet_length(convert_to(s.c,'UTF8')) - 1) AS i)
            END, '' ORDER BY s.ord)
        FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, ord)
    ), '') END;
$$;

COMMENT ON FUNCTION public.fn_url_encode_segment(text) IS
    'Percent-encode one URL path segment (RFC 3986 unreserved kept). Used by fn_notification_action_url because 26% of usernames contain spaces, apostrophes, @ or non-ASCII.';

-- Rebuild the friend/follow branch to encode the username.
CREATE OR REPLACE FUNCTION public.fn_notification_action_url(
    p_type text, p_data jsonb, p_metadata jsonb
) RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE
    d          jsonb := COALESCE(p_metadata, '{}'::jsonb) || COALESCE(p_data, '{}'::jsonb);
    t          text  := COALESCE(btrim(p_type), '');
    ca         text  := '/hub/club-arena';
    v_table    text  := COALESCE(d->>'table_id',      d->>'tableId');
    v_union    text  := COALESCE(d->>'union_id',      d->>'unionId');
    v_club     text  := COALESCE(d->>'club_id',       d->>'clubId');
    v_post     text  := COALESCE(d->>'post_id',       d->>'postId');
    v_tourn    text  := COALESCE(d->>'tournament_id', d->>'tournamentId');
    v_convo    text  := COALESCE(d->>'conversation_id', d->>'conversationId');
    v_pagetype text  := COALESCE(d->>'page_type',     d->>'pageType');
    v_pageid   text  := COALESCE(d->>'page_id',       d->>'pageId');
    v_sender   text  := COALESCE(d->>'sender_id',     d->>'actor_id', d->>'senderId');
    v_username text;
    v_is_reel  boolean := (d->>'is_reel') = 'true' OR (d->>'post_type') = 'reel';
BEGIN
    IF t IN ('waitlist_seat_open','seat_available','waitlist_ready','table_ready') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE ca || '/waitlist' END;
    END IF;
    IF t IN ('table_invite','your_turn','your_turn_reminder','time_bank_active','hand_won') THEN
        RETURN CASE WHEN v_table IS NOT NULL THEN ca || '/table/' || v_table ELSE NULL END;
    END IF;
    IF t IN ('tournament_starting','tournament_start','tournament_registered') THEN
        RETURN CASE WHEN v_tourn IS NOT NULL THEN ca || '/tournaments/' || v_tourn ELSE ca || '/tournaments' END;
    END IF;
    IF t = 'union_invoice' THEN
        RETURN CASE WHEN v_union IS NOT NULL THEN ca || '/unions/' || v_union || '/statements' ELSE ca || '/unions' END;
    END IF;
    IF t IN ('settlement','settlement_failed') THEN
        IF v_union IS NOT NULL THEN RETURN ca || '/unions/' || v_union || '/settlement'; END IF;
        IF v_club  IS NOT NULL THEN RETURN ca || '/clubs/'  || v_club  || '/settlement'; END IF;
        RETURN ca || '/settlement-dashboard';
    END IF;
    IF t IN ('cashout_request','cashout_approved','cashout_denied') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/financials' ELSE ca || '/wallet' END;
    END IF;
    IF t IN ('club_announcement','club_invite') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club ELSE NULL END;
    END IF;
    IF t IN ('bonus','promotion','rakeback') THEN
        RETURN CASE WHEN v_club IS NOT NULL THEN ca || '/clubs/' || v_club || '/promotions' ELSE ca || '/bonuses' END;
    END IF;
    IF t IN ('achievement','achievement_unlocked') THEN
        RETURN ca || '/achievements';
    END IF;
    IF t IN ('like','comment','mention','post_like','post_comment','reply','tag') THEN
        IF v_post IS NOT NULL THEN
            RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
        END IF;
        RETURN '/hub/social-media';
    END IF;
    IF t IN ('friend_request','friend_accept','friend_accepted','new_follow','follow','follow_request') THEN
        IF v_sender IS NOT NULL THEN
            BEGIN
                SELECT username INTO v_username FROM public.profiles WHERE id = v_sender::uuid LIMIT 1;
            EXCEPTION WHEN OTHERS THEN
                v_username := NULL;
            END;
        END IF;
        RETURN CASE WHEN v_username IS NOT NULL AND btrim(v_username) <> ''
                    THEN '/hub/user/' || public.fn_url_encode_segment(v_username)
                    ELSE '/hub/friends' END;
    END IF;
    IF t IN ('message','direct_message','new_message') THEN
        RETURN CASE WHEN v_convo IS NOT NULL THEN '/hub/messenger?conversation=' || v_convo ELSE '/hub/messenger' END;
    END IF;
    IF v_pagetype IS NOT NULL AND v_pageid IS NOT NULL THEN
        IF v_pagetype = 'venue'  THEN RETURN '/hub/venues/' || v_pageid; END IF;
        IF v_pagetype = 'tour'   THEN RETURN '/hub/tours/'  || v_pageid; END IF;
        IF v_pagetype = 'series' THEN RETURN '/hub/series/' || v_pageid; END IF;
        RETURN '/club/' || v_pageid;
    END IF;
    IF v_club   IS NOT NULL THEN RETURN '/club/' || v_club; END IF;
    IF v_pageid IS NOT NULL THEN RETURN '/hub/social-pages/' || v_pageid; END IF;
    IF v_post   IS NOT NULL THEN
        RETURN CASE WHEN v_is_reel THEN '/hub/reels?id=' || v_post ELSE '/hub/social-media?post=' || v_post END;
    END IF;
    IF v_tourn  IS NOT NULL THEN RETURN ca || '/tournaments/' || v_tourn; END IF;
    IF v_table  IS NOT NULL THEN RETURN ca || '/table/' || v_table; END IF;
    RETURN NULL;
END $fn$;

-- Repair the rows the first backfill wrote with an unencoded username.
UPDATE public.notifications n
SET    action_url = public.fn_notification_action_url(n.type, n.data, n.metadata)
WHERE  n.type IN ('friend_request','friend_accept','friend_accepted','new_follow','follow','follow_request')
  AND  n.action_url LIKE '/hub/user/%'
  AND  n.action_url ~ '[^A-Za-z0-9._~/%-]';

DO $$
DECLARE
    v_bad int;
    v_mb  text;
BEGIN
    -- No stored profile link may contain a character illegal in a path segment.
    SELECT count(*) INTO v_bad
    FROM public.notifications
    WHERE action_url LIKE '/hub/user/%'
      AND action_url ~ '[^A-Za-z0-9._~/%-]';
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % profile action_urls still contain unencoded characters', v_bad;
    END IF;

    -- Multibyte must encode per UTF-8 byte, not per character.
    v_mb := public.fn_url_encode_segment(U&'j\00F6rg');
    IF v_mb <> 'j%C3%B6rg' THEN
        RAISE EXCEPTION 'post-apply failed: multibyte encoding wrong, got %', v_mb;
    END IF;

    IF public.fn_url_encode_segment('solver steve') <> 'solver%20steve' THEN
        RAISE EXCEPTION 'post-apply failed: space encoding wrong';
    END IF;
END $$;
