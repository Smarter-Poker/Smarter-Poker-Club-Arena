-- Diamond Accounting Standard, Lane A: the supply identity, the mirrors and the doors.
-- 2026-09-03. One transaction. Applied once.
--
-- WHAT THIS CHANGES, and the production evidence for each (measured 2026-09-03 ~01:00 UTC):
--
-- 1. DR10. fn_ca_diamond_snapshot computed total = SUM(profiles.diamonds) + SUM(diamond_wallets.balance).
--    Since the 09-02 17:29 mirror backfill, diamond_wallets IS profiles, so every diamond held by
--    one of the 416 wallet users was counted twice: total 1,649,971 against a real supply of
--    1,030,092, and a one-off unexplained = 619,829 at the 18:10 snapshot that was a mirror
--    backfill, not a mint. total now reads the canonical store once. wallet_diamonds is still
--    recorded as a mirror figure; it is never added.
--
--    THE FIRST-RUN DRIFT PROBLEM, and how it is solved without a correcting row: the drift math
--    subtracted prev.total, which carries the old identity. Changing v_total alone would have
--    written a false unexplained of -619,879 on the next hourly run, and
--    scripts/ci/check-chip-conservation.mjs fails the Hetzner deploy gate
--    (.github/workflows/auto-deploy-hetzner.yml:310) when the trailing 4h sum of unexplained
--    exceeds 500 in absolute value. That gate blocked 26 consecutive engine deploys on 09-02 and
--    must not be re-armed by an accounting correction. The fix is to compare like with like:
--    the previous interval is read from prev.profile_diamonds, which is NOT NULL on all 53
--    historical rows and has always meant exactly SUM(profiles.diamonds). Arithmetic on the
--    live prev row (id 53, 00:10 UTC, profile_diamonds 1,030,092, cert 234,480):
--      (1,030,092 - 234,480) - (1,030,092 - 234,480) - journal_noncert = -journal_noncert
--    which is the correct answer, identical to what the old identity produced. No correcting
--    row is written and none is needed. The 619,829 spike of 18:10 has already aged out of the
--    gate's 4h window; every snapshot from 19:10 to 00:10 reads unexplained = 0.
--
--    Also added: a mirror-equality figure. Mirrors are compared for equality and never summed;
--    a non-zero count of profiles whose user_diamonds, user_diamond_balance or diamond_wallets
--    row disagrees with profiles.diamonds files DR10:mirror_mismatch as a warning.
--
-- 2. fn_diamond_side_tables_follow_profiles updated diamond_wallets with a bare UPDATE while the
--    other two mirror legs upsert. A profile with no wallet row could therefore never gain one:
--    416 of 1,308 profiles had a row, 892 did not, and the 410,213 diamonds those 892 hold were
--    invisible to that mirror. The leg becomes an UPSERT and the 892 missing rows are backfilled
--    from profiles. THIS MOVES NO DIAMONDS. diamond_wallets is a mirror, not a balance: nothing
--    on the canonical path reads it, profiles.diamonds is untouched by this migration, and the
--    supply identity above no longer adds it. lifetime_earned on a backfilled row is set equal to
--    the mirrored balance so the row is internally consistent; this migration knows no history for
--    those users and does not invent one.
--
-- 3. The Mint doors. fn_ca_mint and fn_ca_burn were both granted to authenticated. Both repos were
--    grepped for browser callers (club-arena src/server/scripts/tests and World Hub pages/src/scripts,
--    excluding node_modules, dist, .next and public/hub): ZERO callers of either, from any role.
--    EXECUTE is revoked from authenticated on both; postgres and service_role keep it. fn_ca_burn is
--    registered in ca_money_rpc_registry (fn_ca_mint already was), and the diamond RPCs are
--    registered as an inventory declaration.
--
--    WHY REGISTERING IS SAFE: the registry's only consumer is fn_ca_money_rpc_drift, which scans
--    pg_proc for functions writing CHIP balance tables and warns about those NOT EXISTS in the
--    registry. A registry row can only suppress a warning for its own name; it can never create
--    one, and it changes no runtime behaviour. Most of these functions write profiles.diamonds,
--    which that scan does not look at, so they were never flagged. fn_union_send_to_member_zd3core
--    is already registered and is skipped.
--
-- 4. fn_purchase_time_banks is BROKEN in production and has been since 20260824_consolidate_time_banks.sql
--    regressed 20260823_fn_purchase_time_banks_balance_key.sql. The live body INSERTs into
--    diamond_transactions (user_id, amount, reason); there is no reason column on that table, so
--    EVERY call raises 42703 and no player can buy a time bank at all. It also hardcoded 2 diamonds
--    per use against feature_pricing.time_bank_seconds = 5, and dropped the idempotency reference.
--    Restored to the 08-23 semantics: price from feature_pricing, debit through deduct_diamonds with
--    a deterministic reference, the auth.uid() self-check and the grant to authenticated kept. The
--    08-24 single consolidated feature_purchases row is KEPT rather than the 08-23 N-row loop: that
--    part of 08-24 was a real fix for PostgREST row-limit truncation in the client's loadEntitlements,
--    and fn_time_bank_allowance reads SUM(uses_remaining), so one row of N is equivalent to N of 1.
--
-- 5. fn_union_send_to_member_zd3core with kind = 'diamonds' credits up to 100,000 diamonds per call
--    with no debit anywhere: an unfunded mint. LOG-ONLY under Dan's risk rule. It records
--    DR2:union_diamond_grant_unfunded and proceeds; it refuses nothing. The journal row it writes
--    now names its counterparty (union:<id>) and its class (promotional). Whether this door is
--    funded or removed is Dan's decision 6.6.
--
-- 6. ca_promo_vault_buy debits club_diamond_wallets with no journal row and no idempotency key.
--    LOG-ONLY: records DR3:club_diamond_debit_unjournaled at info severity and changes nothing else.
--
-- NOTHING IN THIS MIGRATION MOVES A DIAMOND BALANCE.
--
-- ROLLBACK: re-apply the previous bodies, which are quoted verbatim in
-- docs/changelog/2026-09-03-diamond-a-identity.md, and
--   GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_ca_burn(text,text,uuid,numeric,text,text) TO authenticated;
--   DELETE FROM public.ca_money_rpc_registry WHERE notes LIKE 'Diamond Accounting Standard Lane A%';
-- The diamond_wallets backfill is mirror data and needs no rollback.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. DR10: the supply identity reads the canonical store once.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric;
  v_basis_changed boolean := false;
  v_prev_basis numeric;
  v_mirror_bad bigint := 0;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert
    FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);

  -- DR10 (Diamond Accounting Standard 3.3): supply is the canonical store, read ONCE.
  -- profiles.diamonds IS the player wallet. user_diamonds, user_diamond_balance and
  -- diamond_wallets are AFTER-trigger MIRRORS of it, so adding any of them to the total
  -- counts the same diamond twice. v_wal is still recorded in the wallet_diamonds column
  -- as a mirror figure and is compared for equality below; it is never added.
  v_total := v_prof;

  -- Mirror equality (DR10). Every profile should have a row in each of the three mirror
  -- tables carrying exactly its balance. A disagreement means a writer moved the canonical
  -- store without the mirror trigger firing, or a mirror was written directly.
  SELECT count(*) INTO v_mirror_bad
    FROM profiles p
    LEFT JOIN user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal
      FROM diamond_transactions WHERE created_at > prev.taken_at;
    -- 2026-09-01: the journal that must explain NON-CERT supply is the
    -- non-cert journal. Cert grants explain cert supply, which is tracked
    -- in cert_diamonds and deliberately excluded from the drift math - the
    -- certification fleet seeds hundreds of test accounts nightly and must
    -- not wedge the deploy gate.
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t
     WHERE t.created_at > prev.taken_at
       AND NOT public.fn_ca_is_cert_account(t.user_id);
    -- Accounts (re)tagged cert since the previous snapshot move their whole
    -- balance across the cert/non-cert line with no journal row - a basis
    -- change, not a leak. (Untagging is manual and rare; if done, expect one
    -- unexplained interval and read this comment.)
    SELECT EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                    WHERE c.tagged_at > prev.taken_at) INTO v_basis_changed;

    -- 2026-09-03 (DR10): the previous interval is read on the SAME identity as this one.
    -- The previous stored total column carries the OLD identity (profiles + the diamond_wallets mirror) for every
    -- row written before this migration, and subtracting it from a profiles-only total would
    -- have manufactured a one-off unexplained of about -619,879 and re-armed the Hetzner
    -- deploy gate. prev.profile_diamonds is NOT NULL on every historical row and has always
    -- meant SUM(profiles.diamonds) exactly, so it is the continuous basis across the change.
    v_prev_basis := prev.profile_diamonds;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total,
     journaled_delta, delta_vs_prev, unexplained)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     CASE WHEN prev.id IS NULL OR v_basis_changed THEN NULL
          ELSE (v_total - v_cert)
               - (v_prev_basis - COALESCE(prev.cert_diamonds, 0))
               - COALESCE(v_journal_noncert, 0) END)
  RETURNING unexplained INTO v_unexplained;

  IF v_mirror_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident(
      'DR10:mirror_mismatch', 'warning', NULL, v_mirror_bad::numeric,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('profiles_disagreeing', v_mirror_bad,
                         'profile_diamonds', v_prof,
                         'wallet_diamonds', v_wal,
                         'note', 'user_diamonds / user_diamond_balance / diamond_wallets are mirrors of profiles.diamonds and are compared for equality, never added to supply'));
  END IF;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained,
      v_prev_basis + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NON-CERT diamond supply changed by ' || round(v_unexplained,2)
        || ' with no non-cert diamond_transactions row explaining it - a diamond writer is bypassing the journal',
      false, jsonb_build_object('profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
                                 'cert_diamonds', v_cert));
  END IF;

  RETURN v_unexplained;
