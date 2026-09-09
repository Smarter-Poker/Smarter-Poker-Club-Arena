-- 20260908060700_what_the_second_review_found.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md 3 and 13; CLAUDE.md 10.5, 10.12, 10.84,
-- 10.86; docs/changelog/2026-09-08-what-the-second-review-found.md):
--
-- An adversarial read-only review of the six migrations applied earlier tonight found them all
-- correctly applied, byte-identical to their files, with the money identity exact - and then
-- found nine defects, four of them mine and one of them serious. This fixes eight; the ninth is
-- a process note. Nothing here is a repair job: every fix changes the live path.
--
-- D1 (HIGH). A HORSE COULD ONLY BE PAID FOR WHAT IT COMPLETED IN THAT VERY TRANSACTION.
--   The claim loop selected `completed_at = now()`, so it paid the rows the current event had
--   just completed and nothing else. When it went live at 04:38 there were 35,581 completed,
--   unclaimed rows still inside their seven-day window, worth 2,233,572 diamonds across 1,002
--   horses - every one of them earned, none of them reachable, and all of them due to be
--   extinguished by the seven-day expiry.
--
--   A HUMAN IN THAT POSITION STILL HAS A CLAIM BUTTON. That is the whole of CLAUDE.md 10.5: the
--   engine is the horse's input device, and an input device that can only press the button in
--   the same millisecond the challenge completes is not the same button. The loop now claims the
--   horse's whole still-claimable set, oldest first, exactly as a human working down their list
--   would - and stops at the first refusal, because the per-user daily cap is the same cap a
--   human meets and the remainder waits for tomorrow inside the same window.
--
--   This does NOT reopen ruling 3. Rows outside the seven-day window are untouched and still
--   expire: no retroactive mint into idle wallets, for anyone. What is paid is what a human
--   could still have clicked today.
--
--   HOW MUCH THAT IS, MEASURED RATHER THAN ASSUMED. This paragraph first said the 2,000 per-user
--   daily cap would meter the drain so that "most settles over the window and the rest expires".
--   THAT WAS FALSE WHEN IT WAS WRITTEN, and the live counters said so within ten minutes:
--   653 of 675 paid accounts went past 2,000, the largest to 2,642, and 1,558,308 diamonds were
--   issued in the first quarter of an hour. The cap does not bite because
--   DR7:user_over_daily_cap is in `log` mode until its scheduled flip on 2026-09-14 - it records
--   the breach and refuses nothing - and that is true for a human exactly as it is for a horse.
--
--   The payment is still right: these are earned rewards inside their window, and a human with
--   the same list and the Claim All button would be paid the same way today. The supply roughly
--   doubles as the backlog settles, which is a real event, and the velocity alarm makes it
--   visible - it read 548.54 against a band of 25 and filed once. What the caps should be from
--   here is Dan's (10.9: fixing what a past event owes is mine, setting what future ones owe is
--   his), and the flip that makes them bite is already scheduled.
--
--   The correction is recorded rather than quietly edited because it is the same mistake as D5
--   below: a written derivation that was already false the moment it shipped.
--
--   A refusal that IS the cap files nothing. Once the flip lands that becomes the ordinary daily
--   outcome for a thousand horses, and filing it would rebuild D4's always-on alarm elsewhere.
--
-- D2 (MEDIUM, latent). RETENTION WOULD HAVE TRUNCATED STREAKS. get_challenge_streak reads every
--   completed row with no lower bound, so deleting claimed rows at 60 days would have made any
--   streak longer than 60 days uncomputable from about November. Completed rows are kept 400
--   days; the pruning weight moves to the class that actually needs it (D8).
--
-- D3 (MEDIUM). DR13'S MODE WAS DECORATIVE AND THE DETECTOR PASSED IT. fn_ca_diamond_economy_watch
--   read the mode into a variable and returned it without ever using it, so a flip would have
--   changed nothing - and fn_ca_diamond_unreachable_money's third arm was satisfied by a body
--   that merely MENTIONS the rule name and the function name anywhere. The rule that migration
--   inserted was the first false negative of the detector the same migration shipped. The watch
--   now uses the mode (refuse escalates what it files to critical), and the detector requires the
--   literal call fn_ca_diamond_rule_mode('<rule>').
--
-- D4 (MEDIUM). THE CONCENTRATION ALARM FILED ON EVERY CALL, FOREVER. Five identical unresolved
--   warnings in twelve minutes, about a structural fact nobody can change, into the one table
--   whose retention only removes RESOLVED rows. An alarm that is always on is an alarm that gets
--   muted (10.84). It now files at most once a day per kind, and it excludes fixture accounts
--   from the concentration figure as every flow metric in the same family already does.
--
-- D5 (LOW-MEDIUM). THE VELOCITY THRESHOLD'S WRITTEN DERIVATION WAS ALREADY FALSE when it shipped:
--   it cited player spending of 370 and a ratio near 50, both from the definition that was
--   replaced 162 seconds later. Re-derived below against what the shipped definition actually
--   returns, and the NUMBER is changed to match the reasoning rather than the reasoning edited to
--   match the number.
--
-- D6 (LOW). sink_30d IN THE ALARM'S OUTPUT HELD PLAYER SPEND, not the raw sink, because the
--   051206 patch reused the variable. Both are returned under their own names.
--
-- D8 (LOW-MEDIUM). THE RETENTION NET COULD NOT REACH THE CLASS THAT GROWS FASTEST: 10,619 rows
--   assigned and never completed, which no expiry and no prune could ever remove. They are pruned
--   at 60 days, by which time the day they belong to is long closed. They are not part of any
--   streak, because a streak counts completions.
--
-- D9 is a process note, not a change: 20260908051206's pg_temp.ca_patch selected its target by
--   NAME with no overload guard - the identical trap 20260908043830 was written to document,
--   reintroduced three hours later in the helper instead of the target. It did not bite; both
--   targets are unique. The oid-taking version below is the one to copy.
--
-- One transaction.

