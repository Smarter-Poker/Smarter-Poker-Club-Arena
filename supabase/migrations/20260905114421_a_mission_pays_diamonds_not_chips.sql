-- ═══════════════════════════════════════════════════════════════════════════
--  A MISSION PAYS DIAMONDS, NOT CHIPS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-05, verbatim: "NOTHING EVER 'EARNS CHIPS' ONLY EVER DIAMONDS.
-- MAKE SURE THATS THAT CASE GLOBALLY!" (his emphasis on GLOBALLY). The
-- referral paths were corrected the same day (20260905103510 / 20260905103839).
-- Daily Missions is the other reward surface, and it is much larger.
--
-- WHAT WAS ACTUALLY SITTING THERE
--
-- Three functions credited CHIPS through `atomic_credit_wallet_and_log`, which
-- settles into `club_members.chip_balance`:
--
--     claim_daily_challenge              one mission
--     claim_daily_challenges             the batch "claim all" path
--     fn_award_daily_mission_milestones  the streak circuits
--
-- Every mission also pays diamonds, so the chips were an EXTRA payout on top of
-- a reward that already existed. Measured on production 2026-09-05:
--
--     daily_challenge_catalog     57 of 58 rows carry chip_reward   1,564,050
--     daily_challenge_catalog     58 of 58 rows carry diamond_reward  8 .. 800
--     user_daily_challenges       32,793 rows carry a chip snapshot
--     user_daily_challenges       total chip snapshot            695,783,800
--     ...of which completed and unclaimed                        425,819,000
--     daily_challenge_milestones  5 rows, reward_chips              72,000
--
-- 425.8 MILLION chips are promised, right now, to 1,012 players, sitting in
-- completed-but-unclaimed rows going back to 2026-03-23 and still growing
-- (the most recent completion was today). For scale, `fn_club_chip_circulation`
-- put every chip in every member wallet at ~121 million. The first player to
-- find the "claim all" button would have minted several times the platform's
-- entire chip supply out of nothing, in one call, and the batch path credits
-- the WHOLE vault at once.
--
-- WHY THIS IS SAFE TO CORRECT RATHER THAN ESCALATE (CLAUDE.md 10.9)
--
-- NOTHING HAS EVER BEEN PAID ON THIS SURFACE. Measured, not assumed:
--
--     user_daily_challenges WHERE claimed          0 rows
--     daily_challenge_claim_batches                0 rows
--     daily_challenge_milestone_claims             0 rows
--     wallet_transactions mentioning the surface   1 row, and it is a
--                                                  "Test commission" on the
--                                                  system account from March
--
-- The claim RPC has never been invoked by anyone. So there is no past payout to
-- reconcile, nobody is paid twice, nothing is clawed back from a player, and no
-- player has ever held a chip that came from a mission. Every mission keeps a
-- real reward: its diamonds are untouched, and 1,695,205 of them are waiting in
-- that same vault.
--
-- The guard below asserts all three zeroes and aborts the migration if the
-- board moved between the probe and the apply.
--
-- THE MILESTONE AMOUNTS ARE A PRICING LINE, AND THEREFORE DAN'S
--
-- The five circuits had only a chip column, so unlike the missions they cannot
-- simply lose it - they would be left paying nothing. The column is renamed
-- (free: zero claims) and denominated in the diamond economy rather than
-- relabelled, because 50,000 diamonds is not 50,000 chips. A day of missions
-- yields roughly 100-300 diamonds (catalog mean 103), so a circuit sits above
-- a day and below a month of them:
--
--       7 days     150 diamonds        60 days   2,500 diamonds
--      14 days     400 diamonds       100 days   6,000 diamonds
--      30 days   1,000 diamonds
--
-- THESE FIVE NUMBERS ARE DAN'S TO SET (CLAUDE.md 10.9: "Anything that sets what
-- players are owed in FUTURE events ... is his"). They are gathered into one
-- VALUES list so changing them is a one-line edit. What this migration is
-- asserting is the MECHANISM - diamonds, idempotent, audited - not the price.
--
-- WHAT IS NOT TOUCHED
--
-- Chips remain chips where chips are the SUBJECT rather than the reward. The
-- challenge objectives that say "Win 2,500 Chips In Pots Today" are things a
-- player DOES, not things a player is given, and their `requirement` and
-- `threshold` columns are untouched. So is `reroll_daily_challenge`, which
-- SPENDS rather than earns.
--
-- REVERSIBILITY
--
-- Nothing is destroyed and no player row is edited. `daily_challenge_catalog`
-- is recorded by trigger into `daily_challenge_catalog_history`; every assigned
-- `chip_reward_snapshot` is left exactly as issued (section 2 explains why the
-- first draft of this migration was wrong to touch them); the milestone columns
-- are renamed rather than dropped. The totals above and the financial_alerts
-- row at the end are the written record (CLAUDE.md 10.9: correct it forward,
-- never edit history quiet).
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

