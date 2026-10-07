-- Maintained replacement for the 2026-10-06 patterned identity retirement producer.
-- Preserves the original financial/social boundaries; never force-drains seats or entries.
-- Foreign historical force scripts remain unchanged and must not supply this operation.
-- Conservative limitation: a cash funding receipt transferred by MustMove
-- without a same-original-occupancy cashout is unproven here and refused, even
-- if its successor ultimately paid out. This owner does not qualify that path;
-- do not erase its receipt or bypass this refusal to manufacture a drained claim.
-- =============================================================================
-- bot-id-rotation / rotation.sql                      prepared 2026-10-06 (UTC)
-- Project kuklfnapbkmacvwxktbh. SOURCE ONLY. Existing completed stages must not be replayed. Run as role postgres only.
--
-- THE LAW: a player must never be able to tell a horse from a human.
-- THE TELL: 94 non-system accounts carry hand-made ids
--   00000000-0000-0000-0000-0000000000NN  (52 horses + 32 dormant cert fixtures)
--   face0000-0000-0000-0000-0000000000NN  (10 horses, Midway Union)
-- and those ids ride in every seat, roster, feed, reel, comment, like,
-- friend list, notification and avatar URL.
--
-- WHY THIS FILE DOES NOT ROTATE THE IDS IN PLACE (measured read-only,
-- 2026-10-06; full evidence in the hand-back report):
--   * 769 foreign keys reference auth.users/profiles. All are ON UPDATE
--     NO ACTION and none is DEFERRABLE, so a rotation means either
--     ALTER-ing hundreds of constraints (lock storm on a 543 GB live DB)
--     or session_replication_role=replica, which also switches off every
--     guard trigger listed below.
--   * Volume: > 15.5 million indexed uuid cells hold these ids (e.g.
--     daily_challenge_progress_events 4.09M, ca_hand_player_idx 2.45M,
--     agent_commissions 2.32M, ca_hand_facts 1.80M, ca_hand_transfers 3.39M,
--     vip_points_ledger 0.95M ...), plus the ids inside the jsonb of every
--     hand those horses played (2.45M hand-player rows).
--   * The money journal is hash-sealed over these ids:
--     chip_ledger.row_hash = sha256(... from_entity_id ... to_entity_id ...)
--     (148,885 rows), prev_hash chains through it, and
--     ca_ledger_day_manifests.sha256 attests every day since February
--     (fn_ca_verify_ledger_chain / fn_ca_ledger_day_manifest_verify_all
--     raise critical 'unauthorized_adjustment' drift on any change).
--   * Hand evidence is hash-sealed over jsonb containing these ids:
--     hand_atomic_commits.post_commit_payload_hash,
--     cash_hand_provenance_receipts.payload_hash,
--     union_pnl_cash_outcomes.payload_hash, re-verified by
--     fn_pnl_cash_hand_evidence, fn_horse_commitment_audit_step,
--     fn_union_pnl_prove_cash_outcome_links and the f06_* proofs.
--   * 195 tables carry 289 append-only / immutable-evidence triggers
--     (chip_ledger, wallet_transactions, chip_transactions,
--     diamond_transactions, agent_commissions, vip_points_ledger,
--     rake_attributions, accounting_cash_rake_sources, terminal
--     tournament_players / table_seats / tournament_obligations ...).
--   * IMMUTABLE functions embed these ids as forensic evidence:
--     smarter_private.spin_original_retained_case (342 occurrences of
--     ...05 and ...49), smarter_private.f06_historical_bank_loss_cohort
--     (...23, ...38 with bank_witness_sha256), mirrored in
--     club-arena server/scripts/legacy-engine-checkpoint-guard.mjs and in
--     ~60 captured test fixtures.
--   Rewriting any of that is rewriting sealed financial history, so the
--   ids stay where they are in the journals and the identities leave the
--   public surfaces instead.
--
-- WHAT THIS FILE DOES (two transactions, idempotent, re-runnable):
--   STAGE 1  bench the 62 patterned horses (horse_status='disabled'; the
--            fleet only seats horses whose status is not 'disabled',
--            HorseFleetManager.ts:1332, and fn_a_benched_horse_stays_benched
--            keeps them benched). Records every account's before-state.
--   STAGE 2  (refuses until the 62 have left every live seat and every
--            open tournament entry) retires all 94 identities from every
--            public surface: soft-deletes their posts/reels/comments/
--            stories/messages, deletes their likes, friendships, friend
--            requests, follows, conversation memberships and social
--            notifications (each deleted row is kept in
--            smarter_private.patterned_identity_retirement_rows),
--            deactivates content_authors and trivia PvP personas, records
--            the retirement in the GLI-19 fleet register, stops
--            fn_ca_fleet_register_sync from un-retiring a closed account,
--            and tombstones the profile like fn_close_account does (with a
--            random tombstone: fn_close_account's 'deleted-'||left(id,12)
--            would be 'deleted-000000000000' for all 52 and collide).
--   Nothing financial is written: no balance, ledger, hand, seat history,
--   settlement or evidence row changes. Post-asserts prove it.
--
-- BEFORE STAGE 2 (it refuses without these):
--   1. Deploy the club-arena fix to HorseOnboarding.sweepIncompleteHorses /
--      ensureHorseComplete so a profile with status='deleted' is skipped
--      (today the boot sweep selects every is_horse row, refills
--      display_name/alias and flips content_authors.is_active back to true).
--      Then: SET app.bot_retire_engine_sweep_fix = '<deployed commit sha>';
--   2. Qualify changes in an isolated native fixture first. This completed
--      cohort must not be replayed in production. The retained dry-run option
--      rolls Stage 2 back; it is not authorization to probe a live cohort.
--
-- Never run between :50 and :03 UTC (both stages refuse).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STAGE 1 - record and bench
-- -----------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $stage1_preflight$
DECLARE
  v_min int := extract(minute FROM (clock_timestamp() AT TIME ZONE 'UTC'))::int;
  v_h int; v_f int; v_hmd5 text; v_fmd5 text;