END $fn$;

COMMENT ON FUNCTION public.fn_ca_diamond_snapshot() IS
  'DR10. Hourly diamond supply snapshot. total = SUM(profiles.diamonds), the canonical store, read once. user_diamonds, user_diamond_balance and diamond_wallets are mirrors: recorded and compared for equality, never added. Drift is measured against prev.profile_diamonds so the basis is continuous across the 2026-09-03 identity change.';

-- ---------------------------------------------------------------------------
-- 2. The diamond_wallets mirror leg upserts, and the 892 missing rows are backfilled.
--    Mirror data. No diamond moves. profiles.diamonds is not read for update and not written.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_delta bigint := COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0);
BEGIN
  IF v_delta = 0 THEN RETURN NEW; END IF;

  INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0),
        lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
        lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
        updated_at      = now();

  INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
        lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
        lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
        updated_at      = now();

  -- 2026-09-03: this leg was a bare UPDATE, so a profile with no diamond_wallets row could
  -- never gain one and its balance was permanently absent from this mirror (892 of 1,308
  -- profiles, 410,213 diamonds). It upserts now, exactly like the two legs above.
  -- diamond_wallets has no created_at column; the unique key is diamond_wallets_user_id_key.
  INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
  VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance         = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
        lifetime_earned = COALESCE(public.diamond_wallets.lifetime_earned, 0) + GREATEST(v_delta, 0)::int,
        lifetime_spent  = COALESCE(public.diamond_wallets.lifetime_spent, 0)  + GREATEST(-v_delta, 0)::int,
        updated_at      = now();

  RETURN NEW;