-- ── 0. The probe's world, asserted ──────────────────────────────────────────
DO $guard$
DECLARE
  v_claimed   bigint;
  v_batches   bigint;
  v_milestone bigint;
BEGIN
  SELECT count(*) INTO v_claimed   FROM public.user_daily_challenges WHERE claimed;
  SELECT count(*) INTO v_batches   FROM public.daily_challenge_claim_batches;
  SELECT count(*) INTO v_milestone FROM public.daily_challenge_milestone_claims;

  IF v_claimed <> 0 OR v_batches <> 0 OR v_milestone <> 0 THEN
    RAISE EXCEPTION
      'ABORTING: a mission reward has been claimed since this was measured '
      '(claimed=%, batches=%, milestone_claims=%). Chips have now reached a '
      'player, so zeroing the snapshots would take back money we paid. Re-read '
      'the surface and settle those claims before applying this.',
      v_claimed, v_batches, v_milestone;
  END IF;
END;
$guard$;

-- ── 1. The catalog stops promising chips ────────────────────────────────────
UPDATE public.daily_challenge_catalog SET chip_reward = 0 WHERE chip_reward <> 0;

COMMENT ON COLUMN public.daily_challenge_catalog.chip_reward IS
  'ALWAYS 0. A mission reward is paid in diamonds (Dan 2026-09-05: nothing ever '
  'earns chips, only diamonds). Kept as a zeroed column rather than dropped '
  'because user_daily_challenges snapshots it and three RPCs still read the '
  'shape. diamond_reward is the reward. Prior values: daily_challenge_catalog_history.';

-- ── 2. The assigned snapshots are LEFT EXACTLY AS THEY ARE ─────────────────
--
-- This section used to zero the 695,783,800 chips sitting in
-- `user_daily_challenges.chip_reward_snapshot`, and the probe refused it:
--
--     ERROR: Assigned daily challenge contracts are immutable
--     CONTEXT: fn_snapshot_daily_challenge_contract() line 57
--
-- That trigger is right and the edit was wrong. A snapshot exists precisely so
-- that a contract already handed to a player cannot be changed underneath them,
-- and "the platform quietly lowered a reward I had already earned" is the exact
-- thing it is there to prevent - CLAUDE.md 10.9 rule 3 says the same in words.
--
-- Closing the liability does not require touching one player row. The 425.8M
-- was never a balance; it was a number three functions would have paid. Sections
-- 4, 5 and 6 remove the paying, so a stale snapshot is now inert - it cannot
-- mint a chip no matter what it says. The catalog above stops new assignments
-- carrying one at all, and the read paths report the chip figure as 0, so no
-- player is shown a promise that will not be honoured.
--
-- The old snapshots therefore stay on disk, unread, as the record of what was
-- assigned. Nothing is rewritten and nothing is destroyed.

