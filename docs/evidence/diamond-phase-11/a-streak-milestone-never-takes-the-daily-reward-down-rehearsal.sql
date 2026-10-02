-- ============================================================================
-- REHEARSAL: A STREAK MILESTONE NEVER TAKES THE DAILY REWARD DOWN
-- ============================================================================
-- REHEARSAL ONLY. rehearse.sh runs the migration
-- 20260930233000_a_streak_milestone_never_takes_the_daily_reward_down.sql and
-- then this file as ONE transaction against production that ends in a
-- deliberate error (RAISE EXCEPTION 'REHEARSAL OK: ...'), so NOTHING persists:
--
--   /Volumes/SmarterWork/agent-work/claude-tools/bin/rehearse.sh \
--     supabase/migrations/20260930233000_a_streak_milestone_never_takes_the_daily_reward_down.sql \
--     docs/evidence/diamond-phase-11/a-streak-milestone-never-takes-the-daily-reward-down-rehearsal.sql \
--     milestones
--
-- No CI runner loads this file; it is evidence, repeatable by hand.
--
-- THE SCENE, inside the rolled-back transaction only. A stuck horse H is chosen
-- on production: its streak has reached thirty days, its 30-day milestone is
-- not recorded, its 14-day one is, and its daily rewards have been owed past
-- the sweep interval. Its daily-mission state - every challenge row, its streak
-- state (freezes and frozen dates), its freeze entitlements and its milestone
-- rows - is copied onto two synthetic hydra.bot accounts (...0056 is T,
-- ...0057 is T2), which become horses for the length of the transaction. The
-- copied milestones are paid through add_diamonds_to_balance under their own
-- references, as H's were, so each copy is owed exactly what H is owed: its
-- ordinary rewards and the 30-day milestone. A third account (...0058, T3) is
-- given one owed daily reward and a daily_challenges day already at its cap.
-- The copies' owed rewards are dated six days back so they are the oldest
-- candidates, and before every sweep the fixture proves the sweep's window
-- holds only these rows: no real horse's reward is pressed. The supply
-- identity is measured relative to a baseline taken after the scene.
--
-- THE CASES, through the real sweep (fn_ca_horse_claim_due) and the real claim
-- (claim_daily_challenge_serialized_body) with its real trigger:
--   C   a reward refused by its own line's cap is deferred to the day the cap
--       resets, and the next window skips it - it is the oldest owed row, and
--       the rows behind it are paid;
--   A   the stuck horse's copy is paid: every owed reward, and the 30-day
--       milestone of 1,000 on its own line, once, with the ruling 18 line
--       untouched and the 7- and 14-day milestones not paid again;
--   B   a milestone its line refuses (5,500 already paid on it today) never
--       takes the daily reward down: the rewards are claimed and paid, the
--       milestone stays owed, and the sweep names it (milestones_refused = 1,
--       capped = 0, CH3:milestone_refused filed once);
--   B2  on a day the line has room, the player's next daily claim pays it.
--
-- REHEARSAL SAFETY (the 2026-09-29 rules): lock_timeout 2s; nothing here takes
-- a lock on a hot chip table; the one lock waited for is the sweep's own
-- advisory lock, taken last and queued for (at most 50 s); while it is held the
-- live minute sweep answers ran = false and moves nothing.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE res(n serial PRIMARY KEY, name text, ok boolean, detail text);
CREATE TEMP TABLE kv(k text PRIMARY KEY, v text);

CREATE FUNCTION pg_temp.chk(p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void
LANGUAGE sql AS $f$
  INSERT INTO pg_temp.res(name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), p_detail);