END;
$fn$;

-- Backfill the rows the bare UPDATE could never create. Mirror data only.
INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
SELECT p.id, GREATEST(COALESCE(p.diamonds, 0), 0)::int,
             GREATEST(COALESCE(p.diamonds, 0), 0)::int, 0, now()
  FROM public.profiles p
 WHERE NOT EXISTS (SELECT 1 FROM public.diamond_wallets w WHERE w.user_id = p.id)
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The Mint doors, and the money-RPC registry.
-- ---------------------------------------------------------------------------

-- Zero browser callers of either in club-arena or Smarter-Poker-World-Hub (grepped
-- 2026-09-03 over src, server, scripts, tests, pages, excluding node_modules, dist,
-- .next and public/hub). The Mint is service_role and postgres only.
-- Revoked BY NAME over every overload rather than by a hardcoded signature. Lane B
-- recreated both functions with a seventh argument (p_class text DEFAULT 'admin') at
-- 00:22 UTC on 2026-09-03, while this migration was being written, and a hardcoded
-- six-argument signature raised 42883 and aborted the whole apply. Two lanes editing
-- the same function in the same hour is normal here, so this loop does not care what
-- the argument list is today.
DO $revoke_mint_doors$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('fn_ca_mint', 'fn_ca_burn')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END
$revoke_mint_doors$;

