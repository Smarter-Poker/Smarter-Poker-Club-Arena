-- 20260908024742_daily_challenges_claimed_for_horses_capped_by_the_line_and_e.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (docs/DIAMOND-RULINGS.md ruling 3, amended here, with 17 and 18;
-- CLAUDE.md 10.5; docs/changelog/2026-09-08-diamond-challenges-claimed-and-expired.md):
--
--   Daily challenges were the largest unbooked promise on the platform: 40,797 completed and
--   unclaimed rows worth 2,410,529 diamonds on 2026-09-08 (40,749 of them horses'), against a
--   supply of 1,023,527. Nothing claimed for a horse, and nothing expired for anyone.
--
--   1. A horse's completed challenge is claimed by its input device, the engine, in the same
--      transaction that completed it, through the SAME claim body a human's click reaches
--      (CLAUDE.md 10.5: same features, same functionality, same timing). A claim that fails is
--      filed as CH3:horse_claim_failed and never breaks the progress just recorded.
--   2. A completed reward is claimable for seven days, for everyone. Both claim paths refuse an
--      expired reward by the clock (P0430), so the rule holds whether or not the daily stamp has
--      run; the stamp (expired_at) is what the dashboard reads.
--   3. The backlog: everything completed more than seven days ago expires now. Rows completed
--      inside the window keep the rest of their window and expire on it. They are NOT claimed
--      retroactively (ruling 3: no retroactive mint into idle wallets).
--
-- RULING 3 IS AMENDED HERE, AND THE REASON IS MEASURED. It said a challenge is "capped at
-- assignment" by the daily_challenges budget line. That is a shared pot, and a shared pot is a
-- RACE: with 36,176 rows outstanding inside the window, the September line was already 516,919
-- in deficit, so an assignment cap would have set every player's next challenge to zero
-- diamonds for the rest of the month - the player who arrives later gets less, which is not
-- identical treatment. The cap belongs where the money moves, and it is already there: the earn
-- ledger measures every claim against the per-user daily cap (800 for daily_challenges,
-- identical for everyone) and against the monthly line, and 20260908021452 made both refusable
-- behind ca_diamond_rule_modes. Nothing is capped at assignment; a challenge pays what the
-- catalog promised, and the claim is what the limits govern.
--
-- THE CONSEQUENCE, STATED PLAINLY FOR DAN. With horses claiming, the daily_challenges line
-- carries the whole playing population, not a human-only estimate. Measured 2026-09-08 over the
-- three prior days: 4,945 to 8,183 rows assigned a day, 84,000 to 460,000 diamonds of reward a
-- day, average 95 to 471 per player per day and a maximum of 1,646. So the line is set to
-- 12,000,000 a month (about 400,000 a day, above the measured peak), not the 50,000 that ruling
-- 18 wrote when nothing claimed at all. This is a real increase in issuance: it is what
-- "horses are players" costs, and horse diamonds stay inside the platform (ruling 9). If the
-- aggregate should be smaller, the lever is the per-user daily cap in diamond_engine_daily_caps,
-- which is identical for horses and humans and is Dan's row to change.
--
-- One transaction. Only user_daily_challenges takes a table lock, and it is taken first: a
-- previous draft also altered diamond_reward_budgets and deadlocked three times against live
-- claims that hold this table and then read that one.

BEGIN;

SET LOCAL lock_timeout = '45s';
LOCK TABLE public.user_daily_challenges IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN RAISE EXCEPTION 'ca_patch: % has % overloads (expected 1)', p_fn, v_procs; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- 1. The claim window's stamp, and the index the claimable reads use.
ALTER TABLE public.user_daily_challenges ADD COLUMN IF NOT EXISTS expired_at timestamptz;
COMMENT ON COLUMN public.user_daily_challenges.expired_at IS
  'Set when a completed reward passed its seven-day claim window unclaimed (ruling 3). Both claim paths refuse by the clock regardless; this is what the dashboard reads.';
CREATE INDEX IF NOT EXISTS idx_user_daily_challenges_claimable
  ON public.user_daily_challenges (completed_at)
  WHERE completed AND NOT claimed AND expired_at IS NULL;

-- 2. The seven-day stamp. Its schedule IS the product (CLAUDE.md 10.12, the first thing that
--    rule does not ban): it does not repair anything, it stamps what the clock has already
--    decided so the dashboard agrees with the claim paths, which refuse on their own.
CREATE OR REPLACE FUNCTION public.fn_expire_daily_challenge_rewards()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  UPDATE public.user_daily_challenges
     SET expired_at = now()
   WHERE completed AND NOT claimed AND expired_at IS NULL
     AND completed_at < now() - interval '7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.fn_expire_daily_challenge_rewards() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_expire_daily_challenge_rewards() TO service_role;

-- 3. A HORSE IS NEVER A FIXTURE (CLAUDE.md 10.5; docs/DIAMOND-RULINGS.md, the second ruling the
--    review made necessary, which promised in writing that this predicate "never matches a
--    horse"). Measured 2026-09-08: it matched 468 of the 1,000 live horses, because an earlier
--    sweep tagged two whole horse generations into ca_cert_accounts ("Horse fleet generation of
--    2026-09-01", 416 rows; "zero-UUID seeded bot profile", 52 rows). Every one of those horses
--    was therefore skipped by the earn ledger, left out of the promotional budgets, and had its
--    incidents downgraded to info - the exact shape of exclusion 10.5 exists to forbid, found
--    because a horse's first real challenge claim recorded nothing at all.
--
--    The predicate now asks the profile, so no future tagging can exclude a horse again, and the
--    mis-tagged rows are deactivated with their reason kept. The certification harness is
--    unaffected: its accounts are not horses.
CREATE OR REPLACE FUNCTION public.fn_ca_is_fixture_account(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND u.email LIKE '%.invalid')
    );
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_is_fixture_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_fixture_account(uuid) TO service_role;

UPDATE public.ca_cert_accounts c
   SET active = false,
       reason = c.reason || ' [deactivated 2026-09-08: a horse is a player, never a certification fixture (CLAUDE.md 10.5)]'
 WHERE c.active
   AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = c.user_id AND COALESCE(p.is_horse, false));

-- 4. Apply-time patches of the live claim, dashboard and event bodies.
SELECT pg_temp.ca_patch('claim_daily_challenge_serialized_body', $ca_from$  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;
$ca_from$, $ca_to$  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;
  -- DIAMOND-RULINGS 3: a completed reward is claimable for seven days, for everyone. The stamp
  -- (expired_at) is what the dashboard reads; the clock is what this refuses by, so the rule
  -- holds whether or not the daily stamp has run.
  IF v_row.expired_at IS NOT NULL
     OR (v_row.completed_at IS NOT NULL AND v_row.completed_at < now() - interval '7 days') THEN
    RAISE EXCEPTION 'Challenge reward expired' USING ERRCODE = 'P0430';
  END IF;
$ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenges_serialized_body', $ca_from$    RAISE EXCEPTION 'One or more challenges are not complete';
  END IF;
$ca_from$, $ca_to$    RAISE EXCEPTION 'One or more challenges are not complete';
  END IF;
  -- DIAMOND-RULINGS 3: seven days to claim, for everyone.
  IF EXISTS (
    SELECT 1
      FROM public.user_daily_challenges
     WHERE id = ANY(v_owned_ids)
       AND NOT claimed
       AND (expired_at IS NOT NULL OR completed_at < now() - interval '7 days')
  ) THEN
    RAISE EXCEPTION 'One or more challenge rewards have expired' USING ERRCODE = 'P0430';
  END IF;
$ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenges_serialized_body', $ca_from$   WHERE user_id = v_uid
     AND completed = true
     AND claimed = false;
$ca_from$, $ca_to$   WHERE user_id = v_uid
     AND completed = true
     AND claimed = false
     AND expired_at IS NULL
     AND completed_at >= now() - interval '7 days';
$ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenges_serialized_body', $ca_from$       WHERE user_id = v_uid
         AND completed = true
         AND claimed = false
       ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
$ca_from$, $ca_to$       WHERE user_id = v_uid
         AND completed = true
         AND claimed = false
         AND expired_at IS NULL
         AND completed_at >= now() - interval '7 days'
       ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
$ca_to$, 1);

SELECT pg_temp.ca_patch('get_daily_challenge_dashboard_serialized_body', $ca_from$   WHERE user_id = v_uid AND completed = true AND claimed = false;
$ca_from$, $ca_to$   WHERE user_id = v_uid AND completed = true AND claimed = false
     AND expired_at IS NULL AND completed_at >= now() - interval '7 days';
$ca_to$, 1);

SELECT pg_temp.ca_patch('get_daily_challenge_dashboard_serialized_body', $ca_from$      WHERE user_id = v_uid AND completed = true AND claimed = false
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
$ca_from$, $ca_to$      WHERE user_id = v_uid AND completed = true AND claimed = false
        AND expired_at IS NULL AND completed_at >= now() - interval '7 days'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
$ca_to$, 1);

SELECT pg_temp.ca_patch('record_daily_challenge_event_serialized_body', $ca_from$  v_monthly_key text;
BEGIN
$ca_from$, $ca_to$  v_monthly_key text;
  v_claim record;
BEGIN
$ca_to$, 1);

SELECT pg_temp.ca_patch('record_daily_challenge_event_serialized_body', $ca_from$         updated.diamond_reward_snapshot, updated.completed
  FROM updated;
END;$ca_from$, $ca_to$         updated.diamond_reward_snapshot, updated.completed
  FROM updated;

  -- DIAMOND-RULINGS 3 (CLAUDE.md 10.5, horses are players): a horse has no browser, so the
  -- engine is its input device, and it presses Claim the moment a human would be shown the
  -- button - here, in the transaction that completed the challenge, through the SAME claim
  -- body a human's click reaches (same budget, same daily cap, same seven-day window, same
  -- journal row). completed_at = now() names the rows this transaction completed. A claim
  -- that fails is filed; it never breaks the progress that was just recorded.
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND p.is_horse) THEN
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
            'record_daily_challenge_event_serialized_body',
            jsonb_build_object('challenge_row_id', v_claim.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END;
    END LOOP;
  END IF;
END;$ca_to$, 1);