$f$;
CREATE FUNCTION pg_temp.put(p_k text, p_v text) RETURNS void
LANGUAGE sql AS $f$
  INSERT INTO pg_temp.kv VALUES (p_k, p_v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
$f$;
CREATE FUNCTION pg_temp.get(p_k text) RETURNS text
LANGUAGE sql AS $f$ SELECT v FROM pg_temp.kv WHERE k = p_k; $f$;
-- The engine's identity: service_role, no player, no browser.
CREATE FUNCTION pg_temp.as_engine() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
END $f$;
CREATE FUNCTION pg_temp.tests() RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $f$
  SELECT ARRAY['00000000-0000-0000-0000-000000000056', '00000000-0000-0000-0000-000000000057',
               '00000000-0000-0000-0000-000000000058']::uuid[];
$f$;
CREATE FUNCTION pg_temp.bal(p uuid) RETURNS bigint LANGUAGE sql AS $f$
  SELECT COALESCE(diamonds, 0)::bigint FROM public.profiles WHERE id = p;
$f$;
-- The day the earn ledger counts a player's awards in.
CREATE FUNCTION pg_temp.cap_day() RETURNS date LANGUAGE sql AS $f$
  SELECT (now() AT TIME ZONE 'America/Chicago')::date;
$f$;
CREATE FUNCTION pg_temp.awarded(p uuid, p_engine text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT COALESCE((SELECT a.awarded FROM public.diamond_user_daily_awards a
                    WHERE a.user_id = p AND a.engine = p_engine AND a.day = pg_temp.cap_day()), 0)::bigint;
$f$;
CREATE FUNCTION pg_temp.set_awarded(p uuid, p_engine text, p_amount bigint) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
  VALUES (p, p_engine, pg_temp.cap_day(), p_amount, now())
  ON CONFLICT (user_id, engine, day) DO UPDATE SET awarded = EXCLUDED.awarded, updated_at = now();
$f$;
CREATE FUNCTION pg_temp.owed_count(p uuid) RETURNS integer LANGUAGE sql AS $f$
  SELECT count(*)::integer FROM public.user_daily_challenges u
   WHERE u.user_id = p AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
$f$;
CREATE FUNCTION pg_temp.owed_sum(p uuid, p_first integer DEFAULT 1000000) RETURNS bigint LANGUAGE sql AS $f$
  SELECT COALESCE(sum(x.r), 0)::bigint FROM (
    SELECT u.diamond_reward_snapshot AS r FROM public.user_daily_challenges u
     WHERE u.user_id = p AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
       AND u.completed_at >= now() - interval '7 days'
     ORDER BY u.completed_at, u.id LIMIT p_first) x;
$f$;
-- Exactly the rows the sweep would choose with this limit (its own candidate query).
CREATE FUNCTION pg_temp.sweep_window(p_limit integer) RETURNS TABLE(id uuid, user_id uuid) LANGUAGE sql AS $f$
  SELECT u.id, u.user_id
    FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.ca_horse_claim_deferrals d
                      WHERE d.challenge_row_id = u.id AND d.retry_after > now())
   ORDER BY u.completed_at, u.id
   LIMIT p_limit;
$f$;
CREATE FUNCTION pg_temp.guard_window(p_limit integer, p_case text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.sweep_window(p_limit) w WHERE NOT (w.user_id = ANY (pg_temp.tests()))) THEN
    RAISE EXCEPTION 'REHEARSAL ABORTED before case %: the sweep window would reach a real horse''s reward', p_case;
  END IF;
END $f$;
CREATE FUNCTION pg_temp.milestone_ref(p uuid, p_days integer) RETURNS text LANGUAGE sql AS $f$
  SELECT 'daily_mission_milestones:' || c.user_id::text || ':' || c.streak_run_id::text || ':' || c.milestone_days::text
    FROM public.daily_challenge_milestone_claims c
   WHERE c.user_id = p AND c.milestone_days = p_days
   ORDER BY c.claimed_at DESC LIMIT 1;
$f$;
CREATE FUNCTION pg_temp.credited(p_ref text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT COALESCE(sum(t.amount), 0)::bigint FROM public.diamond_transactions t WHERE t.reference_id = p_ref;
$f$;
CREATE FUNCTION pg_temp.credits(p_ref text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*)::bigint FROM public.diamond_transactions t WHERE t.reference_id = p_ref;
$f$;

-- ============================================================================
-- THE SCENE
-- ============================================================================
DO $scene$
DECLARE
  v_h uuid;
  v_t uuid := '00000000-0000-0000-0000-000000000056';
  v_t2 uuid := '00000000-0000-0000-0000-000000000057';
  v_t3 uuid := '00000000-0000-0000-0000-000000000058';
  v_first uuid;
  c record;
  v_credit jsonb;
  t0 timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_temp.put('t0', t0::text);
  -- The three accounts are the synthetic hydra.bot fixtures, not horses, with no daily-mission state.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = ANY (pg_temp.tests()) AND COALESCE(is_horse, false))
     OR (SELECT count(*) FROM public.profiles p JOIN auth.users u ON u.id = p.id
          WHERE p.id = ANY (pg_temp.tests()) AND u.email LIKE '%@hydra.bot') <> 3
     OR EXISTS (SELECT 1 FROM public.user_daily_challenges WHERE user_id = ANY (pg_temp.tests()))
     OR EXISTS (SELECT 1 FROM public.challenge_streak_state WHERE user_id = ANY (pg_temp.tests()))
     OR EXISTS (SELECT 1 FROM public.daily_challenge_freeze_entitlements WHERE user_id = ANY (pg_temp.tests()))
     OR EXISTS (SELECT 1 FROM public.daily_challenge_milestone_claims WHERE user_id = ANY (pg_temp.tests()))
     OR EXISTS (SELECT 1 FROM public.diamond_user_daily_awards WHERE user_id = ANY (pg_temp.tests())) THEN
    RAISE EXCEPTION 'REHEARSAL ABORTED: the synthetic accounts are not the empty hydra.bot accounts this expects';
  END IF;

  -- H: a horse stuck at thirty days.
  SELECT s.user_id INTO v_h
    FROM public.challenge_streak_state s
    JOIN public.profiles p ON p.id = s.user_id AND p.is_horse
   WHERE s.current_streak_length >= 29
     AND s.current_streak_started_on <= (now() AT TIME ZONE 'utc')::date - 29
     AND EXISTS (SELECT 1 FROM public.user_daily_challenges u
                  WHERE u.user_id = s.user_id AND u.tier_snapshot = 'daily'
                    AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
                    AND u.completed_at < now() - interval '5 minutes'
                    AND u.completed_at >= now() - interval '7 days')
     AND NOT EXISTS (SELECT 1 FROM public.daily_challenge_milestone_claims m
                      WHERE m.user_id = s.user_id AND m.milestone_days >= 30)
     AND EXISTS (SELECT 1 FROM public.daily_challenge_milestone_claims m
                  WHERE m.user_id = s.user_id AND m.milestone_days = 14)
   ORDER BY s.user_id
   LIMIT 1;
  IF v_h IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL ABORTED: no horse stuck at thirty days was found';
  END IF;
  PERFORM pg_temp.put('h', v_h::text);
  PERFORM pg_temp.put('h_owed', pg_temp.owed_count(v_h)::text);

  -- The three accounts become horses for this transaction (server context).
  UPDATE public.profiles SET is_horse = true WHERE id = ANY (pg_temp.tests());

  -- T and T2: a copy of H's daily-mission state.
  INSERT INTO public.user_daily_challenges
  SELECT (jsonb_populate_record(NULL::public.user_daily_challenges,
            to_jsonb(u) || jsonb_build_object('id', gen_random_uuid(), 'user_id', t.id))).*
    FROM public.user_daily_challenges u
    CROSS JOIN unnest(ARRAY[v_t, v_t2]) t(id)
   WHERE u.user_id = v_h;
  INSERT INTO public.challenge_streak_state
  SELECT (jsonb_populate_record(NULL::public.challenge_streak_state,
            to_jsonb(s) || jsonb_build_object('user_id', t.id))).*
    FROM public.challenge_streak_state s
    CROSS JOIN unnest(ARRAY[v_t, v_t2]) t(id)
   WHERE s.user_id = v_h;
  INSERT INTO public.daily_challenge_freeze_entitlements
  SELECT (jsonb_populate_record(NULL::public.daily_challenge_freeze_entitlements,
            to_jsonb(e) || jsonb_build_object('user_id', t.id))).*
    FROM public.daily_challenge_freeze_entitlements e
    CROSS JOIN unnest(ARRAY[v_t, v_t2]) t(id)
   WHERE e.user_id = v_h;
  INSERT INTO public.daily_challenge_milestone_claims
  SELECT (jsonb_populate_record(NULL::public.daily_challenge_milestone_claims,
            to_jsonb(m) || jsonb_build_object('user_id', t.id))).*
    FROM public.daily_challenge_milestone_claims m
    CROSS JOIN unnest(ARRAY[v_t, v_t2]) t(id)
   WHERE m.user_id = v_h;

  -- T3: one owed daily reward (H's oldest), on a daily_challenges day already at its cap.
  SELECT u.id INTO v_first
    FROM public.user_daily_challenges u
   WHERE u.user_id = v_h AND u.tier_snapshot = 'daily' AND u.completed AND NOT u.claimed
     AND u.expired_at IS NULL AND u.completed_at >= now() - interval '7 days'
   ORDER BY u.completed_at, u.id LIMIT 1;
  INSERT INTO public.user_daily_challenges
  SELECT (jsonb_populate_record(NULL::public.user_daily_challenges,
            to_jsonb(u) || jsonb_build_object('id', gen_random_uuid(), 'user_id', v_t3))).*
    FROM public.user_daily_challenges u WHERE u.id = v_first;
  PERFORM pg_temp.set_awarded(v_t3, 'daily_challenges',
    (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_challenges'));

  -- The contract snapshot is re-taken from the catalog on insert; keep every completed copy complete.
  UPDATE public.user_daily_challenges SET progress = requirement_snapshot
   WHERE user_id = ANY (pg_temp.tests()) AND completed AND progress < requirement_snapshot;

  -- The copies' owed rewards become the oldest candidates, in a fixed order:
  -- T3's one row first, then T's, then T2's (a daily row last, for case B2).
  UPDATE public.user_daily_challenges u
     SET completed_at = now() - interval '6 days 23 hours'
   WHERE u.user_id = v_t3;
  UPDATE public.user_daily_challenges u
     SET completed_at = now() - interval '6 days 22 hours' + x.rn * interval '1 second'
    FROM (SELECT o.id, row_number() OVER (ORDER BY o.completed_at, o.id) AS rn
            FROM public.user_daily_challenges o
           WHERE o.user_id = v_t AND o.completed AND NOT o.claimed AND o.expired_at IS NULL
             AND o.completed_at >= now() - interval '7 days') x
   WHERE u.id = x.id;
  UPDATE public.user_daily_challenges u
     SET completed_at = now() - interval '6 days 21 hours' + x.rn * interval '1 second'
    FROM (SELECT o.id, row_number() OVER (ORDER BY (o.tier_snapshot = 'daily'), o.completed_at, o.id) AS rn
            FROM public.user_daily_challenges o
           WHERE o.user_id = v_t2 AND o.completed AND NOT o.claimed AND o.expired_at IS NULL
             AND o.completed_at >= now() - interval '7 days') x
   WHERE u.id = x.id;

  -- H's milestones were each paid under their own reference; the copies' are paid the same way,
  -- through the one credit door, so the copies owe what H owes and nothing it does not.
  FOR c IN SELECT m.user_id, m.streak_run_id, m.milestone_days, m.reward_diamonds
             FROM public.daily_challenge_milestone_claims m
            WHERE m.user_id IN (v_t, v_t2)
            ORDER BY m.user_id, m.claimed_at, m.milestone_days
  LOOP
    v_credit := public.add_diamonds_to_balance(c.user_id, c.reward_diamonds::integer, 'daily_mission_milestone',
      'Daily Missions streak circuit',
      'daily_mission_milestones:' || c.user_id::text || ':' || c.streak_run_id::text || ':' || c.milestone_days::text);
    IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'REHEARSAL ABORTED: the scene could not pay a copied milestone: %', v_credit;
    END IF;
  END LOOP;

  IF pg_temp.owed_count(v_t) < 2 OR pg_temp.owed_count(v_t2) < 2
     OR (SELECT count(*) FROM public.user_daily_challenges u
          WHERE u.user_id = v_t2 AND u.tier_snapshot = 'daily' AND u.completed AND NOT u.claimed
            AND u.expired_at IS NULL AND u.completed_at >= now() - interval '7 days') < 2 THEN
    RAISE EXCEPTION 'REHEARSAL ABORTED: the copy owes too little to run every case (T %, T2 %)',
      pg_temp.owed_count(v_t), pg_temp.owed_count(v_t2);
  END IF;

  PERFORM pg_temp.put('base_identity', (SELECT difference FROM public.fn_ca_diamond_register_vs_supply())::text);
  PERFORM pg_temp.put('scene_ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000)::text);
END $scene$;

-- The sweep's own lock, last: while it is held the live minute sweep answers ran = false.
-- It is QUEUED for, not polled: a live run holds it for its whole run and the next run takes it
-- within milliseconds, so a poll can miss every gap. Queueing waits for the run in progress to
-- end and takes the lock before the next one can; it holds nothing live play needs meanwhile.
DO $lock$
DECLARE t0 timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('lock_timeout', '50s', true);
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('ca_horse_claim_due'));
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'REHEARSAL ABORTED: the live sweep held its lock for 50 s; run again';
  END;
  PERFORM set_config('lock_timeout', '2s', true);
  PERFORM pg_temp.put('lock_wait_ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000)::text);
END $lock$;

-- ============================================================================
-- CASE C: A CAPPED REWARD WAITS FOR ITS CAP DAY AND BLOCKS NOTHING
-- ============================================================================
DO $c$
DECLARE
  v_t3 uuid := '00000000-0000-0000-0000-000000000058';
  r record; d record; v_row uuid; v_b0 bigint;
BEGIN
  PERFORM pg_temp.as_engine();
  PERFORM pg_temp.guard_window(1, 'C');
  SELECT w.id INTO v_row FROM pg_temp.sweep_window(1) w;
  PERFORM pg_temp.chk('C: the capped reward is the oldest owed row',
    (SELECT u.user_id FROM public.user_daily_challenges u WHERE u.id = v_row) = v_t3, v_row::text);
  v_b0 := pg_temp.bal(v_t3);

  SELECT * INTO r FROM public.fn_ca_horse_claim_due(1);
  SELECT * INTO d FROM public.ca_horse_claim_deferrals WHERE challenge_row_id = v_row;
  PERFORM pg_temp.chk('C: the sweep counts it as capped, and as nothing else',
    r.ran AND r.claimed = 0 AND r.capped = 1 AND r.failed = 0 AND r.milestones_refused = 0,
    row_to_json(r)::text);
  PERFORM pg_temp.chk('C: it is deferred, by name, to the America/Chicago midnight its cap resets at',
    d.refused_by = 'DR7:user_over_daily_cap' AND d.refusals = 1
      AND d.retry_after = (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day')
                          AT TIME ZONE 'America/Chicago',
    format('refused_by %s, retry_after %s', d.refused_by, d.retry_after));
  PERFORM pg_temp.chk('C: nothing is half-done: the reward is unclaimed and the balance is unchanged',
    NOT (SELECT u.claimed FROM public.user_daily_challenges u WHERE u.id = v_row)
      AND pg_temp.bal(v_t3) = v_b0, NULL);
  PERFORM pg_temp.put('c_row', v_row::text);
  PERFORM pg_temp.put('c_result', row_to_json(r)::text);
END $c$;

-- ============================================================================
-- CASE A: THE STUCK HORSE'S COPY IS PAID, THE MILESTONE ON ITS OWN LINE
-- ============================================================================
DO $a$
DECLARE
  v_t uuid := '00000000-0000-0000-0000-000000000056';
  r record; v_n integer; v_owed bigint; v_b0 bigint; v_m0 bigint; v_dm0 bigint; v_ref text;
BEGIN
  v_n := pg_temp.owed_count(v_t);
  v_owed := pg_temp.owed_sum(v_t);
  PERFORM pg_temp.guard_window(v_n, 'A');
  PERFORM pg_temp.chk('C: the next window skips the deferred row, though it is the oldest owed',
    NOT EXISTS (SELECT 1 FROM pg_temp.sweep_window(v_n) w WHERE w.id = pg_temp.get('c_row')::uuid)
      AND (SELECT count(*) FROM pg_temp.sweep_window(v_n) w WHERE w.user_id = v_t) = v_n, NULL);
  v_b0 := pg_temp.bal(v_t);
  v_m0 := pg_temp.awarded(v_t, 'daily_mission_milestones');
  v_dm0 := pg_temp.awarded(v_t, 'daily_missions');

  SELECT * INTO r FROM public.fn_ca_horse_claim_due(v_n);
  v_ref := pg_temp.milestone_ref(v_t, 30);
  PERFORM pg_temp.chk('A: every reward the stuck horse''s copy was owed is claimed',
    r.ran AND r.claimed = v_n AND r.capped = 0 AND r.failed = 0 AND r.milestones_refused = 0
      AND pg_temp.owed_count(v_t) = 0,
    row_to_json(r)::text);
  PERFORM pg_temp.chk('A: the 30-day milestone is recorded and paid once, 1,000, under its own reference',
    v_ref IS NOT NULL AND pg_temp.credited(v_ref) = 1000 AND pg_temp.credits(v_ref) = 1, v_ref);
  PERFORM pg_temp.chk('A: the balance moved by exactly the owed rewards plus the milestone',
    pg_temp.bal(v_t) - v_b0 = v_owed + 1000,
    format('moved %s, owed %s + 1000', pg_temp.bal(v_t) - v_b0, v_owed));
  PERFORM pg_temp.chk('A: the milestone is counted on its own line and the ruling 18 line is untouched',
    pg_temp.awarded(v_t, 'daily_mission_milestones') = v_m0 + 1000
      AND pg_temp.awarded(v_t, 'daily_missions') = v_dm0,
    format('milestone line %s -> %s, daily_missions %s -> %s', v_m0, pg_temp.awarded(v_t, 'daily_mission_milestones'),
           v_dm0, pg_temp.awarded(v_t, 'daily_missions')));
  PERFORM pg_temp.chk('A: the engine ledger books it to daily_mission_milestones',
    EXISTS (SELECT 1 FROM public.ca_diamond_engine_spend s
              JOIN public.diamond_transactions t ON t.id = s.journal_id
             WHERE t.reference_id = v_ref AND s.engine = 'daily_mission_milestones' AND s.amount = 1000), NULL);
  PERFORM pg_temp.chk('A: no milestone is paid twice: one credit per milestone row',
    (SELECT count(*) FROM public.diamond_transactions t
      WHERE t.user_id = v_t AND t.transaction_type = 'daily_mission_milestone')
    = (SELECT count(*) FROM public.daily_challenge_milestone_claims c WHERE c.user_id = v_t), NULL);
  PERFORM pg_temp.put('a_result', row_to_json(r)::text);
  PERFORM pg_temp.put('a_paid', (pg_temp.bal(v_t) - v_b0)::text);
END $a$;

-- ============================================================================
-- CASE B: A REFUSED MILESTONE TAKES NOTHING DOWN, STAYS OWED, AND IS NAMED
-- ============================================================================
DO $b$
DECLARE
  v_t2 uuid := '00000000-0000-0000-0000-000000000057';
  r record; v_n integer; v_owed bigint; v_b0 bigint; v_ref text;
BEGIN
  -- 5,500 already paid on the milestone line today: a 1,000 milestone cannot fit under 6,000.
  PERFORM pg_temp.set_awarded(v_t2, 'daily_mission_milestones', 5500);
  v_n := pg_temp.owed_count(v_t2) - 1;          -- the last daily row is kept for case B2
  v_owed := pg_temp.owed_sum(v_t2, v_n);
  PERFORM pg_temp.guard_window(v_n, 'B');
  v_b0 := pg_temp.bal(v_t2);

  SELECT * INTO r FROM public.fn_ca_horse_claim_due(v_n);
  v_ref := pg_temp.milestone_ref(v_t2, 30);
  PERFORM pg_temp.chk('B: the refused milestone takes nothing down: every reward in the run is claimed and paid',
    r.ran AND r.claimed = v_n AND r.failed = 0 AND pg_temp.owed_count(v_t2) = 1
      AND pg_temp.bal(v_t2) - v_b0 = v_owed,
    format('%s; moved %s, owed %s', row_to_json(r), pg_temp.bal(v_t2) - v_b0, v_owed));
  PERFORM pg_temp.chk('B: the sweep names it as a milestone refusal, not as an ordinary cap refusal',
    r.milestones_refused = 1 AND r.capped = 0, row_to_json(r)::text);
  PERFORM pg_temp.chk('B: the milestone stays owed: recorded, not credited',
    v_ref IS NOT NULL AND pg_temp.credits(v_ref) = 0, v_ref);
  PERFORM pg_temp.chk('B: it is filed under its own name, once for the run, naming the cap that refused it',
    (SELECT count(*) FROM public.ca_diamond_incidents i
      WHERE i.rule = 'CH3:milestone_refused' AND i.user_id = v_t2 AND i.occurred_at = now()) = 1
      AND EXISTS (SELECT 1 FROM public.ca_diamond_incidents i
                   WHERE i.rule = 'CH3:milestone_refused' AND i.user_id = v_t2 AND i.occurred_at = now()
                     AND i.detail ->> 'reference_id' = v_ref
                     AND i.detail ->> 'refused_by' LIKE 'DR7:user_over_daily_cap%daily_mission_milestones%'),
    NULL);
  PERFORM pg_temp.put('b_ref', v_ref);
  PERFORM pg_temp.put('b_result', row_to_json(r)::text);
END $b$;

-- ============================================================================
-- CASE B2: ON A DAY THE LINE HAS ROOM, THE NEXT DAILY CLAIM PAYS IT
-- ============================================================================
DO $b2$
DECLARE
  v_t2 uuid := '00000000-0000-0000-0000-000000000057';
  r record; v_owed bigint; v_b0 bigint; v_ref text := pg_temp.get('b_ref');
BEGIN
  -- The next cap day: the line is empty again.
  PERFORM pg_temp.set_awarded(v_t2, 'daily_mission_milestones', 0);
  v_owed := pg_temp.owed_sum(v_t2);
  PERFORM pg_temp.guard_window(1, 'B2');
  v_b0 := pg_temp.bal(v_t2);

  SELECT * INTO r FROM public.fn_ca_horse_claim_due(1);
  PERFORM pg_temp.chk('B2: the next daily claim pays the owed milestone, once',
    r.ran AND r.claimed = 1 AND r.capped = 0 AND r.failed = 0 AND r.milestones_refused = 0
      AND pg_temp.credited(v_ref) = 1000 AND pg_temp.credits(v_ref) = 1,
    row_to_json(r)::text);
  PERFORM pg_temp.chk('B2: the balance moved by the reward plus the milestone',
    pg_temp.bal(v_t2) - v_b0 = v_owed + 1000,
    format('moved %s, reward %s + 1000', pg_temp.bal(v_t2) - v_b0, v_owed));
  PERFORM pg_temp.put('b2_result', row_to_json(r)::text);
END $b2$;

-- ============================================================================
-- THE END: THE BOOKS, THE LINES, THE VERDICT
-- ============================================================================
DO $z$
DECLARE v_fail text; v_n integer; v_d numeric; v_row uuid := pg_temp.get('c_row')::uuid;
BEGIN
  v_d := (SELECT difference FROM public.fn_ca_diamond_register_vs_supply());
  PERFORM pg_temp.chk('players + house + custody = register moved by nothing: every Diamond paid here went through the register',
    v_d = pg_temp.get('base_identity')::numeric,
    format('baseline %s, now %s', pg_temp.get('base_identity'), v_d));
  PERFORM pg_temp.chk('C: the capped reward is still owed and still deferred at the end',
    NOT (SELECT u.claimed FROM public.user_daily_challenges u WHERE u.id = v_row)
      AND EXISTS (SELECT 1 FROM public.ca_horse_claim_deferrals d WHERE d.challenge_row_id = v_row AND d.retry_after > now()),
    NULL);
  PERFORM pg_temp.chk('the lines: daily_missions 500 (ruling 18, as it was), daily_mission_milestones 6,000',
    (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_missions') = 500
      AND (SELECT max_per_user_per_day FROM public.diamond_engine_daily_caps WHERE engine = 'daily_mission_milestones') = 6000,
    NULL);

  SELECT string_agg(name || COALESCE(' [' || detail || ']', ''), '; ' ORDER BY n) FILTER (WHERE NOT ok), count(*)
    INTO v_fail, v_n FROM pg_temp.res;
  IF v_fail IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: %', v_fail;
  END IF;
  RAISE EXCEPTION 'REHEARSAL OK: % checks passed. Stuck horse % (% owed) copied: C % | A % paid % | B % | B2 % | scene % ms, sweep-lock wait % ms, total % ms',
    v_n, pg_temp.get('h'), pg_temp.get('h_owed'), pg_temp.get('c_result'), pg_temp.get('a_result'),
    pg_temp.get('a_paid'), pg_temp.get('b_result'), pg_temp.get('b2_result'), pg_temp.get('scene_ms'),
    pg_temp.get('lock_wait_ms'), round(extract(epoch FROM clock_timestamp() - pg_temp.get('t0')::timestamptz) * 1000);
END $z$;