-- The registry is an inventory read only by fn_ca_money_rpc_drift through a NOT EXISTS
-- filter. A row can suppress a warning for its own name and can do nothing else, so these
-- inserts change no live behaviour. fn_union_send_to_member_zd3core is already registered
-- and is left alone. Every insert is guarded so a re-apply is a no-op.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved', v.notes
  FROM (VALUES
    ('fn_ca_burn',
     'Diamond Accounting Standard Lane A (2026-09-03): THE RETIREMENT SIDE OF THE MINT, the counterpart to fn_ca_mint which was registered 2026-09-01 while this one was not. Removes chips or diamonds from supply against ca_mint_ledger. EXECUTE revoked from authenticated in the same migration: service_role and postgres only.'),
    ('settle_diamond_card_purchase_atomic',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Settles a Stripe diamond purchase into profiles.diamonds. Registered so the diamond writers are declared; unique provider ids and the purchased-lot sub-ledger are Lane D.'),
    ('reconcile_diamond_purchase_refund',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Reverses a refunded diamond purchase; today it writes a negative balance by design. DR1 and the diamond_debts receivable are Lane D.'),
    ('add_diamonds_to_balance',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. THE credit path for profiles.diamonds. DR4 (a reference required on every positive credit) and the counterparty/issuance_class columns are Lane C.'),
    ('deduct_diamonds',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. THE debit path for profiles.diamonds; idempotent on reference_id, self-check on auth.uid. Owned by Lane C for the counterparty/issuance_class write.'),
    ('purchase_vip_with_diamonds_atomic',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. VIP sink, v1. Superseded by v2/v3; registered so the drift scan sees a declared name.'),
    ('purchase_vip_with_diamonds_atomic_v2',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. VIP sink, v2.'),
    ('purchase_vip_with_diamonds_atomic_v3',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. VIP sink, v3, the live one.'),
    ('purchase_merch_with_diamonds_atomic',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Merch sink.'),
    ('refund_diamond_merch_order_atomic',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Merch refund, credits diamonds back.'),
    ('fn_purchase_club_shop_item_diamonds',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Club shop sink.'),
    ('ca_promo_vault_buy',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Debits club_diamond_wallets for promo vault items. LOG-ONLY defect recorded as DR3:club_diamond_debit_unjournaled in the same migration: no journal row and no idempotency key. Journalling it is not this lane.'),
    ('fn_purchase_time_banks',
     'Diamond Accounting Standard Lane A (2026-09-03): time bank sink. Repaired in this migration from a body that raised 42703 on every call (it inserted into a nonexistent diamond_transactions.reason). Prices from feature_pricing, debits through deduct_diamonds with a deterministic reference, authenticated with an auth.uid self-check.'),
    ('fn_use_throwable',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Throwable sink.'),
    ('fn_reveal_rabbit_hunt',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Rabbit hunt sink.'),
    ('buy_streak_freeze',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Streak freeze sink.'),
    ('send_wallet_diamond_transfer',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Player to player diamond transfer, executable by authenticated. Keep or remove is Dan decision 6.4; the two-call route and the caps are Lane F.'),
    ('send_stream_gift',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Stream gift, executable by authenticated. Lane F.'),
    ('claim_daily_challenge',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Daily challenge earn, executable by authenticated. Budgets and per-user caps are Lane E.'),
    ('claim_daily_challenges',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Bulk daily challenge earn, executable by authenticated. Lane E.'),
    ('award_diamonds_v2',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. The reward catalog earn engine, the only budgeted door today. The FOR UPDATE lost-update fix and the per-engine budget lines are Lane E.'),
    ('fn_trivia_award_diamonds',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. Trivia earn. The tournament fee cut that reaches no player (DR14, burn by omission) is Lane E.'),
    ('handle_new_user',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. The signup grant, 500 diamonds written straight into the profile row. Routing it through the Mint and journalling it for horses and humans alike is Lane B.'),
    ('fn_ca_diamond_incident',
     'Diamond Accounting Standard Lane A (2026-09-03): inventory. The diamond incident recorder from the 2026-09-03 foundation. Moves no balance and never raises; registered so the shared interface is declared rather than looking unregistered.')
  ) AS v(proname, notes)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = v.proname
 );

-- ---------------------------------------------------------------------------
-- 4. fn_purchase_time_banks: repaired. It raises 42703 on every call today.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_purchase_time_banks(p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_caller     uuid := auth.uid();
  v_unit_cost  integer;
  v_total_cost integer;
  v_deduct     jsonb;
  v_reference  text;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Quantity is the only thing the client chooses, and it is bounded. The store
  -- presets are 1/10/25/100/500 and 500 is the ceiling (restored from 20260823).
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantity Must Be Between 1 And 500');
  END IF;

  -- DR8: one price oracle per sink. feature_pricing.time_bank_seconds is 5 diamonds.
  -- The regressed body hardcoded 2 and undercharged every buyer by 60 percent, which is
  -- academic only because the same body could not complete a single call.
  SELECT diamond_cost INTO v_unit_cost
    FROM feature_pricing WHERE feature = 'time_bank_seconds';
  IF v_unit_cost IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Time Bank Pricing Not Configured');
  END IF;

  v_total_cost := v_unit_cost * p_quantity;

  -- Deterministic within a one-second bucket, so a double-submit or a client retry of
  -- the same intent dedupes on the diamond_transactions UNIQUE (user_id, reference_id)
  -- index instead of charging twice.
  v_reference := 'tbank_' || v_caller::text || '_' || p_quantity::text || '_'
                 || extract(epoch from clock_timestamp())::bigint::text;

  IF v_total_cost > 0 THEN
    -- The debit goes through THE debit path (DR6). deduct_diamonds is service_role in its
    -- ACL, which is satisfied because this function is SECURITY DEFINER and owned by
    -- postgres; its own auth.uid() self-check still applies and passes because p_user_id
    -- is the caller. counterparty and issuance_class on the journal row are NOT set here:
    -- the journal is append-only, so a row cannot be amended after the fact, and
    -- deduct_diamonds belongs to Lane C. Lane C landed at 00:22 UTC on 2026-09-03 and
    -- deduct_diamonds now derives both columns itself, from p_source: this call yields
    -- issuance_class 'spend' and counterparty 'revenue:feature_purchase'.
    --
    -- WHY p_source STAYS 'feature_purchase' rather than becoming 'time_bank', which would
    -- have produced the more specific counterparty 'revenue:time_bank': p_source is also
    -- written to diamond_transactions.transaction_type, and the wallet UI maps that value
    -- to a label. src/components/wallet/DiamondWalletModal.tsx line 119 maps exactly
    -- 'feature_purchase', and the comment above it records that a previous release shipped
    -- a key no wallet map had and the row rendered unlabelled. Renaming the source to
    -- sharpen an accounting label would re-ship that bug. The sink stays identifiable on
    -- the row through the metadata below.
    v_deduct := deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_total_cost,
      p_description      := 'Time Banks x' || p_quantity,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object(
                              'feature', 'time_bank_seconds',
                              'quantity', p_quantity,
                              'unit_cost', v_unit_cost,
                              'sink', 'time_bank',
                              'counterparty', 'revenue:feature_purchase',
                              'issuance_class', 'spend'),
      p_reference_id     := v_reference
    );

    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'Diamond Charge Failed'),
        'required', v_total_cost);
    END IF;

    -- The charge was already applied under this reference by an earlier call, which means
    -- that call already granted the banks. Granting them again on a replay would hand out
    -- free time banks, so return the earlier outcome and insert nothing.
    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      RETURN jsonb_build_object(
        'success', true,
        'quantity', p_quantity,
        'unit_cost', v_unit_cost,
        'total_cost', v_total_cost,
        'idempotent', true,
        'diamonds_remaining', (v_deduct->>'balance')::integer);
    END IF;
  END IF;

  -- ONE consolidated row, kept from 20260824_consolidate_time_banks.sql. That migration
  -- regressed the pricing and the journal, but this part of it was a real fix: hundreds of
  -- single-use rows hit the PostgREST row limit in the client's loadEntitlements and the
  -- player's purchased time banks stopped showing. fn_time_bank_allowance and
  -- fn_consume_time_bank both read SUM(uses_remaining), so one row of N is exactly N of 1.
  INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES (v_caller, 'time_bank_seconds', v_total_cost, 'per_use', p_quantity, NULL);

  RETURN jsonb_build_object(
    'success', true,
    'quantity', p_quantity,
    'unit_cost', v_unit_cost,
    'total_cost', v_total_cost,
    -- "balance" is the key deduct_diamonds actually returns; reading "new_balance" here
    -- was the 2026-08-23 bug and it is not coming back.
    'diamonds_remaining', (v_deduct->>'balance')::integer);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_purchase_time_banks(integer) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_purchase_time_banks(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_purchase_time_banks(integer) TO service_role;

COMMENT ON FUNCTION public.fn_purchase_time_banks(integer) IS
  'Time bank sink. Prices from feature_pricing.time_bank_seconds, debits through deduct_diamonds with a deterministic reference (idempotent on replay, and the grant is skipped on a replay so a retry cannot mint free banks), writes one consolidated feature_purchases row. Repaired 2026-09-03: the previous body inserted into a nonexistent diamond_transactions.reason and raised 42703 on every call.';

-- ---------------------------------------------------------------------------
-- 5. fn_union_send_to_member_zd3core, kind = 'diamonds': LOG-ONLY.
--    The diamonds branch credits up to 100,000 diamonds per call and debits nothing
--    anywhere. That is an unfunded mint (DR2). Under Dan's risk rule it is recorded and
--    NOT refused: refusing here could block a legitimate union grant, and whether this
--    door is funded from a union diamond balance or removed outright is Dan's decision
--    6.6. Everything outside the diamonds branch is byte-identical to the live body.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_union_send_to_member_zd3core(p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric, p_source_wallet text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
declare
  v_actor      uuid := auth.uid();
  v_source     text;
  v_after      numeric;
  v_dia_after  numeric;
  v_club       uuid;
  v_role       text;
  v_is_club    boolean;
  v_agent_row  uuid;
  v_to_after   numeric;
  v_dest       text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if not public.fn_union_can_manage_wallets(p_union_id, v_actor) then
      return jsonb_build_object('success', false, 'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_kind not in ('chips','diamonds','promo') then
    return jsonb_build_object('success', false, 'error', 'kind must be chips, diamonds or promo');
  end if;

  /* ZERO-DRIFT round 2 (2026-08-31): duplicate-send suppression. An identical
     union send (union, recipient, kind, amount, actor) inside 20 seconds is a
     retry, not a second intent. */
  if p_kind in ('chips','promo') and exists (
      select 1 from union_wallet_transactions t
       where t.union_id = p_union_id
         and t.direction = 'debit'
         and t.amount = p_amount
         and t.tx_type in ('member_send','promo_member_send')
         and t.created_by is not distinct from v_actor
         and t.created_at > now() - interval '20 seconds') then
    return jsonb_build_object('success', true, 'duplicate_suppressed', true,
      'note', 'an identical send was recorded seconds ago; nothing moved twice');
  end if;

  select cm.club_id into v_club
    from club_members cm
   where cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
     and cm.club_id = public.fn_player_home_club(p_target_user_id, null)
     and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
   limit 1;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
     order by coalesce(cm.chip_balance, 0) desc, cm.club_id
     limit 1;
  end if;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id = p_union_id
     limit 1;
  end if;
  if v_club is null then
    return jsonb_build_object('success', false, 'error', 'That player is not a member of this union.');
  end if;
  v_is_club := exists (select 1 from clubs c where c.id = v_club);
  select cm.role into v_role from club_members cm
   where cm.club_id = v_club and cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
   limit 1;

  if p_kind = 'diamonds' then
    if p_amount <> floor(p_amount) then
      return jsonb_build_object('success', false, 'error', 'diamonds must be a whole number');
    end if;
    if p_amount > 100000 then
      return jsonb_build_object('success', false, 'error', 'maximum 100,000 diamonds per send');
    end if;
    /* DR2, LOG-ONLY (2026-09-03). This credit has no debit: no union diamond wallet is
       decremented, nothing is drawn from the Mint, and no budget is consumed. It creates
       diamonds out of nothing, up to 100,000 per call. It is RECORDED and allowed to
       proceed; refusing a live grant is Dan's call (decision 6.6, fund it or remove it). */
    perform public.fn_ca_diamond_incident(
      'DR2:union_diamond_grant_unfunded', 'warning', p_target_user_id, p_amount,
      'fn_union_send_to_member_zd3core',
      jsonb_build_object('union_id', p_union_id,
                         'source_wallet', p_source_wallet,
                         'club_id', v_club,
                         'actor', v_actor,
                         'note', 'diamonds credited with no debit on any wallet and no mint row; unfunded issuance'));
    update profiles set diamonds = coalesce(diamonds, 0) + p_amount
     where id = p_target_user_id
    returning diamonds into v_dia_after;
    if v_dia_after is null then
      return jsonb_build_object('success', false, 'error', 'player profile not found');
    end if;
    insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata, counterparty, issuance_class)
    values (p_target_user_id, 'credit', p_amount, v_dia_after,
            coalesce(p_note, 'Union grant'), 'union_grant', 'union',
            jsonb_build_object('union_id', p_union_id, 'granted_by', v_actor),
            'union:' || p_union_id::text, 'promotional');
    return jsonb_build_object('success', true, 'kind', 'diamonds', 'balance_after', v_dia_after);
  end if;

  /* ZERO-DRIFT round 2: the recipient-side credit journals ONE clean ledger
     row (union_wallet -> player/agent wallet); the union-side debit is
     autoskipped because union_wallet_transactions already records it and a
     second ledger row would double-post the flow. */
  perform set_config('app.ledger_category',
                     case when p_kind = 'promo' then 'promo_send' else 'union_send' end, true);
  perform set_config('app.ledger_counterparty', 'union_wallet', true);
  perform set_config('app.ledger_counterparty_entity', p_union_id::text, true);
  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
    update union_wallets
       set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
    if v_after is null then
      return jsonb_build_object('success', false, 'error', 'Insufficient promo wallet balance.');
    end if;

    if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
      v_dest := 'promo_float';
      v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
      if v_agent_row is null then
        raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
      end if;
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_row
       returning promo_wallet_balance into v_to_after;
    else
      v_dest := 'player_wallet';
      update club_members
         set chip_balance = coalesce(chip_balance, 0) + p_amount,
             updated_at = now()
       where club_id = v_club and user_id = p_target_user_id
       returning chip_balance into v_to_after;
    end if;
    if v_to_after is null then
      raise exception 'union promo credit landed nowhere for % in %', p_target_user_id, v_club;
    end if;

    insert into union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    values
      (p_union_id, case when v_is_club then v_club else null end,
       'promo_wallet', 'debit', p_amount, v_after, 'promo_member_send',
       coalesce(p_note, 'Union promo to member'), v_actor);
    if v_is_club then
      insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                     metadata)
      values (v_club, v_actor, p_target_user_id, p_amount, 'union_promo_send',
              coalesce(p_note, 'Union promo to member'), v_to_after,
              jsonb_build_object('union_id', p_union_id, 'destination', v_dest));
    end if;
    return jsonb_build_object('success', true, 'kind', 'promo', 'wallet_after', v_after,
                              'destination', v_dest, 'recipient_balance_after', v_to_after);
  end if;

  v_source := coalesce(p_source_wallet, 'chips');
  if v_source not in ('chips','rake','promo') then
    return jsonb_build_object('success', false, 'error', 'source wallet must be chips, rake or promo');
  end if;

  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
  elsif v_source = 'rake' then
    update union_wallets set rake_wallet = rake_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(rake_wallet, 0) >= p_amount
    returning rake_wallet into v_after;
  else
    update union_wallets set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
  end if;

  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'Insufficient balance in the selected union wallet.');
  end if;

  if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_dest := 'agent_wallet';
    v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
    if v_agent_row is null then
      raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_row
     returning agent_wallet_balance into v_to_after;
  else
    v_dest := 'player_wallet';
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = v_club and user_id = p_target_user_id
     returning chip_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'union chip credit landed nowhere for % in %', p_target_user_id, v_club;
  end if;

  insert into union_wallet_transactions
    (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
  values
    (p_union_id, case when v_is_club then v_club else null end,
     case v_source when 'chips' then 'chip_balance' when 'rake' then 'rake_wallet' else 'promo_wallet' end,
     'debit', p_amount, v_after, 'member_send',
     coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_actor);
  if v_is_club then
    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                   metadata)
    values (v_club, v_actor, p_target_user_id, p_amount, 'union_member_send',
            coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_to_after,
            jsonb_build_object('union_id', p_union_id, 'source_wallet', v_source, 'destination', v_dest));
  end if;

  return jsonb_build_object('success', true, 'kind', 'chips', 'source', v_source,
                            'wallet_after', v_after,
                            'destination', v_dest, 'recipient_balance_after', v_to_after);
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. ca_promo_vault_buy: LOG-ONLY. It debits club_diamond_wallets with no journal row
--    and no idempotency key. Recorded, not refused. Behaviour is otherwise unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ca_promo_vault_buy(p_club_id uuid, p_item_key text, p_quantity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_item    public.promo_vault_catalog%ROWTYPE;
  v_balance numeric;
  v_cost    bigint;
  v_qty     int;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Must Be Signed In To Buy Items.');
  END IF;

  IF NOT public.fn_promo_vault_can_manage(p_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only An Owner, Co-Owner Or Admin Can Buy For This Vault.'
    );
  END IF;

  v_qty := coalesce(p_quantity, 0);
  IF v_qty <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose At Least One Item.');
  END IF;
  IF v_qty > 999 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Can Buy At Most 999 At A Time.');
  END IF;

  SELECT * INTO v_item
  FROM public.promo_vault_catalog
  WHERE item_key = p_item_key AND is_active;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That Item Is No Longer Available.');
  END IF;

  v_cost := v_item.diamond_cost::bigint * v_qty;

  SELECT balance INTO v_balance
  FROM public.club_diamond_wallets
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'This Club Has No Diamond Wallet Yet.'
    );
  END IF;

  IF v_balance < v_cost THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Not Enough Diamonds. This Costs %s And The Club Holds %s.',
        to_char(v_cost, 'FM999G999G999'),
        to_char(floor(v_balance), 'FM999G999G999')
      ),
      'diamond_balance', v_balance
    );
  END IF;

  /* DR3, LOG-ONLY (2026-09-03). The debit below moves diamonds out of a club wallet and
     writes no diamond_transactions row, so the movement is invisible to the journal and to
     the trial balance; promo_vault_records is a receipt, not a ledger. There is also no
     idempotency key, so a double-submit debits twice. RECORDED, not refused: this is a live
     club purchase path and refusing it would block a legitimate spend. Journalling it and
     giving it a reference is Lane G work. */
  PERFORM public.fn_ca_diamond_incident(
    'DR3:club_diamond_debit_unjournaled', 'info', auth.uid(), v_cost::numeric,
    'ca_promo_vault_buy',
    jsonb_build_object('club_id', p_club_id,
                       'item_key', p_item_key,
                       'quantity', v_qty,
                       'diamond_cost', v_cost,
                       'balance_before', v_balance,
                       'note', 'club_diamond_wallets debited with no diamond_transactions row and no idempotency key'));

  UPDATE public.club_diamond_wallets
  SET balance              = balance - v_cost,
      total_withdrawn      = coalesce(total_withdrawn, 0) + v_cost,
      last_transaction_at  = now(),
      updated_at           = now()
  WHERE club_id = p_club_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.promo_vault_inventory (club_id, item_key, quantity)
  VALUES (p_club_id, p_item_key, v_qty)
  ON CONFLICT (club_id, item_key)
  DO UPDATE SET quantity   = public.promo_vault_inventory.quantity + EXCLUDED.quantity,
                updated_at = now()
  RETURNING quantity INTO v_qty;

  INSERT INTO public.promo_vault_records
    (club_id, item_key, action, quantity, diamonds_spent, actor_user_id)
  VALUES
    (p_club_id, p_item_key, 'purchase', p_quantity, v_cost, auth.uid());

  RETURN jsonb_build_object(
    'success', true,
    'error', NULL,
    'quantity', v_qty,
    'diamonds_spent', v_cost,
    'diamond_balance', v_balance
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Post-apply assertions. Each one aborts this migration if the thing it names
--    did not actually take.
-- ---------------------------------------------------------------------------

DO $assert$
DECLARE
  v_src text;
  v_missing int;
  v_names text[] := ARRAY[
    'fn_ca_burn','settle_diamond_card_purchase_atomic','reconcile_diamond_purchase_refund',
    'add_diamonds_to_balance','deduct_diamonds','purchase_vip_with_diamonds_atomic',
    'purchase_vip_with_diamonds_atomic_v2','purchase_vip_with_diamonds_atomic_v3',
    'purchase_merch_with_diamonds_atomic','refund_diamond_merch_order_atomic',
    'fn_purchase_club_shop_item_diamonds','ca_promo_vault_buy','fn_purchase_time_banks',
    'fn_use_throwable','fn_reveal_rabbit_hunt','buy_streak_freeze',
    'send_wallet_diamond_transfer','send_stream_gift','claim_daily_challenge',
    'claim_daily_challenges','award_diamonds_v2','fn_trivia_award_diamonds',
    'fn_union_send_to_member_zd3core','handle_new_user','fn_ca_diamond_incident'];
BEGIN
  -- DR10: the snapshot reads the canonical store once.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_diamond_snapshot';
  IF v_src LIKE '%v_prof + v_wal%' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot still adds the diamond_wallets mirror to the supply total';
  END IF;
  IF v_src NOT LIKE '%v_total := v_prof;%' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot does not set the total to the canonical profiles sum';
  END IF;
  IF v_src LIKE '%prev.total%' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot still compares against prev.total, which carries the old identity';
  END IF;
  IF v_src NOT LIKE '%DR10:mirror_mismatch%' THEN
    RAISE EXCEPTION 'fn_ca_diamond_snapshot does not record the mirror-equality figure';
  END IF;

  -- The diamond_wallets mirror leg upserts, and no profile is left without a row.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_diamond_side_tables_follow_profiles';
  IF v_src NOT LIKE '%INSERT INTO public.diamond_wallets%' THEN
    RAISE EXCEPTION 'the diamond_wallets mirror leg is still a bare UPDATE and cannot create a row';
  END IF;
  SELECT count(*) INTO v_missing
    FROM public.profiles p
   WHERE NOT EXISTS (SELECT 1 FROM public.diamond_wallets w WHERE w.user_id = p.id);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'the diamond_wallets backfill left % profile(s) without a mirror row', v_missing;
  END IF;

  -- The registry knows every diamond door.
  SELECT count(*) INTO v_missing
    FROM unnest(v_names) AS n(nm)
   WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = n.nm);
  IF v_missing > 0 THEN
    RAISE EXCEPTION '% diamond RPC(s) are still missing from ca_money_rpc_registry', v_missing;
  END IF;

  -- The Mint doors are shut to the browser.
  SELECT count(*) INTO v_missing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_ca_mint', 'fn_ca_burn')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'a browser role can still execute % Mint function(s)', v_missing;
  END IF;

  -- fn_purchase_time_banks compiles against columns that exist and prices from the oracle.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_purchase_time_banks';
  IF v_src LIKE '%amount, reason%' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks still inserts into the nonexistent diamond_transactions.reason column';
  END IF;
  IF v_src NOT LIKE '%feature_pricing%' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks does not read its price from feature_pricing';
  END IF;
  IF v_src NOT LIKE '%tbank_%' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks does not pass an idempotency reference';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.fn_purchase_time_banks(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_purchase_time_banks lost its grant to authenticated';
  END IF;

  -- The two log-only rules are wired.
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_union_send_to_member_zd3core';
  IF v_src NOT LIKE '%DR2:union_diamond_grant_unfunded%' THEN
    RAISE EXCEPTION 'the union diamonds branch does not record DR2:union_diamond_grant_unfunded';
  END IF;
  IF v_src NOT LIKE '%union:%' OR v_src NOT LIKE '%promotional%' THEN
    RAISE EXCEPTION 'the union diamonds branch does not name its counterparty and issuance class';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'ca_promo_vault_buy';
  IF v_src NOT LIKE '%DR3:club_diamond_debit_unjournaled%' THEN
    RAISE EXCEPTION 'ca_promo_vault_buy does not record DR3:club_diamond_debit_unjournaled';
  END IF;
END
$assert$;

COMMIT;
