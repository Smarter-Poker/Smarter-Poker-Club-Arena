-- REMOVE SIX EXACT PRE-ARCHIVE CERTIFICATION PUBLIC-USER SHADOWS.
--
-- A complete reserved-identity readback after the archived September 6
-- correction found six older public.users-only shadows. Five came from the
-- August 31 customization certificate and one came from an earlier September
-- 6 post-deploy signup that failed while the platform was frozen. All six lost
-- Auth and profile state before audit/ledger actor archiving existed. They
-- have no authority, custody, gameplay, journal, archive, or asset surface;
-- the September 6 row retains only the byte-identified signup diagnostic that
-- explains its partial creation.
--
-- Do not widen cleanup_reserved_certification_account: it correctly refuses
-- an Auth-less public.users row because it cannot verify a live certification
-- marker. This one-time correction is pinned to all bytes that still exist,
-- refuses a platform freeze or any newly appeared protected surface, removes
-- one exact diagnostic, and deletes exactly six exact public.users rows.
-- @live-proof: (SELECT NOT public.fn_platform_frozen() AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = ANY (ARRAY['27d04334-7317-4594-a132-24e7a9b40422','51511e89-f48f-49be-b89a-f5f47ce681db','60c13392-aebb-486e-86fb-9db3d2424a8a','7642a424-6111-45ca-898a-1e20180930d2','8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a','a28421ff-9f27-4a99-81dd-2e18884d616c']::uuid[])) AND NOT EXISTS (SELECT 1 FROM public.signup_errors e WHERE e.id = 9105 AND e.user_id = 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid))

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '30s';

DO $cleanup$
DECLARE
  v_row record;
  v_deleted integer := 0;
  v_signup_deleted integer := 0;
BEGIN
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_REFUSES_PLATFORM_FREEZE'
      USING ERRCODE = '55000';
  END IF;

  FOR v_row IN
    SELECT *
      FROM (VALUES
        ('27d04334-7317-4594-a132-24e7a9b40422'::uuid,
         'ca-customization-cert-bundle-1788163733536-b39cfc17-4931-4197-b7d8-42ccc8a9706d@example.invalid'::text,
         '2026-08-31T08:08:53.875389Z'::timestamptz,
         '2026-08-31T08:08:53.875389Z'::timestamptz),
        ('51511e89-f48f-49be-b89a-f5f47ce681db'::uuid,
         'ca-customization-cert-buyer-1788163730335-e62b39f0-87a2-4df0-aec5-9b5fee205363@example.invalid'::text,
         '2026-08-31T08:08:50.679143Z'::timestamptz,
         '2026-08-31T08:08:50.679143Z'::timestamptz),
        ('60c13392-aebb-486e-86fb-9db3d2424a8a'::uuid,
         'ca-customization-cert-bundle-1788179589362-144cd324-9904-4be7-b838-821f02616dcc@example.invalid'::text,
         '2026-08-31T12:33:09.542752Z'::timestamptz,
         '2026-08-31T12:33:09.542752Z'::timestamptz),
        ('7642a424-6111-45ca-898a-1e20180930d2'::uuid,
         'ca-customization-cert-observer-1788163735780-4a1660cc-66f7-4116-a875-19adb406c26f@example.invalid'::text,
         '2026-08-31T08:08:56.032708Z'::timestamptz,
         '2026-08-31T08:08:56.032708Z'::timestamptz),
        ('8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a'::uuid,
         'ca-customization-cert-observer-1788182591387-e54338f8-4f35-49d1-829d-a776a331a933@example.invalid'::text,
         '2026-08-31T13:23:11.819467Z'::timestamptz,
         '2026-08-31T13:23:11.819467Z'::timestamptz),
        ('a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid,
         'ca-customization-cert-postdeploy-1788659737460-da18c019-9c82-45d6-9fa1-d5e5a98f2a10@example.invalid'::text,
         '2026-09-06T01:55:37.703383Z'::timestamptz,
         '2026-09-06T01:55:37.703383Z'::timestamptz)
      ) AS expected(id, email, created_at, updated_at)
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
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_ROW_CHANGED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    -- These rows predate the guarded archive door. Archive testimony appearing
    -- now would contradict that classification and must stop this correction.
    IF EXISTS (
      SELECT 1 FROM public.ca_test_account_audit_archive a WHERE a.actor_id = v_row.id
    ) OR EXISTS (
      SELECT 1 FROM public.ca_test_account_ledger_actor_archive l WHERE l.actor_id = v_row.id
    ) THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_ARCHIVE_CHANGED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    -- One shadow retained the exact synthetic freeze diagnostic that caused
    -- the partial signup. Delete no diagnostic unless every observed byte and
    -- timestamp still match.
    IF v_row.id = 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid THEN
      DELETE FROM public.signup_errors e
       WHERE e.id = 9105
         AND e.user_id = v_row.id
         AND e.email = v_row.email
         AND e.trigger_name = 'handle_new_user_v2_create_wallet'
         AND e.error_code = '55006'
         AND e.occurred_at = '2026-09-06T01:55:37.703383Z'::timestamptz
         AND e.raw_meta IS NULL
         AND e.forwarded_to_sentry = '2026-09-06T02:00:37.028Z'::timestamptz
         AND length(e.error_msg) = 132
         AND md5(e.error_msg) = '7d0f88ba3a6d0777977b4dce80dc072a';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_SIGNUP_ERROR_CHANGED: %', v_row.id
          USING ERRCODE = '55000';
      END IF;
      v_signup_deleted := v_signup_deleted + 1;
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_row.id)
       OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id::text = v_row.id::text)
       OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id::text = v_row.id::text)
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
       OR EXISTS (SELECT 1 FROM public.client_shell_telemetry WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM storage.objects o
                   WHERE o.bucket_id = 'club-assets'
                     AND o.name LIKE 'club-logos/' || v_row.id::text || '%') THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    DELETE FROM public.users u
     WHERE u.id = v_row.id
       AND u.email = v_row.email
       AND u.created_at = v_row.created_at
       AND u.updated_at = v_row.updated_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_MISSED: %', v_row.id
        USING ERRCODE = '55000';
    END IF;
    v_deleted := v_deleted + 1;
  END LOOP;

  IF v_signup_deleted <> 1 OR v_deleted <> 6 OR EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = ANY (ARRAY[
       '27d04334-7317-4594-a132-24e7a9b40422',
       '51511e89-f48f-49be-b89a-f5f47ce681db',
       '60c13392-aebb-486e-86fb-9db3d2424a8a',
       '7642a424-6111-45ca-898a-1e20180930d2',
       '8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a',
       'a28421ff-9f27-4a99-81dd-2e18884d616c'
     ]::uuid[])
  ) OR EXISTS (
    SELECT 1 FROM public.signup_errors e
     WHERE e.id = 9105
       AND e.user_id = 'a28421ff-9f27-4a99-81dd-2e18884d616c'::uuid
  ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;
END
$cleanup$;

COMMIT;