BEGIN
  IF v_min >= 50 OR v_min <= 3 THEN
    RAISE EXCEPTION 'BOT_ID_WINDOW_REFUSED: minute :% UTC is inside :50-:03', lpad(v_min::text, 2, '0')
      USING ERRCODE = '55000';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'BOT_ID_ROLE_REFUSED: run as postgres, not %', current_user USING ERRCODE = '42501';
  END IF;
  SELECT count(*) FILTER (WHERE h), count(*) FILTER (WHERE NOT h),
         md5(string_agg(id::text, ',' ORDER BY id) FILTER (WHERE h)),
         md5(string_agg(id::text, ',' ORDER BY id) FILTER (WHERE NOT h))
    INTO v_h, v_f, v_hmd5, v_fmd5
    FROM (SELECT p.id, coalesce(p.is_horse, false) AS h
            FROM public.profiles p
           WHERE (p.id::text ~ '^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$'
                  OR p.id::text ~ '^face0000-0000-0000-0000-0000000000[0-9a-f]{2}$')
             AND p.id <> '00000000-0000-0000-0000-000000000001') c;
  -- Pinned to the 2026-10-06 census. A different population is a different
  -- decision: refuse rather than retire accounts nobody looked at.
  IF (v_h, v_f, v_hmd5, v_fmd5) IS DISTINCT FROM
     (62, 32, 'cd746293f12b88be4f1a42cfa7a28316', 'aff64eb2618560b70629b53ac66501f7') THEN
    RAISE EXCEPTION 'BOT_ID_CENSUS_CHANGED: horses % (%), fixtures % (%)', v_h, v_hmd5, v_f, v_fmd5
      USING ERRCODE = '55000';
  END IF;
END
$stage1_preflight$;