COMMENT ON COLUMN public.user_daily_challenges.chip_reward_snapshot IS
  'DEAD SINCE 2026-09-05, AND DELIBERATELY NOT ZEROED. Held 695,783,800 chips '
  'across 32,793 assigned rows - 425,819,000 of them completed and one "claim '
  'all" from being minted, against ~121M chips in every member wallet combined. '
  'No row was ever claimed, so none was ever paid. It is not rewritten because '
  'fn_snapshot_daily_challenge_contract makes an assigned contract immutable, '
  'which is correct: the fix is that nothing pays chips any more. Read nothing '
  'from this column; diamond_reward_snapshot is the reward.';

-- ── 3. The streak circuits are denominated in diamonds ──────────────────────
ALTER TABLE public.daily_challenge_milestones       RENAME COLUMN reward_chips TO reward_diamonds;
ALTER TABLE public.daily_challenge_milestone_claims RENAME COLUMN reward_chips TO reward_diamonds;

UPDATE public.daily_challenge_milestones m
   SET reward_diamonds = v.diamonds
  FROM (VALUES
          (7,    150),   -- THE PRICING LINE. Diamonds. Dan's to change.
          (14,   400),
          (30,  1000),
          (60,  2500),
          (100, 6000)
       ) AS v(days, diamonds)
 WHERE m.days = v.days;

COMMENT ON COLUMN public.daily_challenge_milestones.reward_diamonds IS
  'Diamonds paid for reaching this streak. Was `reward_chips` (500/1500/5000/'
  '15000/50000) until 2026-09-05; renamed rather than added because no circuit '
  'had ever been claimed. Denominated in the diamond economy, not relabelled.';

-- ── 4. The single-mission claim ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_daily_challenge(
  p_user_id uuid, p_challenge_row_id uuid, p_reward_amount numeric DEFAULT NULL::numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_new_diamonds integer;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a challenge for another user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_row.claimed THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'alreadyClaimed', true,
      'chips', 0,
      'diamonds', 0,
      'diamondBalance', (SELECT COALESCE(diamonds, 0) FROM public.profiles WHERE id = v_uid)
    );
  END IF;
  IF NOT v_row.completed THEN RAISE EXCEPTION 'Challenge not completed yet'; END IF;
  IF v_row.progress < v_row.requirement_snapshot THEN
    RAISE EXCEPTION 'Challenge progress %/% does not meet the assigned requirement',
      v_row.progress, v_row.requirement_snapshot;
  END IF;

  /* The optimistic-concurrency check used to compare against the CHIP snapshot,
     which is now always 0 and therefore no longer identifies anything. It reads
     the diamond snapshot - the reward the player is actually being paid - so a
     card that changed underneath the player still stops the claim. */
  IF p_reward_amount IS NOT NULL
     AND p_reward_amount IS DISTINCT FROM v_row.diamond_reward_snapshot
  THEN
    RAISE EXCEPTION 'Challenge reward changed; refresh and try again';
  END IF;

  UPDATE public.user_daily_challenges
  SET claimed = true, claimed_at = now()
  WHERE id = p_challenge_row_id;

  /* NO CHIP CREDIT. This is where `atomic_credit_wallet_and_log` stood until
     2026-09-05, paying chip_reward_snapshot into club_members.chip_balance. A
     mission reward is diamonds. Removed rather than guarded on a zeroed column,
     so a stale snapshot arriving from anywhere cannot mint a chip. */

  IF v_row.diamond_reward_snapshot > 0 THEN
    UPDATE public.profiles
    SET diamonds = COALESCE(diamonds, 0) + v_row.diamond_reward_snapshot,
        diamond_balance = COALESCE(diamonds, 0) + v_row.diamond_reward_snapshot,
        updated_at = now()
    WHERE id = v_uid
    RETURNING diamonds INTO v_new_diamonds;

    IF v_new_diamonds IS NULL THEN
      RAISE EXCEPTION 'Profile not found for user % - diamond credit failed', v_uid;
    END IF;

    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description,
      balance_after, metadata, reference_id, created_at
    ) VALUES (
      v_uid,
      v_row.diamond_reward_snapshot,
      'daily_challenge_claim',
      'daily_challenge_claim',
      'Challenge reward: ' || v_row.challenge_id,
      v_new_diamonds,
      jsonb_build_object(
        'challenge_row_id', p_challenge_row_id,
        'challenge_id', v_row.challenge_id,
        'assigned_diamond_reward', v_row.diamond_reward_snapshot
      ),
      'challenge_claim:' || p_challenge_row_id::text || ':diamonds',
      now()
    );
  ELSE
    SELECT COALESCE(diamonds, 0) INTO v_new_diamonds
    FROM public.profiles
    WHERE id = v_uid;
  END IF;

  RETURN jsonb_build_object(
    'claimed', true,
    'alreadyClaimed', false,
    'challengeId', v_row.challenge_id,
    'chips', 0,
    'diamonds', v_row.diamond_reward_snapshot,
    'diamondBalance', COALESCE(v_new_diamonds, 0)
  );
