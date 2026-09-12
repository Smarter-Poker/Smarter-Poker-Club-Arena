-- 20260912050723_a_tournament_reminder_needs_a_device_to_reach.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE ENQUEUE HAD NO REACHABILITY PREDICATE. `prepare_tournament_reminders`
-- selects every registrant of every tournament starting inside fifteen minutes
-- and writes one push_outbox row each. It never asks whether that recipient has
-- a device. Measured on production 2026-09-12, over seven days:
--
--     15,900 tournament-reminder rows        (94.9% of ALL push_outbox volume)
--        935 distinct recipients
--          0 of them with an active push subscription
--          0 that had EVER held a push_subscriptions row at the moment the
--            reminder was written
--          0 delivered - every single row ended status='skipped',
--            failure_reason='no_subscription'
--
-- The dispatcher was right every time. `pages/api/cron/push-dispatch.js` skips a
-- row whose recipient has no active subscription, which is the only thing it can
-- do with one. The defect is upstream: we were writing 2,000 rows a day addressed
-- to nobody, and then reading the 100% skip rate as if push were broken.
--
-- LATENT STARVATION, FIXED BY THE SAME LINE. The candidate loop is
-- `ORDER BY t.start_time, t.id, tp.user_id LIMIT p_limit` with p_limit = 300.
-- At the moment this was written there were 1,266 registrant rows across the
-- upcoming schedule, every one of them unreachable, competing for those 300
-- slots. A real registrant with a device and a high UUID could be sorted out of
-- her own reminder by horses that could never have received one. Filtering on
-- reachability empties the queue of everything that cannot be delivered, so the
-- budget is spent only on people it can reach.
--
-- THE PREDICATE IS REACHABILITY, NEVER SPECIES (CLAUDE.md 10.5). This is the
-- `is_horse` trap in its exact original shape, and it is not taken here. A human
-- with no subscription is filtered by the SAME predicate as a horse with no
-- subscription, and a horse that enrols a device gets its reminder like anybody
-- else. Verified read-only against production: with one simulated device on one
-- horse registrant, the candidate set for the 07:30Z event went from 0 admitted
-- to exactly 1 - that horse. `tests/a-reminder-needs-a-device.law.test.ts` fails
-- if anybody ever "simplifies" this into an is_horse check.
--
-- IT COSTS NOTHING. `push_subscriptions_user_active_idx ON (user_id) WHERE
-- is_active = true` already exists; EXPLAIN on the new candidate query resolves
-- the EXISTS with `Index Only Scan using push_subscriptions_user_active_idx`.
--
-- NO SECOND IDEMPOTENCY MECHANISM IS ADDED. `tournament_reminder_receipts` plus
-- the BEFORE INSERT claim already guarantee one row per
-- (tournament, recipient, scheduled_start_at, stage) - measured over 12 hours it
-- suppressed 10,707 duplicate claims and admitted 328. It is untouched.
--
-- AND NO RECEIPT IS CLAIMED FOR AN UNREACHABLE RECIPIENT. The trigger backstop
-- below returns NULL without writing a receipt, deliberately: a receipt is
-- permanent, so claiming one would mean a player who enables notifications four
-- minutes before the event never receives the reminder they just asked for. The
-- candidate predicate is stateless - the minute a device appears, the registrant
-- re-enters the candidate set on the next tick.
--
-- Both function bodies below are the live definitions (pg_get_functiondef,
-- 2026-09-12) with the reachability predicate added and nothing else changed.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- 0. THE INDEX THE PREDICATE RIDES ON. It is already live and this is a no-op
--    against production, but it was never in the repo, so a rebuild from
--    migrations would have produced the predicate without the index that makes
--    it free. They travel together from here.
CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
  ON public.push_subscriptions (user_id) WHERE is_active = true;

