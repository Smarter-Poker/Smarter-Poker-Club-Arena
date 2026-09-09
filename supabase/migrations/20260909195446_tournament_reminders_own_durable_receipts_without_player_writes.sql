-- Tournament reminder receipts are notification state, never player state.
-- The queue trigger also fences an old caller already executing during cutover.
-- No foreign keys to hot player/tournament tables. No accounting writes.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';

CREATE TABLE public.tournament_reminder_receipts (
  tournament_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  scheduled_start_at timestamptz NOT NULL,
  stage text NOT NULL CHECK (stage IN ('15m', '2m')),
  outcome text NOT NULL CHECK (outcome IN ('queued', 'seated', 'legacy')),
  outbox_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, recipient_user_id, scheduled_start_at, stage),
  CHECK ((outcome = 'queued') = (outbox_id IS NOT NULL))
);
ALTER TABLE public.tournament_reminder_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_reminder_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tournament_reminder_receipts TO service_role;

-- Drain already-writing legacy transactions before importing their flags.
-- This leaf queue lock has no accounting-table or foreign-key lock dependency.
LOCK TABLE public.push_outbox IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.tournament_reminder_receipts
  (tournament_id, recipient_user_id, scheduled_start_at, stage, outcome)
SELECT t.id, tp.user_id, t.start_time, s.stage, 'legacy'
FROM public.tournaments t
JOIN public.tournament_players tp ON tp.tournament_id = t.id
CROSS JOIN LATERAL (VALUES ('15m', tp.push_15m_sent), ('2m', tp.push_2m_sent)) s(stage, sent)
WHERE t.status IN ('ANNOUNCED', 'REGISTERING') AND t.start_time > now()
  AND t.game_type != 'spin' AND s.sent IS TRUE;

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
CREATE TRIGGER claim_tournament_reminder_before_enqueue
BEFORE INSERT ON public.push_outbox FOR EACH ROW
WHEN (NEW.event IN ('tournament_reminder_15m', 'tournament_reminder_2m'))
EXECUTE FUNCTION public.trg_claim_tournament_reminder();
REVOKE ALL ON FUNCTION public.trg_claim_tournament_reminder() FROM PUBLIC, anon, authenticated;

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
        AND tp.status IN ('registered', 'playing') AND NOT EXISTS (
          SELECT 1 FROM public.tournament_reminder_receipts r WHERE r.tournament_id = t.id
            AND r.recipient_user_id = tp.user_id AND r.scheduled_start_at = t.start_time AND r.stage = s.stage));
  SELECT min(created_at) INTO v_oldest FROM public.push_outbox
    WHERE event IN ('tournament_reminder_15m', 'tournament_reminder_2m')
      AND (status = 'pending' OR (status = 'processing' AND coalesce(claimed_at, created_at) < now() - interval '15 minutes'));
  RETURN jsonb_build_object('busy', false, 'queued', v_queued, 'accounted', v_accounted,
    'next_due_at', v_next, 'oldest_pending_at', v_oldest);
END;
$function$;
REVOKE ALL ON FUNCTION public.prepare_tournament_reminders(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_tournament_reminders(integer) TO service_role;

-- Compatibility caller: the existing pg_cron job remains a secondary backstop.
CREATE OR REPLACE FUNCTION public.check_upcoming_tournament_pushes()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $function$
BEGIN
  PERFORM public.prepare_tournament_reminders(300);
END;
$function$;
REVOKE ALL ON FUNCTION public.check_upcoming_tournament_pushes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_upcoming_tournament_pushes() TO service_role;

CREATE OR REPLACE FUNCTION public.get_tournament_reminder_delivery(p_outbox_ids uuid[])
RETURNS TABLE(outbox_id uuid, expires_at timestamptz, skip_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
  SELECT o.id, r.scheduled_start_at - CASE r.stage WHEN '15m' THEN interval '2 minutes' ELSE interval '0' END,
    CASE
      WHEN r.outbox_id IS NULL THEN 'reminder_unversioned'
      WHEN t.id IS NULL OR t.status NOT IN ('ANNOUNCED', 'REGISTERING') OR t.game_type = 'spin' THEN 'reminder_canceled'
      WHEN t.start_time IS DISTINCT FROM r.scheduled_start_at THEN 'reminder_rescheduled'
      WHEN now() >= r.scheduled_start_at - CASE r.stage WHEN '15m' THEN interval '2 minutes' ELSE interval '0' END THEN 'reminder_expired'
      WHEN NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = r.tournament_id
        AND tp.user_id = r.recipient_user_id AND tp.status IN ('registered', 'playing')) THEN 'reminder_unregistered'
      WHEN EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.user_id = r.recipient_user_id AND ts.left_at IS NULL) THEN 'reminder_seated'
      ELSE NULL
    END
  FROM public.push_outbox o
  LEFT JOIN public.tournament_reminder_receipts r ON r.outbox_id = o.id AND r.recipient_user_id = o.recipient_user_id
  LEFT JOIN public.tournaments t ON t.id = r.tournament_id
  WHERE o.id = ANY(p_outbox_ids) AND o.event IN ('tournament_reminder_15m', 'tournament_reminder_2m');
$function$;
REVOKE ALL ON FUNCTION public.get_tournament_reminder_delivery(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tournament_reminder_delivery(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_tournament_reminder_pushes(p_limit integer DEFAULT 100, p_max_attempts integer DEFAULT 5)
RETURNS SETOF public.push_outbox LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $function$
BEGIN
  UPDATE public.push_outbox o SET status = CASE WHEN o.attempts >= 5 THEN 'failed' ELSE 'pending' END,
    claimed_at = NULL, failure_reason = CASE WHEN o.attempts >= 5 THEN 'reminder_attempts_exhausted' ELSE 'reminder_claim_expired' END
  WHERE o.id IN (SELECT q.id FROM public.push_outbox q
    WHERE q.event IN ('tournament_reminder_15m', 'tournament_reminder_2m')
      AND ((q.status = 'processing' AND coalesce(q.claimed_at, q.created_at) < now() - interval '15 minutes')
        OR (q.status = 'pending' AND q.attempts >= 5))
    ORDER BY q.created_at, q.id LIMIT 300 FOR UPDATE SKIP LOCKED);
  RETURN QUERY
  UPDATE public.push_outbox o SET status = 'processing', attempts = o.attempts + 1, claimed_at = now()
  WHERE o.id IN (SELECT q.id FROM public.push_outbox q WHERE q.status = 'pending'
    AND q.event IN ('tournament_reminder_15m', 'tournament_reminder_2m')
    AND q.attempts < least(greatest(p_max_attempts, 1), 5)
    ORDER BY q.created_at, q.id LIMIT least(greatest(p_limit, 1), 300) FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_tournament_reminder_pushes(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tournament_reminder_pushes(integer, integer) TO service_role;
COMMIT;