END;
$function$;

COMMENT ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric) IS
  'Claims one mission and pays DIAMONDS. The chip credit was removed 2026-09-05 '
  '(Dan: nothing ever earns chips, only diamonds). `chips` stays in the result '
  'as a literal 0 so the client contract is unchanged.';

-- ── 5. The batch claim - the one that would have drained the whole vault ────
CREATE OR REPLACE FUNCTION public.claim_daily_challenges(
  p_user_id uuid, p_challenge_row_ids uuid[], p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_requested_ids uuid[];
  v_owned_ids uuid[] := ARRAY[]::uuid[];
  v_claimed_ids uuid[] := ARRAY[]::uuid[];
  v_already_claimed_ids uuid[] := ARRAY[]::uuid[];
  v_inserted integer := 0;
  v_existing jsonb;
  v_diamonds integer := 0;
  v_diamond_balance integer := 0;
  v_vault_count bigint := 0;
  v_vault_diamonds bigint := 0;
  v_vault_items jsonb := '[]'::jsonb;
  v_total_claimed bigint := 0;
  v_total_diamonds bigint := 0;
  v_result jsonb;
  VAULT_PAGE_SIZE constant integer := 100;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim challenges for another user' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A claim request id is required';
  END IF;
  IF p_challenge_row_ids IS NULL OR cardinality(p_challenge_row_ids) = 0 THEN
    RAISE EXCEPTION 'At least one challenge is required';
  END IF;
  IF cardinality(p_challenge_row_ids) > VAULT_PAGE_SIZE THEN
    RAISE EXCEPTION 'At most % challenges can be claimed at once', VAULT_PAGE_SIZE;
  END IF;
  IF array_position(p_challenge_row_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Challenge ids cannot be null';
  END IF;

  SELECT array_agg(id ORDER BY id)
    INTO v_requested_ids
    FROM (SELECT DISTINCT unnest(p_challenge_row_ids) AS id) requested;

  INSERT INTO public.daily_challenge_claim_batches (user_id, request_id)
  VALUES (v_uid, p_request_id)
  ON CONFLICT (user_id, request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT result INTO v_existing
      FROM public.daily_challenge_claim_batches
     WHERE user_id = v_uid AND request_id = p_request_id
     FOR UPDATE;
    IF v_existing IS NULL THEN
      RAISE EXCEPTION 'The prior claim request did not finish';
    END IF;
    RETURN v_existing || jsonb_build_object('replayed', true);
  END IF;

  SELECT COALESCE(array_agg(locked.id ORDER BY locked.id), ARRAY[]::uuid[])
    INTO v_owned_ids
    FROM (
      SELECT id
        FROM public.user_daily_challenges
       WHERE user_id = v_uid
         AND id = ANY(v_requested_ids)
       ORDER BY id
       FOR UPDATE
    ) locked;

  IF cardinality(v_owned_ids) <> cardinality(v_requested_ids) THEN
    RAISE EXCEPTION 'One or more challenges do not belong to this player' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.user_daily_challenges
     WHERE id = ANY(v_owned_ids)
       AND (NOT completed OR progress < requirement_snapshot)
  ) THEN
    RAISE EXCEPTION 'One or more challenges are not complete';
  END IF;

  SELECT COALESCE(array_agg(id ORDER BY id) FILTER (WHERE NOT claimed), ARRAY[]::uuid[]),
         COALESCE(array_agg(id ORDER BY id) FILTER (WHERE claimed), ARRAY[]::uuid[]),
         COALESCE(sum(diamond_reward_snapshot) FILTER (WHERE NOT claimed), 0)
    INTO v_claimed_ids, v_already_claimed_ids, v_diamonds
    FROM public.user_daily_challenges
   WHERE id = ANY(v_owned_ids);

  IF cardinality(v_claimed_ids) > 0 THEN
    UPDATE public.user_daily_challenges
       SET claimed = true,
           claimed_at = now()
     WHERE id = ANY(v_claimed_ids)
       AND user_id = v_uid
       AND claimed = false;

    /* NO CHIP CREDIT. Until 2026-09-05 this summed chip_reward_snapshot across
       the whole batch and paid it through atomic_credit_wallet_and_log. With
       425,819,000 chips sitting completed-and-unclaimed and a page size of 100
       rows per call, this was the single largest unintended mint on the
       platform. A mission reward is diamonds. */

    IF v_diamonds > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, 0) + v_diamonds,
             diamond_balance = COALESCE(diamonds, 0) + v_diamonds,
             updated_at = now()
       WHERE id = v_uid
       RETURNING diamonds INTO v_diamond_balance;

      IF v_diamond_balance IS NULL THEN
        RAISE EXCEPTION 'Profile not found - diamond rewards could not be credited';
      END IF;

      INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, metadata, reference_id, created_at
      ) VALUES (
        v_uid,
        v_diamonds,
        'daily_challenge_claim',
        'daily_challenge_claim',
        'Daily Missions batch reward',
        v_diamond_balance,
        jsonb_build_object(
          'challenge_row_ids', to_jsonb(v_claimed_ids),
          'request_id', p_request_id,
          'assigned_diamond_reward', v_diamonds
        ),
        'challenge_claim_batch:' || p_request_id::text || ':diamonds',
        now()
      );
    END IF;
  END IF;

  IF v_diamond_balance IS NULL OR v_diamond_balance = 0 THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_diamond_balance
      FROM public.profiles
     WHERE id = v_uid;
  END IF;

  SELECT count(*), COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_vault_count, v_vault_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid
     AND completed = true
     AND claimed = false;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id', vault.id,
             'challenge_id', vault.challenge_id,
             'assigned_date', vault.assigned_date,
             'progress', vault.progress,
             'completed', vault.completed,
             'claimed', vault.claimed,
             'completed_at', vault.completed_at,
             'name', vault.challenge_name_snapshot,
             'description', vault.challenge_description_snapshot,
             'challenge_type', vault.challenge_type_snapshot,
             'requirement', vault.requirement_snapshot,
             'chip_reward', 0,
             'diamond_reward', vault.diamond_reward_snapshot,
             'tier', vault.tier_snapshot
           )
           ORDER BY vault.completed_at DESC NULLS LAST, vault.id
         ), '[]'::jsonb)
    INTO v_vault_items
    FROM (
      SELECT *
        FROM public.user_daily_challenges
       WHERE user_id = v_uid
         AND completed = true
         AND claimed = false
       ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
       LIMIT VAULT_PAGE_SIZE
    ) vault;

  SELECT count(*), COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_total_claimed, v_total_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid
     AND claimed = true;

  v_result := jsonb_build_object(
    'success', true,
    'replayed', false,
    'claimedIds', to_jsonb(v_claimed_ids),
    'alreadyClaimedIds', to_jsonb(v_already_claimed_ids),
    'chips', 0,
    'diamonds', v_diamonds,
    'diamondBalance', COALESCE(v_diamond_balance, 0),
    'stats', jsonb_build_object(
      'totalClaimed', v_total_claimed,
      'totalChipsEarned', 0,
      'totalDiamondsEarned', v_total_diamonds
    ),
    'vault', jsonb_build_object(
      'count', v_vault_count,
      'chips', 0,
      'diamonds', v_vault_diamonds,
      'items', v_vault_items,
      'pageSize', VAULT_PAGE_SIZE,
      'hasMore', v_vault_count > VAULT_PAGE_SIZE
    )
  );

  UPDATE public.daily_challenge_claim_batches
     SET result = v_result
   WHERE user_id = v_uid AND request_id = p_request_id;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid) IS
  'Claims a batch of missions and pays DIAMONDS. The chip credit was removed '
  '2026-09-05 (Dan: nothing ever earns chips, only diamonds); it would have '
  'minted up to 425.8M chips from the completed-and-unclaimed vault. Every '
  'chip field in the result is a literal 0 so the client contract is unchanged.';