-- 1. THE ENQUEUE. Two predicates added: one in the candidate loop, which is the
--    fix, and the same one in the `next_due_at` report at the bottom, so the
--    function does not announce work it has correctly decided never to do.
CREATE OR REPLACE FUNCTION public.prepare_tournament_reminders(p_limit integer DEFAULT 300)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $function$
DECLARE
  c record;
  v_queued integer := 0;
  v_accounted integer := 0;
  v_count integer;
  v_next timestamptz;
  v_oldest timestamptz;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Reminder batch limit must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(72419, 901) THEN
    RETURN jsonb_build_object('busy', true);
  END IF;
  FOR c IN
    SELECT t.id, tp.user_id, t.start_time,
      CASE WHEN t.start_time > now() + interval '2 minutes' THEN '15m' ELSE '2m' END stage
    FROM public.tournaments t
    JOIN public.tournament_players tp ON tp.tournament_id = t.id
    WHERE t.status IN ('ANNOUNCED', 'REGISTERING') AND t.game_type != 'spin'
      AND t.start_time > now() AND t.start_time <= now() + interval '15 minutes'
      AND tp.status IN ('registered', 'playing')
      -- REACHABILITY, NOT SPECIES. A recipient with no live device cannot be
      -- sent a push by anyone; queueing one only produces a skip. This asks
      -- about the device and nothing else - never is_horse, never a role,
      -- never an account age. Anyone who enrols a device is admitted on the
      -- next tick, horse or human alike.
      AND EXISTS (SELECT 1 FROM public.push_subscriptions s
        WHERE s.user_id = tp.user_id AND s.is_active)
      AND NOT EXISTS (SELECT 1 FROM public.tournament_reminder_receipts r
        WHERE r.tournament_id = t.id AND r.recipient_user_id = tp.user_id
          AND r.scheduled_start_at = t.start_time
          AND r.stage = CASE WHEN t.start_time > now() + interval '2 minutes' THEN '15m' ELSE '2m' END)
    ORDER BY t.start_time, t.id, tp.user_id LIMIT p_limit
  LOOP
    INSERT INTO public.push_outbox
      (recipient_user_id, title, body, url, event, related_entity_id, tag)
    VALUES (c.user_id, 'Tournament Starting Soon', 'Tournament Reminder',
      '/hub/club-arena/tournaments/' || c.id, 'tournament_reminder_' || c.stage, c.id,
      'tr:' || c.id || ':' || (extract(epoch FROM c.start_time) * 1000)::bigint || ':' || c.stage);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_queued := v_queued + v_count;
    v_accounted := v_accounted + 1;
  END LOOP;
  SELECT min(greatest(s.due_at, now())) INTO v_next
  FROM public.tournaments t
  CROSS JOIN LATERAL (VALUES
    ('15m', t.start_time - interval '15 minutes', t.start_time - interval '2 minutes'),
    ('2m', t.start_time - interval '2 minutes', t.start_time)) s(stage, due_at, expires_at)
  WHERE t.status IN ('ANNOUNCED', 'REGISTERING') AND t.game_type != 'spin'
    AND s.expires_at > now() AND EXISTS (
      SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id
        AND tp.status IN ('registered', 'playing')
        -- Same predicate as the loop, for the same reason: `next_due_at` is a
        -- statement about work this function will do, and it will not queue a
        -- reminder for a recipient it cannot reach.
        AND EXISTS (SELECT 1 FROM public.push_subscriptions ps
          WHERE ps.user_id = tp.user_id AND ps.is_active)
        AND NOT EXISTS (
          SELECT 1 FROM public.tournament_reminder_receipts r WHERE r.tournament_id = t.id
            AND r.recipient_user_id = tp.user_id AND r.scheduled_start_at = t.start_time AND r.stage = s.stage));
  SELECT min(created_at) INTO v_oldest FROM public.push_outbox
    WHERE event IN ('tournament_reminder_15m', 'tournament_reminder_2m')
      AND (status = 'pending' OR (status = 'processing' AND coalesce(claimed_at, created_at) < now() - interval '15 minutes'));
  RETURN jsonb_build_object('busy', false, 'queued', v_queued, 'accounted', v_accounted,
    'next_due_at', v_next, 'oldest_pending_at', v_oldest);
END;
$function$;
-- Restated, not inherited. CREATE OR REPLACE keeps the privileges the routine
-- already has, so these change nothing on this database - but a rebuild from
-- this directory, or a reader asking who may call it, should not have to go
-- back to 20260909195446 to find out. Nobody in a browser calls a cron routine.
-- GRANT/REVOKE fire no schema-cache reload (CLAUDE.md section 2, rule 5).
REVOKE ALL ON FUNCTION public.prepare_tournament_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_tournament_reminders(integer) TO service_role;

