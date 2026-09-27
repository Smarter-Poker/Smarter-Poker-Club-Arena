-- REMOVE FIVE EXACT PRE-ARCHIVE CERTIFICATION PUBLIC-USER SHADOWS.
--
-- A complete reserved-identity readback after the archived September 6
-- correction found five older public.users-only shadows from the August 31
-- customization certificate. All five lost Auth and profile state before
-- audit/ledger actor archiving existed. They have no authority, custody,
-- gameplay, journal, archive, or asset surface.
--
-- Do not widen cleanup_reserved_certification_account: it correctly refuses
-- an Auth-less public.users row because it cannot verify a live certification
-- marker. This one-time correction is pinned to all bytes that still exist,
-- refuses a platform freeze or any newly appeared protected surface, removes
-- and deletes exactly five exact public.users rows. The separate September 6
-- identity is intentionally excluded because it has protected diamond audit
-- and archive testimony.
-- @live-proof: (SELECT NOT public.fn_platform_frozen() AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = ANY (ARRAY['27d04334-7317-4594-a132-24e7a9b40422','51511e89-f48f-49be-b89a-f5f47ce681db','60c13392-aebb-486e-86fb-9db3d2424a8a','7642a424-6111-45ca-898a-1e20180930d2','8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a']::uuid[])))

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';