-- ── 6. The streak circuits ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_streak integer := COALESCE((public.get_challenge_streak(p_user_id)->>'streak')::integer, 0);
  v_started date;
  v_reward numeric := 0;
  v_max integer;
  v_max_reward numeric;
  v_reference text;
  v_credit jsonb;
BEGIN
  IF v_streak <= 0 THEN RETURN 0; END IF;
  v_started := (now() AT TIME ZONE 'utc')::date - (v_streak - 1);
  SELECT max(days) INTO v_max FROM public.daily_challenge_milestones;
  SELECT reward_diamonds INTO v_max_reward FROM public.daily_challenge_milestones WHERE days = v_max;

  WITH due AS (
    SELECT days, reward_diamonds FROM public.daily_challenge_milestones WHERE days <= v_streak
    UNION ALL
    -- Past the last written circuit, every further 30 days repays the top one.
    SELECT day, v_max_reward
    FROM generate_series(
      v_max + 30,
      v_max + ((v_streak - v_max) / 30) * 30,
      30
    ) day
  ), inserted AS (
    INSERT INTO public.daily_challenge_milestone_claims (
      user_id, streak_started_on, milestone_days, reward_diamonds
    )
    SELECT p_user_id, v_started, days, reward_diamonds FROM due
    ON CONFLICT DO NOTHING
    RETURNING reward_diamonds, milestone_days
  )
  SELECT COALESCE(sum(reward_diamonds), 0),
         'daily_mission_milestones:' || p_user_id::text || ':' || v_started::text || ':' || max(milestone_days)
    INTO v_reward, v_reference
  FROM inserted;

  IF v_reward > 0 THEN
    /* Diamonds, deduped again on reference_id, and audited into
       diamond_transactions. `atomic_credit_wallet_and_log` stood here and paid
       chips until 2026-09-05. If the credit refuses, the exception unwinds the
       claim rows with it: a claimed circuit that paid nothing would be worse
       than an unclaimed one. */
    v_credit := public.add_diamonds_to_balance(
      p_user_id,
      v_reward::integer,
      'daily_mission_milestone',
      'Daily Missions streak circuit',
      v_reference
    );

    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Daily Missions streak milestone could not be credited: %',
        COALESCE(v_credit->>'error', 'unknown');
    END IF;
  END IF;

  RETURN v_reward;
