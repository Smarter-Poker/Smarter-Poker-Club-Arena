-- 20260908043830_the_horse_claim_is_on_the_path_the_engine_calls.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md ruling 3; CLAUDE.md 10.5 and 10.86;
-- docs/changelog/2026-09-08-the-horse-claim-was-on-the-wrong-path.md):
--
-- THE HORSE CLAIM SHIPPED ONTO A PATH THE ENGINE DOES NOT CALL, AND I SHIPPED IT.
--
-- 20260908024742 put the claim loop into record_daily_challenge_event_serialized_body, and the
-- probe proved the mechanism works: a horse completed a challenge and was paid in the same
-- transaction. It proved it on the FIVE-argument path. The engine calls the SIX-argument
-- record_daily_challenge_event(p_user_id, p_event_key, p_amounts, p_magnitudes, p_values,
-- p_occurred_at), which carries its own completion UPDATE inline and never touches the
-- serialized body at all.
--
-- Measured an hour after that migration: 733 challenges completed on the live path (58 in the
-- 04:00 hour alone, the most recent at 04:27), 0 rows claimed, 0 CH3:horse_claim_failed
-- incidents. A feature that neither works nor complains - which is exactly the shape CLAUDE.md
-- 10.86 is about, written by the agent that had spent the night fixing other people's versions
-- of it. The ca_patch overload assertion did not catch it because the function I patched really
-- does have exactly one overload; it is simply not the one that runs.
--
-- This puts the same loop, unchanged, at the end of the six-argument function, so a horse is
-- claimed for by whichever path completes its challenge. Both paths now carry it: the
-- five-argument one is legacy but still reachable through its own wrapper, and a claim that has
-- already happened is a no-op (the row is `claimed` and the loop only selects unclaimed rows).
--
-- THE LESSON, WRITTEN DOWN: an overload count of one proves the function is unique, not that it
-- is USED. Before patching a body, ask what calls it - `SELECT proname FROM pg_proc WHERE
-- prosrc LIKE '%<the body>%'` - and after applying, ask the DATA whether the new behaviour
-- happened. The probe answered "the mechanism works"; only the live counter answers "it ran".

BEGIN;

CREATE FUNCTION pg_temp.ca_patch(p_oid oid, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p_oid) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker found % times in %', v_n, p_oid::regprocedure; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

DO $$
DECLARE v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_daily_challenge_event'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_user_id uuid, p_event_key text, p_amounts jsonb, p_magnitudes jsonb, p_values jsonb, p_occurred_at timestamp with time zone';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'the six-argument record_daily_challenge_event is not here'; END IF;

  PERFORM pg_temp.ca_patch(v_oid,
$ca_from$  SELECT updated.id,
         updated.challenge_id,
         updated.progress,
         updated.requirement_snapshot,
         updated.chip_reward_snapshot,
         updated.diamond_reward_snapshot,
         updated.completed
  FROM updated;
END;$ca_from$,
$ca_to$  SELECT updated.id,
         updated.challenge_id,
         updated.progress,
         updated.requirement_snapshot,
         updated.chip_reward_snapshot,
         updated.diamond_reward_snapshot,
         updated.completed
  FROM updated;

  -- DIAMOND-RULINGS 3 (CLAUDE.md 10.5, horses are players): a horse has no browser, so the
  -- engine is its input device and it presses Claim the moment a human would be shown the
  -- button - here, in the transaction that completed the challenge, through the SAME claim body
  -- a human's click reaches (same seven-day window, same per-user daily cap, same journal row).
  -- completed_at = now() names the rows this transaction completed. A claim that fails is filed
  -- and never breaks the progress just recorded.
  --
  -- THIS IS THE PATH THE ENGINE CALLS. 20260908024742 put the identical loop on the
  -- five-argument serialized body, which nothing in the engine reaches; 733 challenges completed
  -- and 0 were claimed before this was noticed.
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND p.is_horse) THEN
    DECLARE v_claim record;
    BEGIN
      FOR v_claim IN
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
      END LOOP;
    END;
  END IF;
END;$ca_to$);
END $$;

-- Assertions.
DO $$
DECLARE v_body text; v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_daily_challenge_event'
     AND p.prosrc LIKE '%claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one record_daily_challenge_event overload to claim for a horse, found %', v_n;
  END IF;

  -- every function that completes a challenge must also claim for a horse
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosrc LIKE '%completed = (u.progress%'
     AND p.prosrc NOT LIKE '%claim_daily_challenge_serialized_body%';
  IF v_body IS NOT NULL THEN
    RAISE EXCEPTION 'these functions complete a challenge but never claim for a horse: %', v_body;
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds')) <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) THEN
    RAISE EXCEPTION 'the register and the players disagree before any claim has run';
  END IF;
END $$;

COMMIT;