DO $cleanup$
DECLARE
  v_row record;
  v_surface record;
  v_surface_exists boolean;
  v_target_ids uuid[] := ARRAY[
    '27d04334-7317-4594-a132-24e7a9b40422'::uuid,
    '51511e89-f48f-49be-b89a-f5f47ce681db'::uuid,
    '60c13392-aebb-486e-86fb-9db3d2424a8a'::uuid,
    '7642a424-6111-45ca-898a-1e20180930d2'::uuid,
    '8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a'::uuid
  ];
  v_validated integer := 0;
  v_deleted integer := 0;
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
         'Certbundc8a9706'::text,
         NULL::text,
         '2026-08-31T08:08:53.875389Z'::timestamptz,
         '2026-08-31T08:08:53.875389Z'::timestamptz),
        ('51511e89-f48f-49be-b89a-f5f47ce681db'::uuid,
         'ca-customization-cert-buyer-1788163730335-e62b39f0-87a2-4df0-aec5-9b5fee205363@example.invalid'::text,
         'Certbuyeee20536'::text,
         NULL::text,
         '2026-08-31T08:08:50.679143Z'::timestamptz,
         '2026-08-31T08:08:50.679143Z'::timestamptz),
        ('60c13392-aebb-486e-86fb-9db3d2424a8a'::uuid,
         'ca-customization-cert-bundle-1788179589362-144cd324-9904-4be7-b838-821f02616dcc@example.invalid'::text,
         'Certbund02616dc'::text,
         NULL::text,
         '2026-08-31T12:33:09.542752Z'::timestamptz,
         '2026-08-31T12:33:09.542752Z'::timestamptz),
        ('7642a424-6111-45ca-898a-1e20180930d2'::uuid,
         'ca-customization-cert-observer-1788163735780-4a1660cc-66f7-4116-a875-19adb406c26f@example.invalid'::text,
         'Certobseb406c26'::text,
         NULL::text,
         '2026-08-31T08:08:56.032708Z'::timestamptz,
         '2026-08-31T08:08:56.032708Z'::timestamptz),
        ('8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a'::uuid,
         'ca-customization-cert-observer-1788182591387-e54338f8-4f35-49d1-829d-a776a331a933@example.invalid'::text,
         'Certobsea331a93'::text,
         NULL::text,
         '2026-08-31T13:23:11.819467Z'::timestamptz,
         '2026-08-31T13:23:11.819467Z'::timestamptz)
      ) AS expected(id, email, username, avatar_url, created_at, updated_at)
     ORDER BY id
  LOOP
    PERFORM 1
      FROM public.users u
     WHERE u.id = v_row.id
       AND u.email = v_row.email
       AND u.username = v_row.username
       AND u.avatar_url IS NOT DISTINCT FROM v_row.avatar_url
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

    IF EXISTS (SELECT 1 FROM public.signup_errors e WHERE e.user_id = v_row.id) THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: %', v_row.id
        USING ERRCODE = '55000';
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
       OR EXISTS (SELECT 1 FROM public.table_waitlist WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.rate_limits WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.client_shell_telemetry WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.vip_points WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.vip_points_carry WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.vip_points_ledger WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.session_history WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.player_position_stats WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_feedback WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.throw_usage WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.special_bonuses WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.user_daily_rewards WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.promotion_claims WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.referral_codes WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.referral_redemptions
                   WHERE referrer_id = v_row.id OR referee_id = v_row.id)
       OR EXISTS (SELECT 1 FROM public.referral_milestone_claims WHERE user_id = v_row.id)
       OR EXISTS (SELECT 1 FROM storage.objects o
                   WHERE o.bucket_id = 'club-assets'
                     AND o.name LIKE 'club-logos/' || v_row.id::text || '%') THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: %', v_row.id
        USING ERRCODE = '55000';
    END IF;

    v_validated := v_validated + 1;
  END LOOP;

  IF v_validated <> 5 THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_VALIDATION_COUNT: %', v_validated
      USING ERRCODE = '55000';
  END IF;

  -- user_bonuses was retired on September 7. If a legacy copy exists when
  -- this migration is installed, it is still a protected user surface.
  IF to_regclass('public.user_bonuses') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.user_bonuses WHERE user_id = ANY ($1))'
       INTO v_surface_exists
      USING v_target_ids;
    IF v_surface_exists THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: user_bonuses'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- The older feature tables did not consistently declare user foreign
  -- keys. Enumerate every extant public UUID user-bearing column without a
  -- direct FK and refuse any matching row. Explicit guards above document
  -- the known legacy surfaces; this catalog guard closes future omissions.
  FOR v_surface IN
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.oid
       AND a.attnum > 0
       AND NOT a.attisdropped
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND a.atttypid = 'uuid'::regtype
       AND (
         a.attname = 'user_id'
         OR a.attname LIKE '%\_user\_id' ESCAPE '\'
         OR a.attname LIKE '%\_by' ESCAPE '\'
         OR a.attname IN (
           'player_id', 'player_a', 'player_b', 'actor', 'actor_id', 'owner_id',
           'recipient_id', 'sender_id', 'from_user_id', 'to_user_id', 'performed_by',
           'referrer_id', 'referee_id', 'challenger_id', 'challengee_id',
           'winner_id', 'loser_id', 'author_id', 'viewer_id', 'requester_id',
           'approver_id', 'caller_id', 'callee_id', 'caller_uid', 'jwt_sub'
         )
       )
       AND c.relname <> 'signup_errors'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_constraint fk
          WHERE fk.contype = 'f'
            AND fk.conrelid = c.oid
            AND a.attnum = ANY (fk.conkey)
       )
     ORDER BY c.relname, a.attname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I = ANY ($1))',
      v_surface.table_name,
      v_surface.column_name
    ) INTO v_surface_exists USING v_target_ids;
    IF v_surface_exists THEN
      RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_IS_NOT_EMPTY: %.%',
        v_surface.table_name, v_surface.column_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Every target and every protected surface has passed before the first
  -- mutation. Remove only the five locked public.users preimages.
  DELETE FROM public.users u
   USING (VALUES
     ('27d04334-7317-4594-a132-24e7a9b40422'::uuid,
      'ca-customization-cert-bundle-1788163733536-b39cfc17-4931-4197-b7d8-42ccc8a9706d@example.invalid'::text,
      'Certbundc8a9706'::text, NULL::text,
      '2026-08-31T08:08:53.875389Z'::timestamptz,
      '2026-08-31T08:08:53.875389Z'::timestamptz),
     ('51511e89-f48f-49be-b89a-f5f47ce681db'::uuid,
      'ca-customization-cert-buyer-1788163730335-e62b39f0-87a2-4df0-aec5-9b5fee205363@example.invalid'::text,
      'Certbuyeee20536'::text, NULL::text,
      '2026-08-31T08:08:50.679143Z'::timestamptz,
      '2026-08-31T08:08:50.679143Z'::timestamptz),
     ('60c13392-aebb-486e-86fb-9db3d2424a8a'::uuid,
      'ca-customization-cert-bundle-1788179589362-144cd324-9904-4be7-b838-821f02616dcc@example.invalid'::text,
      'Certbund02616dc'::text, NULL::text,
      '2026-08-31T12:33:09.542752Z'::timestamptz,
      '2026-08-31T12:33:09.542752Z'::timestamptz),
     ('7642a424-6111-45ca-898a-1e20180930d2'::uuid,
      'ca-customization-cert-observer-1788163735780-4a1660cc-66f7-4116-a875-19adb406c26f@example.invalid'::text,
      'Certobseb406c26'::text, NULL::text,
      '2026-08-31T08:08:56.032708Z'::timestamptz,
      '2026-08-31T08:08:56.032708Z'::timestamptz),
     ('8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a'::uuid,
      'ca-customization-cert-observer-1788182591387-e54338f8-4f35-49d1-829d-a776a331a933@example.invalid'::text,
      'Certobsea331a93'::text, NULL::text,
      '2026-08-31T13:23:11.819467Z'::timestamptz,
      '2026-08-31T13:23:11.819467Z'::timestamptz)
   ) AS expected(id, email, username, avatar_url, created_at, updated_at)
   WHERE u.id = expected.id
     AND u.email = expected.email
     AND u.username = expected.username
     AND u.avatar_url IS NOT DISTINCT FROM expected.avatar_url
     AND u.created_at = expected.created_at
     AND u.updated_at = expected.updated_at;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted <> 5 OR EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = ANY (ARRAY[
       '27d04334-7317-4594-a132-24e7a9b40422',
       '51511e89-f48f-49be-b89a-f5f47ce681db',
       '60c13392-aebb-486e-86fb-9db3d2424a8a',
       '7642a424-6111-45ca-898a-1e20180930d2',
       '8ee8638a-b2ce-4fd2-9d9e-1fb28c6e533a'
     ]::uuid[])
  ) THEN
    RAISE EXCEPTION 'PREARCHIVE_CERTIFICATION_PUBLIC_USER_RESIDUE_DELETE_COUNT: %', v_deleted
      USING ERRCODE = '55000';
  END IF;
END
$cleanup$;

COMMIT;
