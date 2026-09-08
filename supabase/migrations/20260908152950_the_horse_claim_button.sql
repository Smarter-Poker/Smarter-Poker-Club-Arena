-- 20260908152950_the_horse_claim_button.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- A HORSE'S CLAIM BUTTON IS KEYED TO WHO IS OWED, NOT TO WHO JUST DID SOMETHING.
-- (CLAUDE.md 10.5, 10.11, 10.12; docs/changelog/2026-09-08-the-horse-claim-button.md)
--
-- On 2026-09-08 twenty-three horses were holding 759 completed, unclaimed, in-window challenge
-- rewards worth 51,380 diamonds, 114 of them hours from expiry. They were settled. THE CAUSE WAS
-- NOT, and this is the cause.
--
-- The horse claim lives inside `record_daily_challenge_event`, in an `IF ... is_horse THEN` block
-- that runs when an event arrives for that horse. The chain is:
--
--     something happens  ->  enqueue_daily_challenge_event  ->  outbox
--     outbox  ->  fn_drain_daily_challenge_event_outbox (pg_cron, every minute, 4 shards)
--             ->  record_daily_challenge_event  ->  the claim loop
--
-- So the claim is keyed to a horse DOING something. **A horse that stops playing stops claiming**,
-- and its earned rewards sit until the seven-day window closes on them. The 23 horses in the
-- backlog had reported no event since 05:07.
--
-- A human who stops playing keeps a claim button for the whole seven days. Same reward, same
-- window, different outcome, decided entirely by the fact that a horse has no browser. That is
-- what 10.5 forbids, and the existing comment in that block says so in as many words - it was
-- written to give a horse the whole still-claimable set rather than only what one transaction
-- completed. It fixed the WIDTH of the claim and left its TRIGGER attached to activity.
--
-- I SAID THIS FIX WAS ENGINE-SIDE TYPESCRIPT. IT IS NOT, AND THE CORRECTION MATTERS. The claim
-- already runs server-side on a minute cadence; nothing needed to be built in HorseLogic. What was
-- wrong was which question the minute cadence asks. It asked "who just acted"; it now asks "who is
-- owed". Everything needed for that was already here.
--
-- WHY THIS IS NOT A BAND-AID (10.12), because it is a scheduled job that pays people and that is
-- the exact shape 10.12 refuses. It repairs nothing and compensates for nothing. **It IS the
-- button.** A human presses one; a horse has no browser, so the engine presses it on the horse's
-- behalf - which is precisely the one legitimate horse branch 10.5 names, alongside HorseLogic
-- choosing actions, `scheduleHorseAction` submitting them inside the same turn timer, and the
-- synthetic heartbeat keeping the seat alive. A repair job would be one that noticed the claim had
-- FAILED and re-ran it. This is the claim.
--
-- AND IT ENDS THE DUPLICATION IN THE SAME EDIT. The loop existed in both
-- `record_daily_challenge_event` (6 args) and `record_daily_challenge_event_serialized_body`
-- (5 args), identical, with nothing able to notice if they diverged - a normaliser was pinning
-- them character-for-character because merging them was too risky the same afternoon 759 rewards
-- came back through that path. Moving the claim OUT of the event path removes both copies. There
-- is now one claim, in one place, keyed to the only thing that matters.
--
-- ONE MORE CORRECTION, to an instrument I wrote three hours ago. `fn_ca_diamond_health` reported
-- "19 earned reward(s) are unclaimed and will expire" and blamed the horse mechanism. All 19
-- belong to TWO HUMANS. A human with an unclaimed reward has a button and has not pressed it -
-- that is not a defect and must not be amber. Counting the two together, and attributing both to a
-- cause I had only checked for one of them, is the same error this whole day has been about. The
-- row now separates them: a horse owed a claim is a defect, because nothing but this sweep will
-- ever press its button; a human owed a claim is a person who has not logged in.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The button.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_horse_claim_due(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE r record; v_claimed integer := 0; v_failed integer := 0; v_msg text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due: service_role required';
  END IF;

  -- Overlapping runs would fight over the same rows. Non-blocking: if a run is already going, this
  -- tick does nothing rather than queueing behind it, because the next tick is sixty seconds away.
  IF NOT pg_try_advisory_lock(hashtext('ca_horse_claim_due')) THEN
    RETURN 0;
  END IF;

  BEGIN
    FOR r IN
      -- OLDEST FIRST, so the rows closest to expiring are always the ones that get through a
      -- limit. HORSES ONLY: a human's claim is a human's to press, and pressing it for them would
      -- be as wrong as never pressing a horse's.
      SELECT u.id, u.user_id
        FROM public.user_daily_challenges u
        JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
       WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at >= now() - interval '7 days'
       ORDER BY u.completed_at, u.id
       LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    LOOP
      BEGIN
        PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
        v_claimed := v_claimed + 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        v_failed := v_failed + 1;
        -- The per-user daily cap is the same cap a human meets and a thousand horses meet it every
        -- day; filing that would be an always-on alarm. The remainder waits for the next tick,
        -- inside the same seven-day window. Anything else is a real failure and is filed.
        IF v_msg NOT LIKE '%DR7:user_over_daily_cap%' THEN
          BEGIN
            PERFORM public.fn_ca_diamond_incident(
              'CH3:horse_claim_failed', 'warning', r.user_id, NULL, 'fn_ca_horse_claim_due',
              jsonb_build_object('challenge_row_id', r.id, 'sqlerrm', v_msg));
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
        END IF;
      END;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(hashtext('ca_horse_claim_due'));
    RAISE;
  END;

  PERFORM pg_advisory_unlock(hashtext('ca_horse_claim_due'));
  RETURN v_claimed;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_claim_due(integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_horse_claim_due(integer) IS
  'A horse has no browser, so this presses its claim button - keyed to who is OWED a reward, not to who just acted. It is not a repair job (CLAUDE.md 10.12): it repairs nothing and compensates for nothing, it IS the button, and it is the same legitimate horse branch as HorseLogic choosing actions and scheduleHorseAction submitting them. Before it existed the claim lived inside record_daily_challenge_event, so a horse that stopped playing stopped claiming, and 23 quiet horses accumulated 759 rewards worth 51,380 diamonds with 114 hours from expiry.';

SELECT cron.schedule('ca-horse-claim-due-minute', '* * * * *',
                     $cron$SELECT public.fn_ca_horse_claim_due(500)$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute');

-- ---------------------------------------------------------------------------
-- 2. Take the claim out of the event path. Both copies, in one edit.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_oid oid; v_def text; v_new text; v_n integer := 0;
BEGIN
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('record_daily_challenge_event', 'record_daily_challenge_event_serialized_body')
       AND strpos(p.prosrc, 'FOR v_claim IN') > 0
  LOOP
    v_def := pg_get_functiondef(v_oid);
    -- The whole `IF ... is_horse THEN ... END LOOP; ... END IF;` block, non-greedy so it stops at
    -- the first END IF after the loop. Removing only the loop would leave an empty IF and fail to
    -- compile - which is the safety net here: CREATE OR REPLACE refuses anything malformed.
    --
    -- `.` already spans newlines in a Postgres regular expression, so `.*?` is what crosses the
    -- block; `[\s\S]*?` is the Perl idiom and does not behave the same way here.
    --
    -- THE TWO COPIES CLOSE DIFFERENTLY: the 6-argument one wraps its loop in an extra BEGIN/END,
    -- so it ends `END LOOP; END; END IF;` while the body function ends `END LOOP; END IF;`. A
    -- pattern written from one of them silently matched only that one - which is the same "two of
    -- anything" cost this migration is removing.
    v_new := regexp_replace(
      v_def,
      'IF EXISTS \(SELECT 1 FROM public\.profiles p WHERE p\.id = p_user_id AND p\.is_horse\) THEN.*?END LOOP;\s*(END;\s*)?END IF;',
      '-- The horse claim used to run here, which keyed it to a horse DOING something: a horse that'
      || chr(10) || '    -- stopped playing stopped claiming, and 23 quiet horses accumulated 759 rewards worth'
      || chr(10) || '    -- 51,380 diamonds. It is now fn_ca_horse_claim_due, keyed to who is OWED, on a minute'
      || chr(10) || '    -- tick. Recording an event does not pay anybody (CLAUDE.md 10.5, 10.11).',
      '');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'the horse claim block was not found in %', v_oid::regprocedure;
    END IF;

    -- One copy also DECLAREs the loop variable and the other does not - the two differed again,
    -- in a third way, and only an assertion on the finished text found it. An orphaned `v_claim
    -- record;` compiles perfectly well and would have left a reader thinking the claim was still
    -- there.
    v_new := regexp_replace(v_new, '[ \t]*v_claim[ \t]+record;[ \t]*\n?', '', 'g');

    IF strpos(v_new, 'v_claim') > 0 THEN
      RAISE EXCEPTION 'a reference to the claim loop survives in %', v_oid::regprocedure;
    END IF;
    EXECUTE v_new;
    v_n := v_n + 1;
  END LOOP;

  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected to clear the claim from 2 copies, cleared %', v_n;
  END IF;
END $$;

-- The normaliser that pinned the two copies has nothing left to pin. Kept, because the two
-- functions still exist and still duplicate everything else they do; merging THEM is separate
-- work. Its comment is corrected so it does not describe a loop that is gone.
COMMENT ON FUNCTION public.fn_ca_normalise_claim_loop(text) IS
  'Reduces a function body to its horse claim loop for comparison. The loop was removed from both copies of record_daily_challenge_event on 2026-09-08 and now lives once, in fn_ca_horse_claim_due, so this currently finds nothing in them - which is the correct answer and is asserted. Kept because the two event functions still duplicate each other in every other respect.';

-- ---------------------------------------------------------------------------
-- 3. The health row stops blaming the horse mechanism for a human's choice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health()
RETURNS TABLE (area text, status text, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n bigint; v_h bigint; v_m numeric; v_t text;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-diamond-rule-flip-daily' AND active;
  RETURN QUERY SELECT 'rule arming'::text,
    CASE WHEN v_n = 1 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 1
         THEN 'ca-diamond-rule-flip-daily is scheduled and active; flip_after dates will be acted on.'
         ELSE 'NOTHING ARMS THE RULES. Every flip_after date will pass unremarked and every rule '
              || 'stays in log mode for ever.' END;

  SELECT count(*) INTO v_n
    FROM public.fn_ca_diamond_rule_flip_due(true) x
    JOIN public.ca_diamond_rule_modes m ON m.rule = x.rule
   WHERE x.action = 'blocked' AND m.flip_after IS NOT NULL AND m.flip_after <= now();
  RETURN QUERY SELECT 'rules overdue'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No rule is past its arming date and still stuck.'
         ELSE v_n || ' rule(s) are past their arming date and still cannot arm; read '
              || 'fn_ca_diamond_rule_flip_due(true) for each reason.' END;

  v_m := (SELECT public.fn_ca_mint_supply('diamonds'))
         - ((SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float());
  RETURN QUERY SELECT 'money identity'::text,
    CASE WHEN v_m = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_m = 0 THEN 'players + float = register, exactly.'
         ELSE 'players + float differs from the register by ' || v_m || '.' END;

  v_m := public.fn_ca_diamond_snapshot();
  RETURN QUERY SELECT 'deploy gate'::text,
    CASE WHEN COALESCE(v_m, -1) = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN COALESCE(v_m, -1) = 0 THEN 'The snapshot explains every movement it can see.'
         ELSE COALESCE(v_m::text, 'NULL') || ' unexplained since the last snapshot.' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance() x
   WHERE x.difference IS NOT NULL AND x.difference <> 0;
  RETURN QUERY SELECT 'trial balance'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 0 THEN 'Every reconciling account balances against the journal.'
         ELSE v_n || ' account(s) do not reconcile.' END;

  SELECT COALESCE(sum(x.would_refuse), 0) INTO v_n FROM public.fn_ca_diamond_cap_headroom(14) x;
  RETURN QUERY SELECT 'per-user caps'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No real user-day in fourteen days exceeds the cap that applies to it.'
         ELSE v_n || ' user-day(s) exceed the cap that applies to them; arming would refuse them.' END;

  SELECT count(*) INTO v_n FROM public.diamond_engine_daily_caps
   WHERE max_per_user_per_day_vip IS NOT NULL AND max_per_user_per_day IS NOT NULL
     AND max_per_user_per_day_vip < max_per_user_per_day;
  RETURN QUERY SELECT 'VIP caps'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No cap gives a VIP less than a standard player receives.'
         ELSE v_n || ' cap(s) make VIP a downgrade.' END;

  -- A HORSE OWED A CLAIM IS A DEFECT. A HUMAN OWED ONE IS A PERSON WHO HAS NOT LOGGED IN.
  -- The first draft of this row counted them together and blamed the horse mechanism for both;
  -- all 19 it found belonged to two humans, and it reported that as amber against a cause it had
  -- not checked. Nothing but fn_ca_horse_claim_due will ever press a horse's button, so a horse
  -- owed anything means that sweep is not working.
  SELECT count(*) FILTER (WHERE p.is_horse), count(*) FILTER (WHERE NOT COALESCE(p.is_horse, false))
    INTO v_h, v_n
    FROM public.user_daily_challenges u JOIN public.profiles p ON p.id = u.user_id
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days'
     AND u.completed_at < now() - interval '5 minutes';
  RETURN QUERY SELECT 'horse claims'::text,
    CASE WHEN v_h = 0 THEN 'ok' WHEN v_h < 50 THEN 'attention' ELSE 'critical' END,
    CASE WHEN v_h = 0
         THEN 'No horse is owed a reward it cannot claim. ' || v_n || ' human reward(s) are '
              || 'unclaimed, which is a person choosing not to press a button, not a defect.'
         ELSE v_h || ' horse reward(s) are owed and unclaimed past the sweep interval. Nothing but '
              || 'fn_ca_horse_claim_due presses a horse''s button, so it is not working. 759 built '
              || 'up this way on 2026-09-08 when the claim was keyed to activity instead.' END;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active;
  RETURN QUERY SELECT 'horse claim button'::text,
    CASE WHEN v_n = 1 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 1 THEN 'ca-horse-claim-due-minute is scheduled and active.'
         ELSE 'NOTHING PRESSES A HORSE''S CLAIM BUTTON. Every horse reward will expire unclaimed.' END;

  SELECT count(*) INTO v_n FROM public.profiles p
   WHERE p.is_horse AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id));
  RETURN QUERY SELECT 'horses are players'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'critical' END,
    CASE WHEN v_n = 0 THEN 'No horse is classified as test equipment.'
         ELSE v_n || ' horse(s) read as harness equipment and are denied what players get.' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_budget_reality() x
   WHERE x.verdict LIKE 'ALREADY OVER%' OR x.verdict LIKE 'FUTURE PLAN BELOW%' OR x.verdict LIKE 'BUDGETED ZERO%';
  RETURN QUERY SELECT 'budget plans'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'Every reward budget is plausible against actual issuance.'
         ELSE v_n || ' budget line(s) are fiction. They refuse nobody (ruling 21), but somebody is '
              || 'reading them. Setting them is Dan''s (10.9).' END;

  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_unreachable_money();
  RETURN QUERY SELECT 'unreachable money'::text,
    CASE WHEN v_n = 0 THEN 'ok' ELSE 'attention' END,
    CASE WHEN v_n = 0 THEN 'No diamonds are stranded where nothing can reach them.'
         ELSE v_n || ' finding(s); read fn_ca_diamond_unreachable_money().' END;

  SELECT count(*), max(i.occurred_at)::text INTO v_n, v_t
    FROM public.ca_diamond_incidents i
   WHERE i.rule = 'DR7:ledger_write_failed' AND i.occurred_at >= now() - interval '24 hours';
  RETURN QUERY SELECT 'evaluation coverage'::text,
    CASE WHEN COALESCE(v_n, 0) = 0 THEN 'ok'
         WHEN v_t::timestamptz >= now() - interval '1 hour' THEN 'critical'
         ELSE 'attention' END,
    CASE WHEN COALESCE(v_n, 0) = 0
         THEN 'Every award in the last 24 hours was evaluated by the rules, so their counts are totals.'
         WHEN v_t::timestamptz >= now() - interval '1 hour'
         THEN v_n || ' award(s) could not be evaluated at all in the last 24 hours and it is STILL '
              || 'HAPPENING (most recent ' || to_char(now() - v_t::timestamptz, 'HH24:MI')
              || ' ago). Every rule count is a floor, not a total.'
         ELSE v_n || ' award(s) could not be evaluated in the last 24 hours, but none for '
              || to_char(now() - v_t::timestamptz, 'HH24:MI') || '. Counts covering that burst are '
              || 'floors; the cause appears fixed.' END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health() TO service_role;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n bigint; v_before bigint; v_after bigint; v_paid integer; v_bal numeric;
BEGIN
  -- The claim is gone from the event path, in every copy of it.
  --
  -- SCOPED TO THE EVENT FUNCTIONS, because an unscoped search matches fn_ca_normalise_claim_loop,
  -- which carries 'FOR v_claim IN' as the needle it searches FOR. A guard matching its own text is
  -- the third time that has happened in this programme; the rule is to strip comments and to name
  -- the objects you mean.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'record_daily_challenge_event%'
     AND strpos(p.prosrc, 'FOR v_claim IN') > 0;
  IF v_n <> 0 THEN RAISE EXCEPTION '% event function(s) still claim inside the event path', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('record_daily_challenge_event', 'record_daily_challenge_event_serialized_body')
     AND length(public.fn_ca_normalise_claim_loop(p.prosrc)) > 0;
  IF v_n <> 0 THEN RAISE EXCEPTION 'the normaliser still finds a claim loop in the event path'; END IF;
  -- AND EVERY EVENT FUNCTION STILL EXISTS. There are THREE, not two: record_daily_challenge_event
  -- has a 5-argument and a 6-argument overload, and only the 6-argument one ever carried the
  -- claim. An earlier draft of this line expected two and would have failed a correct edit - the
  -- overload trap this repo has recorded before, where a name is not a function.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'record_daily_challenge_event%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'expected 3 event functions (2 overloads + the serialized body), found %', v_n;
  END IF;

  -- the button exists, is scheduled, and only presses for horses
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-horse-claim-due-minute' AND active) THEN
    RAISE EXCEPTION 'nothing presses a horse claim button';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_ca_horse_claim_due') NOT LIKE '%p.is_horse%' THEN
    RAISE EXCEPTION 'the claim sweep does not restrict itself to horses';
  END IF;

  -- IT ACTUALLY CLAIMS. Run it for real: any horse owed a reward must end up with none owed, and
  -- the money must still balance. Asserting the function exists proves nothing (10.86).
  SELECT count(*) INTO v_before FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
  SELECT COALESCE(sum(diamonds), 0) INTO v_bal FROM public.profiles;
  v_paid := public.fn_ca_horse_claim_due(500);
  SELECT count(*) INTO v_after FROM public.user_daily_challenges u
    JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
   WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
     AND u.completed_at >= now() - interval '7 days';
  IF v_after > v_before THEN
    RAISE EXCEPTION 'the sweep left more owed than it found (% -> %)', v_before, v_after;
  END IF;
  IF v_before > 0 AND v_paid = 0 AND v_after = v_before THEN
    RAISE EXCEPTION '% horse claim(s) were owed and the sweep paid none of them', v_before;
  END IF;
  RAISE NOTICE 'sweep: % owed before, % paid, % owed after; % diamonds to horses',
    v_before, v_paid, v_after, (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) - v_bal;

  -- IT NEVER PRESSES A HUMAN'S BUTTON. The clearest way to prove that is to check that the humans
  -- who are owed rewards still are.
  IF (SELECT count(*) FROM public.user_daily_challenges u
        JOIN public.profiles p ON p.id = u.user_id
       WHERE NOT COALESCE(p.is_horse, false) AND u.completed AND NOT u.claimed
         AND u.expired_at IS NULL AND u.completed_at >= now() - interval '7 days') = 0
     AND (SELECT count(*) FROM public.profiles WHERE NOT COALESCE(is_horse, false)) > 0 THEN
    RAISE EXCEPTION 'every human claim was pressed; the sweep is not horse-only';
  END IF;

  -- the health row separates the two and watches the sweep
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
                  WHERE h.area = 'horse claims' AND h.detail LIKE '%not a defect%') THEN
    RAISE EXCEPTION 'the health row still treats a human unclaimed reward as a defect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
                  WHERE h.area = 'horse claim button' AND h.status = 'ok') THEN
    RAISE EXCEPTION 'the health report does not confirm the claim button is scheduled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_health() h
              WHERE h.area IN ('rule arming', 'money identity', 'deploy gate', 'trial balance',
                               'horses are players', 'VIP caps', 'per-user caps',
                               'horse claims', 'horse claim button')
                AND h.status <> 'ok') THEN
    RAISE EXCEPTION 'an area this migration is responsible for is not ok: %',
      (SELECT string_agg(h.area || ' [' || h.status || '] ' || h.detail, '; ')
         FROM public.fn_ca_diamond_health() h
        WHERE h.area IN ('rule arming', 'money identity', 'deploy gate', 'trial balance',
                         'horses are players', 'VIP caps', 'per-user caps',
                         'horse claims', 'horse claim button') AND h.status <> 'ok');
  END IF;

  -- and the money adds up after a sweep that may have paid
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after the claim sweep';
  END IF;
END $$;

COMMIT;