CREATE TABLE IF NOT EXISTS smarter_private.patterned_identity_retirements (
  old_id                     uuid PRIMARY KEY,
  cohort                     text NOT NULL CHECK (cohort IN ('horse', 'fixture')),
  username_before            text,
  display_name_before        text,
  full_name_before           text,
  alias_before               text,
  avatar_url_before          text,
  arena_avatar_url_before    text,
  cover_photo_url_before     text,
  bio_before                 text,
  status_text_before         text,
  status_before              text,
  is_online_before           boolean,
  horse_status_before        text,
  users_username_before      text,
  users_avatar_url_before    text,
  tombstone                  text UNIQUE,
  benched_at                 timestamptz,
  retired_at                 timestamptz,
  replacement_horse_id       uuid,
  recorded_at                timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE smarter_private.patterned_identity_retirements IS
  'One row per account whose hand-made id (00000000-.../face0000-...) labelled it a bot. Before-state of every public field, the tombstone it was given, and (later) the fresh-id horse that replaced it. Source of truth for the Stage 2 rollback.';

CREATE TABLE IF NOT EXISTS smarter_private.patterned_identity_retirement_rows (
  id          bigserial PRIMARY KEY,
  src         text NOT NULL,
  action      text NOT NULL CHECK (action IN ('deleted', 'flagged')),
  pk          uuid,
  row_before  jsonb NOT NULL,
  taken_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE smarter_private.patterned_identity_retirement_rows IS
  'Every row Stage 2 deleted (whole row) or flagged (the fields it changed, before values). Lets the rollback put the public surfaces back exactly.';

REVOKE ALL ON smarter_private.patterned_identity_retirements FROM PUBLIC;
REVOKE ALL ON smarter_private.patterned_identity_retirement_rows FROM PUBLIC;
DO $revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON smarter_private.patterned_identity_retirements FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON smarter_private.patterned_identity_retirement_rows FROM anon, authenticated';
  END IF;
END
$revoke$;

-- Lock the cohort's profile rows in id order (the engine updates horse
-- profiles one row at a time; id order cannot deadlock against that).
SELECT count(*) AS cohort_rows_locked
  FROM (SELECT p.id FROM public.profiles p
         WHERE (p.id::text ~ '^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$'
                OR p.id::text ~ '^face0000-0000-0000-0000-0000000000[0-9a-f]{2}$')
           AND p.id <> '00000000-0000-0000-0000-000000000001'
         ORDER BY p.id FOR UPDATE) l;

-- Before-state, first run only (ON CONFLICT keeps the original record).
INSERT INTO smarter_private.patterned_identity_retirements (
  old_id, cohort, username_before, display_name_before, full_name_before, alias_before,
  avatar_url_before, arena_avatar_url_before, cover_photo_url_before, bio_before,
  status_text_before, status_before, is_online_before, horse_status_before,
  users_username_before, users_avatar_url_before, tombstone)
SELECT p.id,
       CASE WHEN coalesce(p.is_horse, false) THEN 'horse' ELSE 'fixture' END,
       p.username, p.display_name, p.full_name, p.alias,
       p.avatar_url, p.arena_avatar_url, p.cover_photo_url, p.bio,
       p.status_text, p.status, p.is_online, p.horse_status,
       u.username, u.avatar_url,
       -- random, unique, 12 hex like fn_close_account's shape; NOT derived
       -- from the id (that would be 'deleted-000000000000' for 52 of them)
       'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 12)
  FROM public.profiles p
  LEFT JOIN public.users u ON u.id = p.id
 WHERE (p.id::text ~ '^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$'
        OR p.id::text ~ '^face0000-0000-0000-0000-0000000000[0-9a-f]{2}$')
   AND p.id <> '00000000-0000-0000-0000-000000000001'
ON CONFLICT (old_id) DO NOTHING;

-- Bench. horse_status is horse authority: allowed here because postgres
-- with no JWT is service context (fn_is_service_context). Re-runs no-op.
UPDATE public.profiles p
   SET horse_status = 'disabled', updated_at = now()
  FROM smarter_private.patterned_identity_retirements r
 WHERE r.old_id = p.id AND r.cohort = 'horse'
   AND p.horse_status IS DISTINCT FROM 'disabled';

UPDATE smarter_private.patterned_identity_retirements r
   SET benched_at = clock_timestamp()
 WHERE r.cohort = 'horse' AND r.benched_at IS NULL;

DO $stage1_post$
DECLARE v_rec int; v_benched int; v_horses int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE cohort = 'horse') INTO v_rec, v_horses
    FROM smarter_private.patterned_identity_retirements;
  SELECT count(*) INTO v_benched
    FROM public.profiles p JOIN smarter_private.patterned_identity_retirements r ON r.old_id = p.id
   WHERE r.cohort = 'horse' AND p.horse_status = 'disabled' AND r.benched_at IS NOT NULL;
  IF v_rec <> 94 OR v_horses <> 62 OR v_benched <> 62 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE1_POSTFLIGHT: recorded % (horses %), benched %', v_rec, v_horses, v_benched;
  END IF;
  RAISE NOTICE 'BOT_ID_STAGE1_OK: 94 recorded, 62 horses benched';
END
$stage1_post$;
COMMIT;

-- -----------------------------------------------------------------------------
-- STAGE 2 - retire the 94 identities from every public surface
-- One DO block = one unit: any refusal or failed assert rolls back all of it.
-- -----------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '180s';

