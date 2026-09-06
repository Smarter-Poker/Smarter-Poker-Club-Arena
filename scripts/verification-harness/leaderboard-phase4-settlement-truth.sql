-- Production-Safe Phase 4 Verification.
-- This Harness Is Read-Only And Rolls Back Its Local Authentication Claims.

BEGIN;

DO $verify$
DECLARE
  v_club_id uuid;
  v_actor_id uuid;
  v_period_start date;
  v_status jsonb;
  v_payout_body text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'leaderboard_payouts'
      AND column_name = 'batch_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'Phase 4 Receipt Batch Link Is Missing';
  END IF;

  SELECT prosrc
  INTO v_payout_body
  FROM pg_proc
  WHERE oid = 'public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)'::regprocedure;

  IF v_payout_body IS NULL
     OR v_payout_body ~ 'SET[[:space:]]+chip_balance[[:space:]]*='
     OR v_payout_body ~ 'SET[[:space:]]+chip_treasury[[:space:]]*='
     OR v_payout_body NOT LIKE '%split_occupied_places%'
     OR v_payout_body NOT LIKE '%batch_id%' THEN
    RAISE EXCEPTION 'Phase 4 Payout Contract Is Not Promo-Only And Batch-Linked';
  END IF;

  IF has_function_privilege('anon',
      'public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Browser Role Can Execute Leaderboard Settlement';
  END IF;

  SELECT member.club_id, member.user_id
  INTO v_club_id, v_actor_id
  FROM public.club_members member
  JOIN public.clubs club ON club.id = member.club_id
  ORDER BY member.created_at DESC
  LIMIT 1;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'No Club Member Is Available For The Read-Model Probe';
  END IF;

  SELECT bounds.start_date
  INTO v_period_start
  FROM public.fn_leaderboard_period_window('weekly', 0) bounds;

  PERFORM set_config('request.jwt.claim.sub', v_actor_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  v_status := public.fn_get_leaderboard_settlement_status(
    v_club_id,
    'weekly',
    v_period_start
  );

  IF v_status ->> 'club_id' IS DISTINCT FROM v_club_id::text
     OR v_status ->> 'period' IS DISTINCT FROM 'weekly'
     OR v_status ->> 'state' NOT IN (
       'not_published', 'disabled', 'open', 'pending', 'failed', 'paid'
     )
     OR jsonb_typeof(v_status -> 'receipts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Phase 4 Settlement Read Model Returned An Invalid Contract';
  END IF;
END;
$verify$;

ROLLBACK;