-- 2. THE BACKSTOP. The enqueue above is the only caller today, but a predicate
--    that lives in one function's WHERE clause is a convention, not an
--    invariant - the next caller walks straight around it. This makes the rule
--    true AT THE TABLE. It sits before every receipt write on purpose: an
--    unreachable recipient is dropped WITHOUT being claimed, so enrolling a
--    device inside the window still earns the reminder.
CREATE OR REPLACE FUNCTION public.trg_claim_tournament_reminder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $function$
DECLARE
  v_tournament uuid;
  v_start timestamptz;
  v_name text;
  v_stage text;
  v_due timestamptz;
  v_expires timestamptz;
  v_tag text;
  v_seated boolean;
  v_claimed boolean;
BEGIN
  IF NEW.event NOT IN ('tournament_reminder_15m', 'tournament_reminder_2m')
     OR NEW.event IS NULL THEN RETURN NEW; END IF;
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;
  -- A reminder needs a device to reach. Reachability, never species: the same
  -- line refuses a human with no subscription and admits a horse with one.
  -- No receipt is claimed here - see the header.
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions s
    WHERE s.user_id = NEW.recipient_user_id AND s.is_active) THEN RETURN NULL; END IF;
  v_stage := CASE NEW.event WHEN 'tournament_reminder_15m' THEN '15m' ELSE '2m' END;
  v_tournament := NEW.related_entity_id;
  IF v_tournament IS NULL THEN
    v_tournament := substring(NEW.url FROM '/tournaments/([0-9a-fA-F-]{36})$')::uuid;
  END IF;
  SELECT t.start_time, t.name INTO v_start, v_name
  FROM public.tournaments t
  WHERE t.id = v_tournament AND t.status IN ('ANNOUNCED', 'REGISTERING')
    AND t.game_type != 'spin'
    AND EXISTS (SELECT 1 FROM public.tournament_players tp
      WHERE tp.tournament_id = t.id AND tp.user_id = NEW.recipient_user_id
        AND tp.status IN ('registered', 'playing'));
  IF NOT FOUND OR v_start IS NULL THEN RETURN NULL; END IF;
  v_due := v_start - CASE v_stage WHEN '15m' THEN interval '15 minutes' ELSE interval '2 minutes' END;
  v_expires := v_start - CASE v_stage WHEN '15m' THEN interval '2 minutes' ELSE interval '0' END;
  IF now() < v_due OR now() >= v_expires THEN RETURN NULL; END IF;
  v_tag := 'tr:' || v_tournament || ':' || (extract(epoch FROM v_start) * 1000)::bigint || ':' || v_stage;
  -- An intent selected before a concurrent reschedule cannot acquire its new version.
  IF NEW.tag IS NOT NULL AND NEW.tag != v_tag THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM public.table_seats ts
    WHERE ts.user_id = NEW.recipient_user_id AND ts.left_at IS NULL) INTO v_seated;
  INSERT INTO public.tournament_reminder_receipts
    (tournament_id, recipient_user_id, scheduled_start_at, stage, outcome, outbox_id)
  VALUES (v_tournament, NEW.recipient_user_id, v_start, v_stage,
    CASE WHEN v_seated THEN 'seated' ELSE 'queued' END,
    CASE WHEN v_seated THEN NULL ELSE NEW.id END)
  ON CONFLICT DO NOTHING RETURNING true INTO v_claimed;
  IF v_claimed IS NOT TRUE OR v_seated THEN RETURN NULL; END IF;
  NEW.related_entity_id := v_tournament;
  NEW.tag := v_tag;
  NEW.url := '/hub/club-arena/tournaments/' || v_tournament;
  NEW.title := 'Tournament Starting Soon';
  NEW.body := CASE v_stage WHEN '15m'
    THEN 'Your Tournament "' || v_name || '" Starts In 15 Minutes!'
    ELSE 'Get Ready! "' || v_name || '" Starts In 2 Minutes!' END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_claim_tournament_reminder() FROM PUBLIC, anon, authenticated;

COMMIT;