BEGIN;

CREATE FUNCTION pg_temp.ca_patch(p_oid oid, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  -- Takes an OID, never a name (D9): a name silently picks one of several overloads.
  SELECT pg_get_functiondef(p_oid) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker found % times in %', v_n, p_oid::regprocedure; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

-- ---------------------------------------------------------------------------
-- D1. The horse gets the same seven days a human gets.
--
-- Two overloads carry this loop and their bodies are indented differently, so each is patched
-- against its own text. The shared reasoning is written once, above the first.
-- ---------------------------------------------------------------------------

-- record_daily_challenge_event_serialized_body(uuid,text,jsonb,jsonb,timestamptz)
SELECT pg_temp.ca_patch(
  'public.record_daily_challenge_event_serialized_body(uuid,text,jsonb,jsonb,timestamptz)'::regprocedure,
$ca_from$    FOR v_claim IN
      SELECT u.id
        FROM public.user_daily_challenges u
       WHERE u.user_id = p_user_id
         AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at = now()
       ORDER BY u.id
    LOOP
      BEGIN
        PERFORM public.claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          PERFORM public.fn_ca_diamond_incident(
            'CH3:horse_claim_failed', 'warning', p_user_id, NULL,
            'record_daily_challenge_event_serialized_body',
            jsonb_build_object('challenge_row_id', v_claim.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END;
    END LOOP;$ca_from$,
$ca_to$    -- The horse's whole STILL-CLAIMABLE set, oldest first - not only what this transaction
    -- completed. A human with the same list can click every one of them at any point inside the
    -- seven days, and an input device that can only press in the same millisecond the challenge
    -- completed is not the same button (CLAUDE.md 10.5). Rows outside the window are excluded
    -- here and still expire, so ruling 3 holds: no retroactive mint into an idle wallet.
    FOR v_claim IN
      SELECT u.id
        FROM public.user_daily_challenges u
       WHERE u.user_id = p_user_id
         AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at >= now() - interval '7 days'
       ORDER BY u.completed_at, u.id
    LOOP
      BEGIN
        PERFORM public.claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL);
      EXCEPTION WHEN OTHERS THEN
        BEGIN
          -- The per-user daily cap is the same cap a human meets, and a thousand horses meet it
          -- every day: filing it would rebuild the always-on alarm this migration removes
          -- elsewhere. The remainder waits for tomorrow, inside the same window.
          IF SQLERRM NOT LIKE '%daily_cap%' THEN
            PERFORM public.fn_ca_diamond_incident(
              'CH3:horse_claim_failed', 'warning', p_user_id, NULL,
              'record_daily_challenge_event_serialized_body',
              jsonb_build_object('challenge_row_id', v_claim.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
          END IF;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        -- One refusal ends the pass. The next thirty-four attempts would fail identically.
        EXIT;
      END;
    END LOOP;$ca_to$);

-- record_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz) - the path the engine calls
SELECT pg_temp.ca_patch(
  'public.record_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure,
$ca_from$      FOR v_claim IN
        SELECT u.id
          FROM public.user_daily_challenges u
         WHERE u.user_id = p_user_id
           AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
           AND u.completed_at = now()
         ORDER BY u.id
      LOOP
        BEGIN
          PERFORM public.claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL);
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            PERFORM public.fn_ca_diamond_incident(
              'CH3:horse_claim_failed', 'warning', p_user_id, NULL,
              'record_daily_challenge_event(6)',
              jsonb_build_object('challenge_row_id', v_claim.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
        END;
      END LOOP;$ca_from$,
$ca_to$      -- The whole still-claimable set, oldest first; the reasoning is on the five-argument
      -- overload above. This is the path the engine actually calls.
      FOR v_claim IN
        SELECT u.id
          FROM public.user_daily_challenges u
         WHERE u.user_id = p_user_id
           AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
           AND u.completed_at >= now() - interval '7 days'
         ORDER BY u.completed_at, u.id
      LOOP
        BEGIN
          PERFORM public.claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL);
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            IF SQLERRM NOT LIKE '%daily_cap%' THEN
              PERFORM public.fn_ca_diamond_incident(
                'CH3:horse_claim_failed', 'warning', p_user_id, NULL,
                'record_daily_challenge_event(6)',
                jsonb_build_object('challenge_row_id', v_claim.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
            END IF;
          EXCEPTION WHEN OTHERS THEN NULL;
          END;
          EXIT;
        END;
      END LOOP;$ca_to$);

-- ---------------------------------------------------------------------------
-- D3, D4, D5, D6. The alarm uses its mode, files once a day, counts players, names its outputs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economy_watch()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conc numeric; v_ratio numeric; v_faucet numeric; v_sink_raw numeric; v_player numeric;
  v_top numeric; v_humans numeric; v_filed integer := 0;
  v_mode text := public.fn_ca_diamond_rule_mode('DR13:concentration_or_velocity');
  v_sev  text;
  -- CONCENTRATION, measured 2026-09-08: one human account (kingfish, role admin) held 494,445 of
  -- 566,246 human-held diamonds - 87.3 percent - with the next largest at 11,571. Fixtures are
  -- excluded here as they are from every flow metric. A band of 60 says "one account owns the
  -- currency" without firing on the ordinary case of a few large holders.
  c_concentration_pct constant numeric := 60;
  -- VELOCITY, re-derived 2026-09-08 against the definition that actually shipped. The comment
  -- this replaces cited player spending of 370 and a ratio near 50; both came from a definition
  -- superseded 162 seconds later and neither survived it. What the shipped definition returns
  -- over the same window is player spend 2,873 against a faucet of 20,283 - a ratio of 7.06. A
  -- band of 25 sits well above that and below anything that would count as the faucet running
  -- away. It is EXPECTED to fire once as the seven-day claim backlog settles, which is a real
  -- event and should be seen.
  c_ratio_max constant numeric := 25;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  -- The mode is USED, not merely reported: flipping DR13 escalates what it files. There is
  -- nothing here to refuse - only somebody to tell, louder (D3).
  v_sev := CASE WHEN v_mode = 'refuse' THEN 'critical' ELSE 'warning' END;

  SELECT COALESCE(max(p.diamonds), 0), COALESCE(sum(p.diamonds), 0)
    INTO v_top, v_humans
    FROM public.profiles p
   WHERE NOT p.is_horse AND NOT public.fn_ca_is_fixture_account(p.id);
  v_conc := CASE WHEN v_humans > 0 THEN round(100 * v_top / v_humans, 1) ELSE 0 END;

  SELECT COALESCE(sum(dt.amount) FILTER (WHERE dt.amount > 0), 0),
         COALESCE(sum(-dt.amount) FILTER (WHERE dt.amount < 0), 0)
    INTO v_faucet, v_sink_raw
    FROM public.diamond_transactions dt
   WHERE dt.created_at >= now() - interval '30 days'
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
  v_player := public.fn_ca_diamond_player_spend(now() - interval '30 days');
  v_ratio := CASE WHEN v_player > 0 THEN round(v_faucet / v_player, 2) ELSE NULL END;

  -- At most one open incident per kind per day: both conditions are structural and would
  -- otherwise file on every call for ever, into the one table whose retention only removes
  -- RESOLVED rows (D4).
  IF v_conc > c_concentration_pct
     AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_incidents i
                      WHERE i.rule = 'DR13:concentration_or_velocity'
                        AND i.detail ->> 'kind' = 'concentration'
                        AND i.resolved_at IS NULL
                        AND i.occurred_at > now() - interval '24 hours') THEN
    PERFORM public.fn_ca_diamond_incident('DR13:concentration_or_velocity', v_sev, NULL, v_top,
      'fn_ca_diamond_economy_watch',
      jsonb_build_object('kind', 'concentration', 'largest_human_pct', v_conc,
                         'threshold_pct', c_concentration_pct, 'largest_holder_diamonds', v_top,
                         'all_human_diamonds', v_humans,
                         'note', 'One account holds most of the human-held currency. Not a defect: a fact about the economy that should be seen. Filed at most once a day.'));
    v_filed := v_filed + 1;
  END IF;

  IF v_ratio IS NOT NULL AND v_ratio > c_ratio_max
     AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_incidents i
                      WHERE i.rule = 'DR13:concentration_or_velocity'
                        AND i.detail ->> 'kind' = 'velocity'
                        AND i.resolved_at IS NULL
                        AND i.occurred_at > now() - interval '24 hours') THEN
    PERFORM public.fn_ca_diamond_incident('DR13:concentration_or_velocity', v_sev, NULL, v_faucet - v_player,
      'fn_ca_diamond_economy_watch',
      jsonb_build_object('kind', 'velocity', 'faucet_over_player_spend', v_ratio, 'threshold', c_ratio_max,
                         'faucet_30d', v_faucet, 'player_spend_30d', v_player, 'sink_total_30d', v_sink_raw,
                         'note', 'Issuance is outrunning what players spend playing. The levers are the per-user daily caps and what diamonds can be spent on; both are Dan''s.'));
    v_filed := v_filed + 1;
  END IF;

  -- Each figure under its own name (D6): sink_30d used to carry player spend.
  RETURN jsonb_build_object('ok', true, 'concentration_pct', v_conc, 'faucet_over_sink', v_ratio,
                            'faucet_30d', v_faucet, 'player_spend_30d', v_player,
                            'sink_total_30d', v_sink_raw, 'incidents_filed', v_filed, 'mode', v_mode,
                            'severity_when_filed', v_sev);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economy_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economy_watch() TO service_role;

-- ---------------------------------------------------------------------------
-- D3 (second half). The detector demands the literal call, not a mention.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('public.fn_ca_diamond_unreachable_money()'::regprocedure,
$ca_from$      WHERE n.nspname = 'public' AND p.prosrc LIKE '%fn_ca_diamond_rule_mode%'
        AND p.prosrc LIKE '%' || r.rule || '%');$ca_from$,
$ca_to$      WHERE n.nspname = 'public'
        -- THE LITERAL CALL, not a body that merely mentions the two strings somewhere. The first
        -- version passed the rule its own migration had just inserted (D3, 2026-09-08).
        AND p.prosrc LIKE '%fn_ca_diamond_rule_mode(''' || r.rule || ''')%');$ca_to$);

-- ---------------------------------------------------------------------------
-- D2 and D8. Retention that is streak-safe and reaches the class that grows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_prune_history(p_incident_days integer DEFAULT 30,
                                                              p_challenge_days integer DEFAULT 400,
                                                              p_abandoned_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_incidents integer := 0; v_challenges integer := 0; v_abandoned integer := 0;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  -- The challenge floor is 400 days and not 60, because this table is also the streak ledger:
  -- get_challenge_streak reads every completed row with no lower bound and walks back to the
  -- first gap, so deleting completed rows inside any plausible streak horizon would make a long
  -- streak uncomputable (D2). 400 days is beyond a year-long streak.
  IF p_incident_days < 7 OR p_challenge_days < 400 OR p_abandoned_days < 45 THEN
    RAISE EXCEPTION 'retention below the floor: incidents 7 days, challenges 400 days, abandoned 45 days';
  END IF;

  DELETE FROM public.ca_diamond_incidents
   WHERE resolved_at IS NOT NULL
     AND severity IN ('info', 'warning')
     AND occurred_at < now() - make_interval(days => p_incident_days);
  GET DIAGNOSTICS v_incidents = ROW_COUNT;

  DELETE FROM public.user_daily_challenges
   WHERE (claimed OR expired_at IS NOT NULL)
     AND created_at < now() - make_interval(days => p_challenge_days);
  GET DIAGNOSTICS v_challenges = ROW_COUNT;

  -- Assigned and never completed: no expiry reaches it and no claim will ever come, so it was the
  -- one class the first version could not remove even though it grows fastest (D8). Not part of
  -- any streak, because a streak counts completions.
  DELETE FROM public.user_daily_challenges
   WHERE NOT completed
     AND created_at < now() - make_interval(days => p_abandoned_days);
  GET DIAGNOSTICS v_abandoned = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'incidents_pruned', v_incidents,
                            'challenges_pruned', v_challenges, 'abandoned_pruned', v_abandoned,
                            'incident_days', p_incident_days, 'challenge_days', p_challenge_days,
                            'abandoned_days', p_abandoned_days);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_prune_history(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_prune_history(integer, integer, integer) TO service_role;
DROP FUNCTION IF EXISTS public.fn_ca_diamond_prune_history(integer, integer);

-- ---------------------------------------------------------------------------
-- Assertions. Markers are chosen to contain no quotes, so that what is asserted is not itself
-- a puzzle about escaping.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_body text; v jsonb; v_left text;
BEGIN
  -- D1: no path may still be limited to this transaction's own completions, and BOTH overloads
  -- must carry the window, the oldest-first order and the quiet cap refusal.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc LIKE '%u.completed_at = now()%';
  IF v_n <> 0 THEN RAISE EXCEPTION '% function(s) still claim only what this transaction completed', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%u.completed_at >= now() - interval%'
     AND p.prosrc LIKE '%ORDER BY u.completed_at, u.id%'
     AND p.prosrc LIKE '%claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL)%'
     AND p.prosrc LIKE '%SQLERRM NOT LIKE%';
  IF v_n <> 2 THEN RAISE EXCEPTION 'only % of 2 completing paths claim the whole window', v_n; END IF;

  -- D3: the mode is used, and the detector wants a call rather than a mention
  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_economy_watch';
  IF v_body NOT LIKE '%v_sev := CASE WHEN v_mode%' OR v_body NOT LIKE '%v_sev);%' THEN
    RAISE EXCEPTION 'the DR13 mode is still decorative';
  END IF;
  SELECT p.prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_unreachable_money';
  IF v_body NOT LIKE '%THE LITERAL CALL, not a body that merely mentions%' THEN
    RAISE EXCEPTION 'the detector still accepts a mention instead of a call';
  END IF;

  -- and with the tighter arm it must still find nothing
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;

  -- D4: a second call in the same minute files nothing more
  v := public.fn_ca_diamond_economy_watch();
  IF (v ->> 'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'the watch did not run: %', v; END IF;
  v := public.fn_ca_diamond_economy_watch();
  IF (v ->> 'incidents_filed')::integer <> 0 THEN
    RAISE EXCEPTION 'the alarm filed again within the day: %', v;
  END IF;
  -- D6: both figures, each under its own name
  IF v ->> 'player_spend_30d' IS NULL OR v ->> 'sink_total_30d' IS NULL THEN
    RAISE EXCEPTION 'the alarm does not name its own outputs: %', v;
  END IF;
  IF (v ->> 'player_spend_30d')::numeric > (v ->> 'sink_total_30d')::numeric THEN
    RAISE EXCEPTION 'player spend exceeds every debit: %', v;
  END IF;

  -- D2/D8: floors hold, and the old two-argument signature with the unsafe default is gone
  BEGIN
    PERFORM public.fn_ca_diamond_prune_history(30, 60, 60);
    RAISE EXCEPTION 'retention accepted a challenge window inside the streak horizon';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%below the floor%' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_prune_history'
                AND pg_get_function_identity_arguments(p.oid) = 'p_incident_days integer, p_challenge_days integer') THEN
    RAISE EXCEPTION 'the old two-argument prune survived and would use the unsafe defaults';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree';
  END IF;
END $$;

COMMIT;
