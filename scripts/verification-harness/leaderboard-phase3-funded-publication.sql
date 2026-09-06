-- Production-safe behavior probe for Leaderboard Phase 3.
-- Run only after 20260906003717 is applied, or in the same outer transaction
-- as that migration with its BEGIN/COMMIT lines removed. Every write rolls back.

BEGIN;

DO $standalone$
DECLARE
  v_club_id uuid;
  v_owner_id uuid;
  v_version integer;
  v_wallet numeric;
  v_before_count integer;
  v_after_count integer;
  v_saved jsonb;
  v_summary jsonb;
  v_rejected boolean := false;
  v_operation uuid := '00000000-0000-4000-8000-000000003001';
BEGIN
  SELECT club.id, club.owner_id, COALESCE(club.promo_balance, 0)
    INTO v_club_id, v_owner_id, v_wallet
    FROM public.clubs club
   WHERE club.owner_id IS NOT NULL
     AND COALESCE(club.is_union, false) = false
     AND club.union_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.union_clubs membership WHERE membership.club_id = club.id
     )
   ORDER BY club.created_at
   LIMIT 1;
  IF v_club_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: No Standalone Club Funding Fixture';
  END IF;

  SELECT COALESCE(max(program.version), 0), count(*)
    INTO v_version, v_before_count
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = v_club_id;
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  BEGIN
    PERFORM public.fn_save_leaderboard_reward_setup(
      v_club_id, true, 'profit',
      jsonb_build_array(jsonb_build_object('rank', 1, 'amount', v_wallet + 1)),
      '[]'::jsonb, 'custom', v_version,
      '00000000-0000-4000-8000-000000003002'::uuid
    );
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: Standalone Club Published Beyond Its Promo Wallet';
  END IF;
  SELECT count(*) INTO v_after_count
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = v_club_id;
  IF v_after_count <> v_before_count THEN
    RAISE EXCEPTION 'FAIL: Rejected Standalone Publication Left A Program Row';
  END IF;

  v_saved := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'profit',
    '[{"rank":1,"amount":1.25}]'::jsonb,
    '[{"rank":1,"amount":2.75}]'::jsonb,
    'custom', v_version, v_operation
  );
  v_summary := public.fn_leaderboard_funding_summary(v_club_id);
  IF (v_saved ->> 'program_version')::integer <> v_version + 1
     OR (v_summary ->> 'current_program_commitment')::numeric <> 4
     OR (v_summary ->> 'committed_balance')::numeric <> 4
     OR v_summary ->> 'funding_status' <> 'funded' THEN
    RAISE EXCEPTION 'FAIL: Standalone Commitment Summary Is Incorrect: %', v_summary;
  END IF;

  v_saved := public.fn_save_leaderboard_reward_setup(
    v_club_id, true, 'profit',
    '[{"rank":1,"amount":1.25}]'::jsonb,
    '[{"rank":1,"amount":2.75}]'::jsonb,
    'custom', v_version, v_operation
  );
  IF (v_saved ->> 'program_version')::integer <> v_version + 1
     OR (SELECT count(*) FROM public.leaderboard_reward_program_versions program
          WHERE program.operation_id = v_operation) <> 1 THEN
    RAISE EXCEPTION 'FAIL: Funded Publication Retry Was Not Exact And Idempotent';
  END IF;

  RAISE NOTICE 'PASS: Standalone Funding Gate, Summary, Rollback, And Retry';
END;
$standalone$;

DO $union$
DECLARE
  v_union_id uuid;
  v_owner_id uuid;
  v_first_club uuid;
  v_second_club uuid;
  v_first_version integer;
  v_second_version integer;
  v_wallet numeric;
  v_first jsonb;
  v_summary jsonb;
  v_rejected boolean := false;
BEGIN
  SELECT candidate.union_id, candidate.owner_id, candidate.promo_wallet,
         candidate.club_ids[1], candidate.club_ids[2]
    INTO v_union_id, v_owner_id, v_wallet, v_first_club, v_second_club
    FROM (
      SELECT union_row.id AS union_id, union_row.owner_id,
             COALESCE(wallet.promo_wallet, 0) AS promo_wallet,
             array_agg(DISTINCT membership.club_id ORDER BY membership.club_id) AS club_ids
        FROM public.unions union_row
        JOIN public.union_clubs membership ON membership.union_id = union_row.id
        JOIN public.union_wallets wallet ON wallet.union_id = union_row.id
       WHERE union_row.owner_id IS NOT NULL
       GROUP BY union_row.id, union_row.owner_id, wallet.promo_wallet
      HAVING count(DISTINCT membership.club_id) >= 2
    ) candidate
   WHERE candidate.promo_wallet > 20
   ORDER BY candidate.union_id
   LIMIT 1;
  IF v_union_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: No Two-Club Union Funding Fixture';
  END IF;

  SELECT COALESCE(max(program.version), 0) INTO v_first_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = v_first_club;
  SELECT COALESCE(max(program.version), 0) INTO v_second_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = v_second_club;
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_first := public.fn_save_leaderboard_reward_setup(
    v_first_club, true, 'profit',
    '[{"rank":1,"amount":10}]'::jsonb,
    '[{"rank":1,"amount":5}]'::jsonb,
    'custom', v_first_version,
    '00000000-0000-4000-8000-000000003003'::uuid
  );
  IF (v_first ->> 'program_version')::integer <> v_first_version + 1 THEN
    RAISE EXCEPTION 'FAIL: First Union Club Was Not Published';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.fn_save_leaderboard_reward_setup(
      v_second_club, true, 'profit',
      jsonb_build_array(jsonb_build_object('rank', 1, 'amount', v_wallet - 5)),
      '[]'::jsonb, 'custom', v_second_version,
      '00000000-0000-4000-8000-000000003004'::uuid
    );
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: Second Union Club Ignored The First Club Commitment';
  END IF;

  v_summary := public.fn_leaderboard_funding_summary(v_second_club);
  IF (v_summary ->> 'other_program_commitments')::numeric < 15
     OR (v_summary ->> 'publication_capacity')::numeric
        <> v_wallet - (v_summary ->> 'other_program_commitments')::numeric THEN
    RAISE EXCEPTION 'FAIL: Union-Wide Replacement Capacity Is Incorrect: %', v_summary;
  END IF;

  RAISE NOTICE 'PASS: Union-Wide Commitments Prevent Cross-Club Oversubscription';
END;
$union$;

ROLLBACK;

SELECT CASE WHEN count(*) = 0 THEN 'PASS: Zero Probe Rows Remain'
            ELSE 'FAIL: Probe Rows Escaped Rollback' END AS rollback_verdict
FROM public.leaderboard_reward_program_versions
WHERE operation_id IN (
  '00000000-0000-4000-8000-000000003001'::uuid,
  '00000000-0000-4000-8000-000000003002'::uuid,
  '00000000-0000-4000-8000-000000003003'::uuid,
  '00000000-0000-4000-8000-000000003004'::uuid
);
