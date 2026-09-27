-- REMOVE FIVE EXACT ARCHIVED CERTIFICATION PUBLIC-USER SHADOWS.
--
-- Five September 6 certification runs deleted Auth and profile state before
-- an older cleanup failed, leaving only a legacy public.users row. The current
-- cleanup is atomic and cannot recreate that partial outcome. Do not add a
-- generic Auth-less deletion door: pin this correction to the five observed
-- rows and their immutable archive testimony, refuse during a platform freeze,
-- prove every related authority/custody surface is empty, and delete exactly
-- those five byte-identified shadows.
-- @live-proof: (SELECT NOT public.fn_platform_frozen() AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = ANY (ARRAY['01bafbb6-012d-42c5-9dc1-9c643c90537e','3bf778ad-31ff-45f4-bdf9-d267450386bc','afea7b11-593d-43c4-8438-91705b9260dd','c17e8d8b-1e81-4d91-b07c-6dec5a4e4548','db395d65-6180-4a18-8738-83e5d9a776e0']::uuid[])) AND NOT EXISTS (SELECT 1 FROM public.signup_errors e WHERE e.id = 9106 AND e.user_id = '3bf778ad-31ff-45f4-bdf9-d267450386bc'::uuid))

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

DO $cleanup$
DECLARE
  v_row record;
  v_archive_count integer;
  v_deleted integer := 0;
  v_signup_deleted integer := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_RESIDUE_REFUSES_PLATFORM_FREEZE'
      USING ERRCODE = '55000';
  END IF;

  FOR v_row IN
    SELECT *
      FROM (VALUES
        ('01bafbb6-012d-42c5-9dc1-9c643c90537e'::uuid,
         'ca-customization-cert-postdeploy-1788660166579-62047882-7bc6-4855-8135-2567dfc8b9f1@example.invalid'::text,
         '2026-09-06T02:02:46.895123Z'::timestamptz,
         '2026-09-06T02:02:46.895123Z'::timestamptz, 2::integer,
         '2026-09-06T02:03:23.608071Z'::timestamptz),
        ('3bf778ad-31ff-45f4-bdf9-d267450386bc'::uuid,
         'ca-customization-cert-postdeploy-1788659799390-17a3c479-6ffd-4eac-bcb1-5b51110eb793@example.invalid'::text,
         '2026-09-06T01:56:39.598901Z'::timestamptz,
         '2026-09-06T01:56:39.598901Z'::timestamptz, 1::integer,
         '2026-09-06T02:00:54.088473Z'::timestamptz),
        ('afea7b11-593d-43c4-8438-91705b9260dd'::uuid,
         'ca-customization-cert-postdeploy-1788660102802-cc83541d-8d8b-43ff-ae46-7e10714c4f9c@example.invalid'::text,
         '2026-09-06T02:01:43.142718Z'::timestamptz,
         '2026-09-06T02:01:43.142718Z'::timestamptz, 2::integer,
         '2026-09-06T02:02:25.978396Z'::timestamptz),
        ('c17e8d8b-1e81-4d91-b07c-6dec5a4e4548'::uuid,
         'ca-customization-cert-postdeploy-1788658890604-411343a9-9a9a-4b6b-9302-0b30e9dbea69@example.invalid'::text,
         '2026-09-06T01:41:30.940389Z'::timestamptz,
         '2026-09-06T01:41:30.940389Z'::timestamptz, 1::integer,
         '2026-09-06T02:11:39.114148Z'::timestamptz),
        ('db395d65-6180-4a18-8738-83e5d9a776e0'::uuid,
         'ca-customization-cert-postdeploy-1788660016354-cc198488-d7f1-4d63-bc3a-a3df85c4ff39@example.invalid'::text,
         '2026-09-06T02:00:16.596684Z'::timestamptz,
         '2026-09-06T02:00:16.596684Z'::timestamptz, 2::integer,
         '2026-09-06T02:01:19.035681Z'::timestamptz)
      ) AS expected(id, email, created_at, updated_at, archive_count, archived_at)
     ORDER BY id
  LOOP
    PERFORM 1
      FROM public.users u
     WHERE u.id = v_row.id
       AND u.email = v_row.email
       AND u.created_at = v_row.created_at
       AND u.updated_at = v_row.updated_at
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_RESIDUE_ROW_CHANGED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    SELECT count(*) INTO v_archive_count
      FROM public.ca_test_account_audit_archive a
     WHERE a.actor_id = v_row.id
       AND a.actor_email = v_row.email
       AND a.archive_reason = 'guarded_test_account_deletion'
       AND a.archived_at = v_row.archived_at
       AND a.audit_row ->> 'actor_id' = v_row.id::text;
    IF v_archive_count <> v_row.archive_count
       OR EXISTS (
         SELECT 1 FROM public.ca_test_account_audit_archive a
          WHERE a.actor_id = v_row.id
            AND (a.actor_email IS DISTINCT FROM v_row.email
              OR a.archive_reason IS DISTINCT FROM 'guarded_test_account_deletion'
              OR a.archived_at IS DISTINCT FROM v_row.archived_at
              OR a.audit_row ->> 'actor_id' IS DISTINCT FROM v_row.id::text
              OR a.audit_row ->> 'id' IS DISTINCT FROM a.audit_id::text)
       ) THEN
      RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_ARCHIVE_CHANGED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    -- One identity retained the exact synthetic signup failure that caused its
    -- partial state. Delete only that byte-pinned diagnostic; every other
    -- signup error remains a refusal below.
    IF v_row.id = '3bf778ad-31ff-45f4-bdf9-d267450386bc'::uuid THEN
      DELETE FROM public.signup_errors e
       WHERE e.id = 9106
         AND e.user_id = v_row.id
         AND e.email = v_row.email
         AND e.trigger_name = 'handle_new_user_v2_create_wallet'
         AND e.error_code = '55006'
         AND e.occurred_at = '2026-09-06T01:56:39.598901Z'::timestamptz
         AND e.raw_meta IS NULL
         AND e.forwarded_to_sentry = '2026-09-06T02:00:38.84Z'::timestamptz
         AND length(e.error_msg) = 132
         AND md5(e.error_msg) = '7d0f88ba3a6d0777977b4dce80dc072a';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CERTIFICATION_SIGNUP_ERROR_RESIDUE_CHANGED: %', v_row.id
          USING ERRCODE = '55000';
      END IF;
      v_signup_deleted := v_signup_deleted + 1;
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.profiles WHERE id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.unions WHERE owner_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.agents WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.tournament_players WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.wallets WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.wallet_transactions WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.wallet_credit_idempotency WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.diamond_wallets WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.diamond_transactions WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.chip_transactions
                   WHERE from_user_id = v_row.id OR to_user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = v_row.id)
       OR EXISTS (SELECT 1 FROM public.audit_trail WHERE actor_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries WHERE recipient_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.accounting_conversations
                   WHERE recipient_id = v_row.id OR sender_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.notifications
                   WHERE user_id = v_row.id OR actor_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.customization_operations WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_theme_settings WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_table_studio_preferences WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.theme_asset_unlocks WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.avatar_unlocks WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.feature_purchases WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_daily_challenges WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.challenge_streak_state WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_mission_operations WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_challenge_event_outbox WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_challenge_progress_events WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_challenge_milestone_claims WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_challenge_claim_batches WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.daily_challenge_dashboard_revisions WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_notification_preferences WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.push_outbox WHERE recipient_user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.signup_errors WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.table_waitlist WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.rate_limits WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM storage.objects o
                   WHERE o.bucket_id = 'club-assets'
                     AND o.name LIKE 'club-logos/' || v_row.id::text || '%') THEN
      RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    DELETE FROM public.users u
     WHERE u.id = v_row.id
       AND u.email = v_row.email
       AND u.created_at = v_row.created_at
       AND u.updated_at = v_row.updated_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_MISSED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;
    v_deleted := v_deleted + 1;
  END LOOP;

  IF v_signup_deleted <> 1 OR v_deleted <> 5 OR EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = ANY (ARRAY[
       '01bafbb6-012d-42c5-9dc1-9c643c90537e',
       '3bf778ad-31ff-45f4-bdf9-d267450386bc',
       'afea7b11-593d-43c4-8438-91705b9260dd',
       'c17e8d8b-1e81-4d91-b07c-6dec5a4e4548',
       'db395d65-6180-4a18-8738-83e5d9a776e0'
     ]::uuid[])
  ) THEN
    RAISE EXCEPTION 'CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;
END
$cleanup$;

COMMIT;