-- 5. The backlog. The dashboard-revision trigger is switched off for the one mass stamp:
--    probed 2026-09-08, its 4,639 per-row revision inserts take KEY SHARE locks on profiles
--    while this transaction holds the table, and a live session holding a profile row and
--    wanting this table deadlocks against it. A stale revision costs one refresh; the daily
--    stamp runs with the trigger on and takes no table lock.
ALTER TABLE public.user_daily_challenges DISABLE TRIGGER trg_daily_challenge_revision_from_contract;
SELECT public.fn_expire_daily_challenge_rewards() AS expired_now;
ALTER TABLE public.user_daily_challenges ENABLE TRIGGER trg_daily_challenge_revision_from_contract;

-- 6. The line, sized to the population that plays (see the header's measurement).
INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds)
VALUES (to_char((now() AT TIME ZONE 'America/Chicago'), 'YYYY-MM'), 'daily_challenges', 12000000, 0)
ON CONFLICT (period, engine) DO UPDATE SET budget_diamonds = 12000000, updated_at = now();

-- 7. The daily stamp, 00:07 UTC (after the 00:02 reset notifications).
SELECT cron.schedule('daily-missions-reward-expiry', '7 0 * * *',
                     $cron$SELECT public.fn_expire_daily_challenge_rewards();$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-missions-reward-expiry');

-- 8. Assertions.
DO $$
DECLARE v_body text; v_n bigint; v_expired bigint; v_budget bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.user_daily_challenges
   WHERE completed AND NOT claimed AND expired_at IS NULL AND completed_at < now() - interval '7 days';
  IF v_n <> 0 THEN RAISE EXCEPTION 'backlog: % rows older than seven days are still unexpired', v_n; END IF;
  SELECT count(*) INTO v_expired FROM public.user_daily_challenges WHERE expired_at IS NOT NULL;
  IF v_expired = 0 THEN RAISE EXCEPTION 'backlog: nothing expired, and 4,621 rows were older than seven days when this was written'; END IF;

  SELECT budget_diamonds INTO v_budget FROM public.diamond_reward_budgets
   WHERE engine = 'daily_challenges' AND period = to_char((now() AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
  IF v_budget <> 12000000 THEN RAISE EXCEPTION 'the daily_challenges line is %, not 12000000', v_budget; END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-missions-reward-expiry') THEN
    RAISE EXCEPTION 'the expiry stamp is not scheduled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE t.tgname = 'trg_daily_challenge_revision_from_contract'
                    AND c.relname = 'user_daily_challenges' AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION 'the dashboard revision trigger was left disabled';
  END IF;

  FOR v_body IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname IN ('claim_daily_challenge_serialized_body', 'claim_daily_challenges_serialized_body') LOOP
    IF v_body NOT LIKE '%ERRCODE = ''P0430''%' THEN RAISE EXCEPTION 'a claim body does not refuse an expired reward'; END IF;
  END LOOP;
  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_daily_challenge_event_serialized_body';
  IF v_body NOT LIKE '%claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL)%' THEN
    RAISE EXCEPTION 'the event recorder does not claim for a horse';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_daily_challenge_dashboard_serialized_body';
  IF v_body NOT LIKE '%expired_at IS NULL AND completed_at >= now() - interval ''7 days''%' THEN
    RAISE EXCEPTION 'the dashboard vault still lists expired rewards';
  END IF;
  SELECT count(*) INTO v_n FROM public.profiles p WHERE p.is_horse AND public.fn_ca_is_fixture_account(p.id);
  IF v_n <> 0 THEN RAISE EXCEPTION 'a horse is still a fixture: % of them', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_cert_accounts c JOIN public.profiles p ON p.id = c.user_id
              WHERE c.active AND COALESCE(p.is_horse, false)) THEN
    RAISE EXCEPTION 'an active certification row still points at a horse';
  END IF;

  -- nothing here may cap assignment: ruling 3 as amended
  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_snapshot_daily_challenge_contract';
  IF v_body LIKE '%budget_remaining%' THEN
    RAISE EXCEPTION 'the contract snapshot caps assignment; ruling 3 as amended caps the claim, not the assignment';
  END IF;
END $$;

COMMIT;