DO $stage2$
DECLARE
  v_min       int := extract(minute FROM (clock_timestamp() AT TIME ZONE 'UTC'))::int;
  v_ids       uuid[];
  v_horses    uuid[];
  v_n         int;
  v_seats     int;
  v_entries   int;
  v_done      int;
  v_fix       text := coalesce(current_setting('app.bot_retire_engine_sweep_fix', true), '');
  v_dry       boolean := coalesce(current_setting('app.bot_retire_dry_run', true), '') = 'on';
  v_summary   jsonb := '{}'::jsonb;
  v_def       text;
  v_old_unretire text := 'exists (select 1 from public.profiles p where p.id = r.horse_id and coalesce(p.is_horse, false))';
  v_new_unretire text := 'exists (select 1 from public.profiles p where p.id = r.horse_id and coalesce(p.is_horse, false) and coalesce(p.status, '''') <> ''deleted'')';
  v_bad       int;
  v_table     uuid;
  v_mark      bigint;
  v_scan      int;
  v_pending   int;
BEGIN
  -- ---- preflight -----------------------------------------------------------
  IF v_min >= 50 OR v_min <= 3 THEN
    RAISE EXCEPTION 'BOT_ID_WINDOW_REFUSED: minute :% UTC is inside :50-:03', lpad(v_min::text, 2, '0')
      USING ERRCODE = '55000';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'BOT_ID_ROLE_REFUSED: run as postgres, not %', current_user USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(old_id ORDER BY old_id), array_agg(old_id ORDER BY old_id) FILTER (WHERE cohort = 'horse')
    INTO v_ids, v_horses
    FROM smarter_private.patterned_identity_retirements;
  IF coalesce(cardinality(v_ids), 0) <> 94 OR coalesce(cardinality(v_horses), 0) <> 62 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE1_MISSING: run Stage 1 first' USING ERRCODE = '55000';
  END IF;

  -- Status flags are not a financial drain certificate. A forced left/eliminated
  -- row still owns its original funded custody and retained hand obligations.
  IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION 'BOT_ID_NATIVE_GUARDS_REQUIRED' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.tournament_players tp JOIN public.tournaments t ON t.id=tp.tournament_id
      WHERE tp.user_id=ANY(v_ids) AND upper(coalesce(t.status::text,'')) NOT IN('COMPLETED','CANCELLED','CANCELED')
      AND (lower(coalesce(tp.status::text,'')) IN('registered','playing') OR tp.chips>0 OR tp.position IS NULL)) THEN
    RAISE EXCEPTION 'BOT_ID_UNPAID_TOURNAMENT_CUSTODY' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.cash_participant_funding_receipts f
      WHERE f.user_id=ANY(v_ids) AND NOT EXISTS(SELECT 1 FROM public.table_seats s
        WHERE s.id=f.seat_id AND s.user_id=f.user_id AND s.occupancy_id=f.occupancy_id
          AND s.joined_at=f.seat_joined_at AND s.left_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM public.seat_cashout_receipts r
        WHERE r.occupancy_id=f.occupancy_id AND r.user_id=f.user_id AND r.table_id=f.table_id AND r.seat_id=f.seat_id AND r.receipt->>'ok'='true' AND r.receipt->>'tournament_table'='false'))
    OR EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
      WHERE s.user_id=ANY(v_ids) AND t.tournament_id IS NULL AND s.stack>0
      AND NOT EXISTS(SELECT 1 FROM public.seat_cashout_receipts r
        WHERE r.occupancy_id=s.occupancy_id AND r.user_id=s.user_id AND r.table_id=s.table_id AND r.seat_id=s.id AND r.receipt->>'ok'='true' AND r.receipt->>'tournament_table'='false' AND (r.receipt->>'stack')::numeric=s.stack)) THEN
    RAISE EXCEPTION 'BOT_ID_UNPAID_OR_UNPROVEN_CASH_CUSTODY' USING ERRCODE='55000';
  END IF;
  -- Indexed table/hand windows start at the native settled mark. A larger or
  -- undrained window refuses; this producer never advances recovery marks.
  FOR v_table IN
    SELECT DISTINCT table_id FROM public.table_seats WHERE user_id=ANY(v_ids)
    UNION SELECT DISTINCT table_id FROM public.cash_participant_funding_receipts WHERE user_id=ANY(v_ids)
    UNION SELECT DISTINCT table_id FROM public.tournament_players WHERE user_id=ANY(v_ids) AND table_id IS NOT NULL
  LOOP
    SELECT settled_through INTO v_mark FROM smarter_private.hand_submission_resume_marks WHERE table_id=v_table;
    WITH bounded AS MATERIALIZED(SELECT * FROM smarter_private.hand_submissions
      WHERE table_id=v_table AND hand_number>coalesce(v_mark,-1) ORDER BY hand_number LIMIT 1001)
    SELECT count(*),count(*) FILTER(WHERE
      EXISTS(SELECT 1 FROM jsonb_array_elements(b.request->'p_stacks') x WHERE (x->>'user_id')::uuid=ANY(v_ids))
      AND NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_disposals d WHERE d.table_id=b.table_id AND d.hand_number=b.hand_number AND d.submission_id=b.submission_id)
      AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=b.table_id AND a.hand_number=b.hand_number AND a.hand_id=b.submission_id
        AND a.post_commit_completed_at IS NOT NULL AND a.post_commit_result->>'ok'='true'
        AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=b.table_id AND h.hand_number=b.hand_number AND h.state='reserved')))
      INTO v_scan,v_pending FROM bounded b;
    IF v_scan>1000 OR v_pending>0 THEN
      RAISE EXCEPTION 'BOT_ID_ORIGINAL_HAND_UNDRAINED: table %, bounded rows %, unfinished originals %',v_table,v_scan,v_pending USING ERRCODE='55000';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_done
    FROM smarter_private.patterned_identity_retirements r
    JOIN public.profiles p ON p.id = r.old_id
   WHERE r.retired_at IS NOT NULL AND p.status = 'deleted' AND p.username = r.tombstone;
  IF v_done = 94 THEN
    RAISE NOTICE 'BOT_ID_STAGE2_ALREADY_DONE: all 94 identities were retired earlier; nothing to do';
    RETURN;
  END IF;

  IF v_fix !~ '^[0-9a-f]{7,40}$' THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_NEEDS_ENGINE_FIX: deploy the HorseOnboarding sweep fix (skip status=deleted) and SET app.bot_retire_engine_sweep_fix = ''<commit sha>'''
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_n
    FROM public.profiles p JOIN smarter_private.patterned_identity_retirements r ON r.old_id = p.id
   WHERE r.cohort = 'horse'
     AND (p.horse_status IS DISTINCT FROM 'disabled' OR r.benched_at IS NULL
          OR r.benched_at > clock_timestamp() - interval '10 minutes');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_NOT_BENCHED: % horses not benched for 10 minutes yet', v_n USING ERRCODE = '55000';
  END IF;

  -- Quiesce proof: nothing of theirs on live felt, nothing in an open event.
  SELECT count(*) INTO v_seats
    FROM public.table_seats s WHERE s.user_id = ANY (v_ids) AND s.left_at IS NULL;
  SELECT count(*) INTO v_entries
    FROM public.tournament_players tp JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.user_id = ANY (v_ids)
     AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing')
     AND upper(coalesce(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED');
  IF v_seats > 0 OR v_entries > 0 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_NOT_READY: % live seats, % open tournament entries still held by the cohort; re-run after they drain',
      v_seats, v_entries USING ERRCODE = '55000';
  END IF;

  -- Lock the cohort profiles in id order before touching anything.
  PERFORM 1 FROM public.profiles p WHERE p.id = ANY (v_ids) ORDER BY p.id FOR UPDATE;

  -- ---- money and journal snapshot (must be identical afterwards) -----------
  CREATE TEMP TABLE _bot_retire_before ON COMMIT DROP AS
  SELECT 'profiles.diamonds'::text AS k, coalesce(sum(diamonds), 0)::numeric AS v FROM public.profiles WHERE id = ANY (v_ids)
  UNION ALL SELECT 'profiles.diamond_balance', coalesce(sum(diamond_balance), 0) FROM public.profiles WHERE id = ANY (v_ids)
  UNION ALL SELECT 'user_diamonds.balance', coalesce(sum(balance), 0) FROM public.user_diamonds WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'club_members.chips', coalesce(sum(coalesce(chip_balance, 0) + coalesce(held_chips, 0) + coalesce(locked_chips, 0)
                                                     + coalesce(promo_balance, 0) + coalesce(credit_used, 0) + coalesce(diamonds, 0)), 0)
                                          FROM public.club_members WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'club_members.rows', count(*) FROM public.club_members WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'wallets.balance', coalesce(sum(coalesce(balance, 0) + coalesce(locked_balance, 0)), 0) FROM public.wallets WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'chip_ledger.rows', count(*) FROM public.chip_ledger WHERE from_entity_id = ANY (v_ids) OR to_entity_id = ANY (v_ids)
  UNION ALL SELECT 'diamond_transactions.rows', count(*) FROM public.diamond_transactions WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'wallet_transactions.rows', count(*) FROM public.wallet_transactions WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'table_seats.rows', count(*) FROM public.table_seats WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'tournament_players.rows', count(*) FROM public.tournament_players WHERE user_id = ANY (v_ids)
  UNION ALL SELECT 'auth.users.rows', count(*) FROM auth.users WHERE id = ANY (v_ids)
  UNION ALL SELECT 'profiles.rows', count(*) FROM public.profiles WHERE id = ANY (v_ids);

  -- ---- social graph edges: delete, keep the whole row ----------------------
  WITH d AS (DELETE FROM public.friendships f WHERE f.user_id = ANY (v_ids) OR f.friend_id = ANY (v_ids) RETURNING f.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.friendships', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('friendships', v_n);

  WITH d AS (DELETE FROM public.friend_requests f WHERE f.sender_id = ANY (v_ids) OR f.recipient_id = ANY (v_ids) RETURNING f.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.friend_requests', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('friend_requests', v_n);

  WITH d AS (DELETE FROM public.social_follows f WHERE f.follower_id = ANY (v_ids) OR f.following_id = ANY (v_ids) RETURNING f.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_follows', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('social_follows', v_n);

  -- likes: trig_sync_like_count decrements the liked post/reel's like_count
  WITH d AS (DELETE FROM public.social_likes l WHERE l.user_id = ANY (v_ids) RETURNING l.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_likes', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('social_likes', v_n);

  -- an accounting conversation's audience is an immutable document
  -- (fn_accounting_conversation_audience_guard); staff-only, left alone
  WITH d AS (DELETE FROM public.social_conversation_participants c
              WHERE c.user_id = ANY (v_ids)
                AND NOT EXISTS (SELECT 1 FROM public.accounting_conversations ac WHERE ac.conversation_id = c.conversation_id)
             RETURNING c.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_conversation_participants', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('conversation_participants', v_n);

  -- notifications a human received naming one of them as the actor
  -- (accounting-linked notifications are documents and are left alone)
  WITH d AS (
    DELETE FROM public.notifications n
     WHERE n.actor_id = ANY (v_ids)
       AND NOT EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries a WHERE a.notification_id = n.id)
       AND NOT EXISTS (SELECT 1 FROM public.push_outbox o WHERE o.accounting_notification_id = n.id)
    RETURNING n.*)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.notifications', 'deleted', d.id, to_jsonb(d) FROM d;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('notifications_as_actor', v_n);

  -- ---- authored content: soft-delete, keep the before-flag -----------------
  WITH u AS (UPDATE public.social_posts s SET is_deleted = true, updated_at = now()
              WHERE s.author_id = ANY (v_ids) AND s.is_deleted IS DISTINCT FROM true
             RETURNING s.id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_posts', 'flagged', u.id, jsonb_build_object('is_deleted', false) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('posts', v_n);

  WITH u AS (UPDATE public.social_reels s SET is_deleted = true, updated_at = now()
              WHERE s.author_id = ANY (v_ids) AND s.is_deleted IS DISTINCT FROM true
             RETURNING s.id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_reels', 'flagged', u.id, jsonb_build_object('is_deleted', false) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('reels', v_n);

  -- fn_update_post_comment_count decrements comment_count on false->true
  WITH u AS (UPDATE public.social_comments s SET is_deleted = true, updated_at = now()
              WHERE s.author_id = ANY (v_ids) AND s.is_deleted IS DISTINCT FROM true
             RETURNING s.id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_comments', 'flagged', u.id, jsonb_build_object('is_deleted', false) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('comments', v_n);

  WITH u AS (UPDATE public.social_stories s SET is_active = false
              WHERE s.author_id = ANY (v_ids) AND s.is_active IS DISTINCT FROM false
             RETURNING s.id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_stories', 'flagged', u.id, jsonb_build_object('is_active', true) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('stories', v_n);

  -- an issued accounting message is an immutable document: not touched
  WITH u AS (UPDATE public.social_messages m SET is_deleted = true, updated_at = now()
              WHERE m.sender_id = ANY (v_ids) AND m.is_deleted IS DISTINCT FROM true
                AND NOT EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries a WHERE a.message_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM public.accounting_conversations ac WHERE ac.conversation_id = m.conversation_id)
             RETURNING m.id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.social_messages', 'flagged', u.id, jsonb_build_object('is_deleted', false) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('messages', v_n);

  -- ---- horse personas stop speaking ----------------------------------------
  WITH u AS (UPDATE public.content_authors a SET is_active = false
              WHERE a.profile_id = ANY (v_ids) AND a.is_active IS DISTINCT FROM false
             RETURNING a.profile_id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.content_authors', 'flagged', u.profile_id, jsonb_build_object('is_active', true) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('content_authors', v_n);

  WITH u AS (UPDATE public.trivia_pvp_horse_personas t SET active = false, updated_at = now()
              WHERE t.horse_id = ANY (v_ids) AND t.active IS DISTINCT FROM false
             RETURNING t.horse_id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.trivia_pvp_horse_personas', 'flagged', u.horse_id, jsonb_build_object('active', true) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('trivia_pvp_personas', v_n);

  -- ---- GLI-19 fleet register: a retired horse is recorded as retired --------
  WITH u AS (UPDATE public.ca_horse_fleet_register r
                SET retired_at = clock_timestamp(),
                    note = coalesce(r.note, '') || ' | retired 2026-10: hand-made id labelled the account; public identity closed, journals keep the id'
              WHERE r.horse_id = ANY (v_horses) AND r.retired_at IS NULL
             RETURNING r.horse_id)
  INSERT INTO smarter_private.patterned_identity_retirement_rows (src, action, pk, row_before)
  SELECT 'public.ca_horse_fleet_register', 'flagged', u.horse_id, jsonb_build_object('retired_at', NULL) FROM u;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('fleet_register_retired', v_n);

  -- fn_ca_fleet_register_sync un-retires any register row whose profile is
  -- is_horse, which would undo the line above on its next run. A closed
  -- account (status='deleted') is not un-retired. Patched in place: the
  -- exact clause must occur exactly once or nothing is changed.
  SELECT pg_get_functiondef('public.fn_ca_fleet_register_sync(uuid)'::regprocedure) INTO v_def;
  IF position(v_new_unretire IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old_unretire, ''))) / length(v_old_unretire) <> 1 THEN
      RAISE EXCEPTION 'BOT_ID_REGISTER_SYNC_SHAPE_CHANGED: un-retire clause not found exactly once';
    END IF;
    EXECUTE replace(v_def, v_old_unretire, v_new_unretire);
    v_summary := v_summary || jsonb_build_object('register_sync_patched', true);
  END IF;

  -- ---- the profile: tombstone exactly the way fn_close_account does --------
  UPDATE public.profiles p SET
    username = r.tombstone,
    full_name = NULL, display_name = NULL, first_name = NULL, last_name = NULL,
    alias = NULL, status_text = NULL, bio = NULL,
    avatar_url = NULL, cover_photo_url = NULL, arena_avatar_url = NULL,
    website = NULL, twitter = NULL, instagram = NULL, tiktok = NULL,
    telegram = NULL, hendon_url = NULL,
    is_online = false, status = 'deleted', updated_at = now()
  FROM smarter_private.patterned_identity_retirements r
  WHERE r.old_id = p.id AND p.status IS DISTINCT FROM 'deleted';
  GET DIAGNOSTICS v_n = ROW_COUNT; v_summary := v_summary || jsonb_build_object('profiles_tombstoned', v_n);

  UPDATE public.users u SET username = r.tombstone, avatar_url = NULL, updated_at = now()
    FROM smarter_private.patterned_identity_retirements r
   WHERE r.old_id = u.id AND u.username IS DISTINCT FROM r.tombstone;

  UPDATE smarter_private.patterned_identity_retirements SET retired_at = clock_timestamp() WHERE retired_at IS NULL;

  -- ---- post-asserts: raise, never trust ------------------------------------
  SELECT count(*) INTO v_bad FROM (
    SELECT 1 FROM public.friendships WHERE user_id = ANY (v_ids) OR friend_id = ANY (v_ids)
    UNION ALL SELECT 1 FROM public.friend_requests WHERE sender_id = ANY (v_ids) OR recipient_id = ANY (v_ids)
    UNION ALL SELECT 1 FROM public.social_follows WHERE follower_id = ANY (v_ids) OR following_id = ANY (v_ids)
    UNION ALL SELECT 1 FROM public.social_likes WHERE user_id = ANY (v_ids)
    UNION ALL SELECT 1 FROM public.social_conversation_participants c WHERE c.user_id = ANY (v_ids)
                AND NOT EXISTS (SELECT 1 FROM public.accounting_conversations ac WHERE ac.conversation_id = c.conversation_id)
    UNION ALL SELECT 1 FROM public.social_posts WHERE author_id = ANY (v_ids) AND is_deleted IS DISTINCT FROM true
    UNION ALL SELECT 1 FROM public.social_reels WHERE author_id = ANY (v_ids) AND is_deleted IS DISTINCT FROM true
    UNION ALL SELECT 1 FROM public.social_comments WHERE author_id = ANY (v_ids) AND is_deleted IS DISTINCT FROM true
    UNION ALL SELECT 1 FROM public.social_stories WHERE author_id = ANY (v_ids) AND is_active IS DISTINCT FROM false
    UNION ALL SELECT 1 FROM public.content_authors WHERE profile_id = ANY (v_ids) AND is_active IS DISTINCT FROM false
    UNION ALL SELECT 1 FROM public.trivia_pvp_horse_personas WHERE horse_id = ANY (v_ids) AND active IS DISTINCT FROM false
    UNION ALL SELECT 1 FROM public.ca_horse_fleet_register WHERE horse_id = ANY (v_horses) AND retired_at IS NULL
    UNION ALL SELECT 1 FROM public.notifications n WHERE n.actor_id = ANY (v_ids)
                AND NOT EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries a WHERE a.notification_id = n.id)
                AND NOT EXISTS (SELECT 1 FROM public.push_outbox o WHERE o.accounting_notification_id = n.id)
    UNION ALL SELECT 1 FROM public.profiles p JOIN smarter_private.patterned_identity_retirements r ON r.old_id = p.id
               WHERE p.status IS DISTINCT FROM 'deleted' OR p.username IS DISTINCT FROM r.tombstone
                  OR p.display_name IS NOT NULL OR p.avatar_url IS NOT NULL OR p.alias IS NOT NULL
                  OR p.is_online IS DISTINCT FROM false
                  OR (r.cohort = 'horse' AND (p.horse_status IS DISTINCT FROM 'disabled' OR p.is_horse IS DISTINCT FROM true))
  ) x;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_POSTFLIGHT_SURFACE: % public-surface rows still name the cohort', v_bad;
  END IF;

  -- money, journals, seat/hand history, accounts: unchanged to the cent/row
  SELECT count(*) INTO v_bad
    FROM _bot_retire_before b
    JOIN (
      SELECT 'profiles.diamonds'::text AS k, coalesce(sum(diamonds), 0)::numeric AS v FROM public.profiles WHERE id = ANY (v_ids)
      UNION ALL SELECT 'profiles.diamond_balance', coalesce(sum(diamond_balance), 0) FROM public.profiles WHERE id = ANY (v_ids)
      UNION ALL SELECT 'user_diamonds.balance', coalesce(sum(balance), 0) FROM public.user_diamonds WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'club_members.chips', coalesce(sum(coalesce(chip_balance, 0) + coalesce(held_chips, 0) + coalesce(locked_chips, 0)
                                                         + coalesce(promo_balance, 0) + coalesce(credit_used, 0) + coalesce(diamonds, 0)), 0)
                                              FROM public.club_members WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'club_members.rows', count(*) FROM public.club_members WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'wallets.balance', coalesce(sum(coalesce(balance, 0) + coalesce(locked_balance, 0)), 0) FROM public.wallets WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'chip_ledger.rows', count(*) FROM public.chip_ledger WHERE from_entity_id = ANY (v_ids) OR to_entity_id = ANY (v_ids)
      UNION ALL SELECT 'diamond_transactions.rows', count(*) FROM public.diamond_transactions WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'wallet_transactions.rows', count(*) FROM public.wallet_transactions WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'table_seats.rows', count(*) FROM public.table_seats WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'tournament_players.rows', count(*) FROM public.tournament_players WHERE user_id = ANY (v_ids)
      UNION ALL SELECT 'auth.users.rows', count(*) FROM auth.users WHERE id = ANY (v_ids)
      UNION ALL SELECT 'profiles.rows', count(*) FROM public.profiles WHERE id = ANY (v_ids)
    ) a ON a.k = b.k
   WHERE a.v IS DISTINCT FROM b.v;
  IF v_bad <> 0 OR (SELECT count(*) FROM _bot_retire_before) <> 13 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_POSTFLIGHT_MONEY: % balance/journal/history figures moved', v_bad;
  END IF;

  IF position(v_new_unretire IN pg_get_functiondef('public.fn_ca_fleet_register_sync(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'BOT_ID_STAGE2_POSTFLIGHT_REGISTER: register sync still un-retires closed accounts';
  END IF;

  IF v_dry THEN
    RAISE EXCEPTION 'BOT_RETIRE_DRY_RUN_OK %', v_summary USING ERRCODE = 'P0001';
  END IF;
  RAISE NOTICE 'BOT_ID_STAGE2_OK %', v_summary;
END
$stage2$;
COMMIT;

-- =============================================================================
-- This maintained forward owner does not reopen retired identities or replay
-- historical stages. Retained before-images are evidence, not an automatic
-- rollback instruction. Existing paid-game obligations remain authoritative.
-- =============================================================================