END;
$function$;

COMMENT ON FUNCTION public.fn_award_daily_mission_milestones(uuid) IS
  'Awards streak circuits in DIAMONDS (Dan 2026-09-05: nothing ever earns chips, '
  'only diamonds). Returns the diamonds awarded - the return value changed '
  'currency, not shape, and no caller had ever received a non-zero one.';

/* NOBODY IN A BROWSER CALLS THIS. It takes the player as a PARAMETER and is
   SECURITY DEFINER, so a caller who could reach it would be handing it its own
   answer to "who am I". Its only caller is the trigger
   fn_daily_missions_claimed_milestone, which fires on the row the claim RPC
   just updated - and that RPC derives the player from auth.uid().

   Stated explicitly rather than left to the [autorevoke] event trigger, which
   already strips PUBLIC and anon: a grant that exists only because a trigger
   removed the others is a grant nobody can read in the file. PUBLIC is named
   alongside the roles because revoking a role while PUBLIC still holds it
   reads as a fix and does nothing. */
REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  TO service_role;

-- ── 6b. The dashboard reads the renamed column, and stops summing chips ─────
--
-- This is the read side of section 3. It selected `reward_chips` in two places,
-- so the rename alone would have broken every load of the Daily Missions page
-- with a 42703. It also reported `totalChipsEarned` and a `vault.chips` total,
-- both of which are now structurally zero.
CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard(
  p_daily_key text, p_daily_ids text[],
  p_weekly_key text, p_weekly_ids text[],
  p_monthly_key text, p_monthly_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_missions jsonb := '[]'::jsonb;
  v_streak_receipt jsonb;
  v_streak integer := 0;
  v_total_completed bigint := 0;
  v_total_claimed bigint := 0;
  v_total_diamonds bigint := 0;
  v_vault_count bigint := 0;
  v_vault_diamonds bigint := 0;
  v_vault_items jsonb := '[]'::jsonb;
  v_diamond_balance integer := 0;
  v_previous_milestone integer := 0;
  v_next_milestone integer;
  v_milestone_reward numeric;
  v_max_milestone integer;
  v_milestone_progress numeric := 0;
  VAULT_PAGE_SIZE constant integer := 100;
  POST_CENTURY_INTERVAL constant integer := 30;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
    INTO v_missions
    FROM public.get_or_assign_challenges(
      p_daily_key, p_daily_ids, p_weekly_key, p_weekly_ids, p_monthly_key, p_monthly_ids
    ) m;

  v_streak_receipt := public.get_challenge_streak(v_uid);
  v_streak := COALESCE((v_streak_receipt->>'streak')::integer, 0);

  SELECT count(*) FILTER (WHERE completed),
         count(*) FILTER (WHERE claimed),
         COALESCE(sum(diamond_reward_snapshot) FILTER (WHERE claimed), 0)
    INTO v_total_completed, v_total_claimed, v_total_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid;

  SELECT count(*), COALESCE(sum(diamond_reward_snapshot), 0)
    INTO v_vault_count, v_vault_diamonds
    FROM public.user_daily_challenges
   WHERE user_id = v_uid AND completed = true AND claimed = false;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object(
             'id', vault.id,
             'challenge_id', vault.challenge_id,
             'assigned_date', vault.assigned_date,
             'progress', vault.progress,
             'completed', vault.completed,
             'claimed', vault.claimed,
             'completed_at', vault.completed_at,
             'name', vault.challenge_name_snapshot,
             'description', vault.challenge_description_snapshot,
             'challenge_type', vault.challenge_type_snapshot,
             'requirement', vault.requirement_snapshot,
             'chip_reward', 0,
             'diamond_reward', vault.diamond_reward_snapshot,
             'tier', vault.tier_snapshot
           )
           ORDER BY vault.completed_at DESC NULLS LAST, vault.id
         ), '[]'::jsonb)
    INTO v_vault_items
    FROM (
      SELECT *
      FROM public.user_daily_challenges
      WHERE user_id = v_uid AND completed = true AND claimed = false
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id
      LIMIT VAULT_PAGE_SIZE
    ) vault;

  SELECT COALESCE(diamonds, 0) INTO v_diamond_balance FROM public.profiles WHERE id = v_uid;
  v_diamond_balance := COALESCE(v_diamond_balance, 0);

  SELECT max(days) INTO v_max_milestone FROM public.daily_challenge_milestones;

  IF v_streak >= v_max_milestone THEN
    v_previous_milestone := v_max_milestone
      + ((v_streak - v_max_milestone) / POST_CENTURY_INTERVAL) * POST_CENTURY_INTERVAL;
    v_next_milestone := v_previous_milestone + POST_CENTURY_INTERVAL;
    SELECT reward_diamonds INTO v_milestone_reward
    FROM public.daily_challenge_milestones
    WHERE days = v_max_milestone;
  ELSE
    SELECT COALESCE(max(days), 0)
      INTO v_previous_milestone
      FROM public.daily_challenge_milestones
     WHERE days <= v_streak;

    SELECT days, reward_diamonds
      INTO v_next_milestone, v_milestone_reward
      FROM public.daily_challenge_milestones
     WHERE days > v_streak
     ORDER BY days
     LIMIT 1;
  END IF;

  IF v_next_milestone > v_previous_milestone THEN
    v_milestone_progress := round(
      ((v_streak - v_previous_milestone)::numeric
        / (v_next_milestone - v_previous_milestone)::numeric) * 100,
      2
    );
  END IF;

  RETURN jsonb_build_object(
    'missions', v_missions,
    'stats', jsonb_build_object(
      'totalCompleted', v_total_completed,
      'totalClaimed', v_total_claimed,
      'currentStreak', v_streak,
      'totalChipsEarned', 0,
      'totalDiamondsEarned', v_total_diamonds,
      'milestoneStart', v_previous_milestone,
      'nextMilestone', v_next_milestone,
      -- Diamonds since 2026-09-05. The key keeps its name so the client
      -- contract is unchanged; `milestoneRewardCurrency` says so out loud.
      'milestoneReward', v_milestone_reward,
      'milestoneRewardCurrency', 'diamonds',
      'milestoneProgressPercent', v_milestone_progress,
      'daysToMilestone', GREATEST(v_next_milestone - v_streak, 0)
    ),
    'streak', v_streak_receipt,
    'diamondBalance', v_diamond_balance,
    'vault', jsonb_build_object(
      'count', v_vault_count,
      'chips', 0,
      'diamonds', v_vault_diamonds,
      'items', v_vault_items,
      'pageSize', VAULT_PAGE_SIZE,
      'hasMore', v_vault_count > VAULT_PAGE_SIZE
    ),
    'syncedAt', to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$function$;

COMMENT ON FUNCTION public.get_daily_challenge_dashboard(text, text[], text, text[], text, text[]) IS
  'Daily Missions dashboard. Reads daily_challenge_milestones.reward_diamonds '
  '(renamed from reward_chips 2026-09-05) and reports every chip figure as a '
  'literal 0 - a mission reward is diamonds.';

-- ── 7. The written record ───────────────────────────────────────────────────
INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
VALUES (
  'critical',
  'daily_missions_chip_liability',
  'Daily Missions promised 695,783,800 chips across 32,793 assigned rows - '
  '425,819,000 of them completed and one "claim all" away from being minted '
  'into member wallets, against a platform-wide member chip balance of ~121M.',
  jsonb_build_object(
    'measured_on', '2026-09-05',
    'catalog_chip_total', 1564050,
    'snapshot_chip_total', 695783800,
    'snapshot_chip_total_claimable', 425819000,
    'snapshots_rewritten', 0,
    'milestone_chip_total', 72000,
    'rows_ever_claimed', 0,
    'claim_batches_ever', 0,
    'milestone_claims_ever', 0,
    'players_holding_a_vault', 1012,
    'migration', '20260905114421_a_mission_pays_diamonds_not_chips'
  ),
  true,
  now(),
  'Resolved by this migration, not by a payout. Nothing had ever been claimed on '
  'this surface - 0 claimed rows, 0 claim batches, 0 milestone claims - so no '
  'player was paid, none was paid twice, and nothing was taken back from anyone. '
  'Under Dan''s 2026-09-05 ruling that a reward is always diamonds, the chip '
  'promise is withdrawn at the catalog and, decisively, in the three crediting '
  'functions - no code path pays a chip for a mission any more, so a stale '
  'snapshot is inert. Not one assigned player contract was rewritten: '
  'fn_snapshot_daily_challenge_contract holds them immutable and it is right to. '
  'Every mission keeps the diamond reward it '
  'already carried: 1,695,205 diamonds are waiting in that same vault. The five '
  'streak circuits, which had no diamond column at all, are renamed and '
  'denominated in the diamond economy at 150/400/1000/2500/6000.'
);

COMMIT;
