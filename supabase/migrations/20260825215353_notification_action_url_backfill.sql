-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825215353; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- See supabase/migrations/20260825120000_notification_action_url_backfill.sql
-- in Smarter-Poker-World-Hub for the full header and rollback notes.
-- WHY: fn_mirror_notification_to_push_outbox builds the push URL as
-- COALESCE(link, action_url, '/hub'), so ~5,700 notifications with neither
-- column set sent pushes that opened the generic hub instead of the thing
-- they were about. Mirrors src/lib/notificationRoute.js (authoritative for
-- in-app routing); change both together.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name='notifications') THEN
        RAISE EXCEPTION 'pre-flight failed: public.notifications not found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='notifications' AND column_name='action_url') THEN
        RAISE EXCEPTION 'pre-flight failed: notifications.action_url not found';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='notifications' AND column_name='data') THEN
        RAISE EXCEPTION 'pre-flight failed: notifications.data not found';
    END IF;
END $$;

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
                    THEN '/hub/user/' || v_username ELSE '/hub/friends' END;
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

COMMENT ON FUNCTION public.fn_notification_action_url(text, jsonb, jsonb) IS
    'Default deep-link for a notification. Mirrors src/lib/notificationRoute.js in Smarter-Poker-World-Hub; that file is authoritative for in-app routing, this exists so push notifications have a durable URL. Change both together.';

CREATE OR REPLACE FUNCTION public.fn_notification_fill_action_url()
RETURNS trigger LANGUAGE plpgsql AS $tg$
BEGIN
    IF NULLIF(btrim(COALESCE(NEW.link, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.action_url, '')), '') IS NULL THEN
        BEGIN
            NEW.action_url := public.fn_notification_action_url(NEW.type, NEW.data, NEW.metadata);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'fn_notification_fill_action_url failed for type %: %', NEW.type, SQLERRM;
        END;
    END IF;
    RETURN NEW;
END $tg$;

DROP TRIGGER IF EXISTS trg_notification_fill_action_url ON public.notifications;
CREATE TRIGGER trg_notification_fill_action_url
    BEFORE INSERT ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.fn_notification_fill_action_url();

UPDATE public.notifications n
SET    action_url = public.fn_notification_action_url(n.type, n.data, n.metadata)
WHERE  NULLIF(btrim(COALESCE(n.link, '')), '') IS NULL
  AND  NULLIF(btrim(COALESCE(n.action_url, '')), '') IS NULL
  AND  public.fn_notification_action_url(n.type, n.data, n.metadata) IS NOT NULL;

DO $$
DECLARE
    v_dead_seat  int;
    v_dead_union int;
    v_sample     text;
BEGIN
    SELECT count(*) INTO v_dead_seat FROM public.notifications
    WHERE type='waitlist_seat_open' AND data ? 'table_id'
      AND NULLIF(btrim(COALESCE(action_url,'')),'') IS NULL
      AND NULLIF(btrim(COALESCE(link,'')),'') IS NULL;
    IF v_dead_seat > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % waitlist_seat_open rows still have no destination', v_dead_seat;
    END IF;

    SELECT count(*) INTO v_dead_union FROM public.notifications
    WHERE type='union_invoice' AND data ? 'union_id'
      AND NULLIF(btrim(COALESCE(action_url,'')),'') IS NULL
      AND NULLIF(btrim(COALESCE(link,'')),'') IS NULL;
    IF v_dead_union > 0 THEN
        RAISE EXCEPTION 'post-apply failed: % union_invoice rows still have no destination', v_dead_union;
    END IF;

    SELECT action_url INTO v_sample FROM public.notifications
    WHERE type='waitlist_seat_open' AND action_url IS NOT NULL LIMIT 1;
    IF v_sample IS NOT NULL AND left(v_sample,1) <> '/' THEN
        RAISE EXCEPTION 'post-apply failed: action_url is not a path: %', v_sample;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                   WHERE tgname='trg_notification_fill_action_url' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'post-apply failed: trg_notification_fill_action_url missing';
    END IF;
END $$;
