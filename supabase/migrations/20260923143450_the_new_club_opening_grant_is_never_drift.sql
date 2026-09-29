-- 20260923143450_the_new_club_opening_grant_is_never_drift.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE NEW-CLUB OPENING GRANT IS NEVER DRIFT (Create A Club Phase 2, 2026-09-23)
--
-- The requirement: "Never classify the normal, declared new-club opening grant
-- as ledger drift." And: "The drift flow lock discussed by the owner is
-- specific to Midway Union. Do not globally force unrelated new-club mint
-- flows into Midway's drift classification."
--
-- THE GRANT. fn_seed_new_club_opening_bank (a BEFORE INSERT trigger on clubs;
-- it skips unions and every club whose asset is not chips) sets the new club's
-- treasury to 100,000 and declares the movement with fn_ca_declare_ledger:
-- category mint, counterparty issuance_reserve, idempotency key
-- 'club-opening-grant:<club id>'. The clubs auto-ledger journals it as
-- issuance_reserve -> club_treasury, and fn_record_new_club_opening_bank
-- registers it in ca_mint_ledger under the same key, linked to that journal
-- leg. Before 2026-09-03 the same grant journalled from system_mint.
--
-- DEFECT 1, the velocity watch. fn_ca_mint_velocity_watch summed EVERY row
-- from system_mint or issuance_reserve in the last ten minutes and, above
-- 250,000, raised with no entity dimension at all. fn_ca_is_midway_scope
-- treats a raise with no dimension as platform substrate and files it into
-- Midway's incident flow. So three new clubs inside ten minutes filed a
-- warning and eleven filed a critical, all of it the declared grant.
-- The watch now leaves the grant out of the sum, but ONLY in its exact declared
-- shape, never on a key prefix: the leg is category mint, from issuance_reserve
-- (or the older system_mint) to club_treasury, posted, exactly 100,000, lands
-- in the club it names (to_entity_id = club_id), carries exactly
-- 'club-opening-grant:' || that club, AND the mint register holds the row the
-- grant's own trigger wrote for it (same key, linked to that very leg, a mint
-- of 100,000 chips to that club). A leg short of any of it is still counted.
-- The grants that were left out are reported as metadata on any raise the
-- watch still makes (opening_grants_10m, opening_grant_chips_10m); they never
-- make one. Every other mint, the thresholds, the burn side, the dedupe keys,
-- the severities and the no-dimension raise itself are unchanged.
--
-- DEFECT 2, the duplicate-grant exemption. fn_ca_quick_reconcile (3f) and
-- fn_chip_integrity_report (ledger_write_failures) forgive a 23505 on
-- ux_chip_ledger_idempotency_key when the club's grant is already posted, but
-- they matched l.from_type = 'system_mint', so since 2026-09-03 the exemption
-- has been dead for every new club. The integrity report is not Midway scoped,
-- so a refused grant key on any new club read critical there. Both now accept
-- from_type IN ('system_mint', 'issuance_reserve'); nothing else in either
-- body moves.
--
-- WHAT IS NOT TOUCHED. fn_ca_is_midway_scope (Midway's drift lock) and
-- fn_ca_raise_drift_incident are not redefined, and the post-check below
-- proves their text is byte-identical after this file. The seeder, the
-- register writer and every balance are untouched: this file changes three
-- detector bodies and records two guard declarations, and moves no chip.
--
-- BASED ON THE LIVE DEFINITIONS, not on older files (the live
-- fn_ca_quick_reconcile carries a 2026-09-09 change to section 3g that no
-- CREATE OR REPLACE in this directory states). Read with pg_get_functiondef on
-- 2026-09-23 and asserted below before anything is replaced:
--   fn_ca_mint_velocity_watch()  md5(pg_get_functiondef) 925cb8e643ecf6fae94aefbd7c266e62
--   fn_ca_quick_reconcile()      md5(pg_get_functiondef) 99634ed56c884f968ec7d43de6f16f14
--   fn_chip_integrity_report()   md5(pg_get_functiondef) 9876f92ff02e9eef2b660660cc7d0ce1
-- Each replacement is that text with the substitutions described above and
-- nothing else. The post-images are asserted too, so a definition that is not
-- the reviewed one cannot commit.
--
-- THE GUARD REGISTRY. fn_ca_mint_velocity_watch and fn_ca_quick_reconcile are
-- on fn_ca_guard_watchlist(), so both redefinitions are DECLARED in this same
-- transaction (20260910143032_a_declared_guard_change_is_recorded_not_raised)
-- and fn_ca_guard_defs_watch has nothing to report. fn_chip_integrity_report
-- is not on the watchlist and is not declared. The pre-check refuses if either
-- stored baseline is not the live text, so no undeclared change is swallowed.
--
-- One transaction. No table DDL, no foreign key, no lock on a hot relation.
-- Apply outside the :50-:03 break window (CLAUDE.md DDL rule 8).
--
-- @live-proof: position('declared_opening_grant' in (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_ca_mint_velocity_watch()'))) > 0
-- @live-proof: position('l.from_type IN (''system_mint'', ''issuance_reserve'')' in (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_ca_quick_reconcile()'))) > 0
-- @live-proof: position('l.from_type IN (''system_mint'', ''issuance_reserve'')' in (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_chip_integrity_report()'))) > 0
-- The last proof reads ca_guard_def_history, which only grows and is keyed by
-- (proname, def_hash): the two declarations leave this file's post-images
-- there, and a later migration that declares its own redefinition of either
-- guard moves ca_guard_defs.declared_ref on without making this proof false.
-- @live-proof: (SELECT count(*) FROM public.ca_guard_def_history WHERE (proname, def_hash) IN (('fn_ca_mint_velocity_watch', '0d9601f47ad215035eaa01b7284c1cf4'), ('fn_ca_quick_reconcile', '1fa22b57be6709733e7b851aa1fb4005'))) = 2

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. The exact live definitions this file was written against, their owner,
--    grants and settings, one overload each, and baselines with no pending
--    undeclared change. Anything else refuses the whole transaction.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_mint_velocity_watch()')
       AND md5(p.prosrc) = '464d8c4e22aecfdb55ea9904afbc672c'
       AND md5(pg_get_functiondef(p.oid)) = '925cb8e643ecf6fae94aefbd7c266e62'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: fn_ca_mint_velocity_watch()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_quick_reconcile()')
       AND md5(p.prosrc) = '8d0481636ce78a0ee42a0d9d13212daf'
       AND md5(pg_get_functiondef(p.oid)) = '99634ed56c884f968ec7d43de6f16f14'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: fn_ca_quick_reconcile()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_chip_integrity_report()')
       AND md5(p.prosrc) = 'c412195fc62a335c6802ccf8cf54a01c'
       AND md5(pg_get_functiondef(p.oid)) = '9876f92ff02e9eef2b660660cc7d0ce1'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: fn_chip_integrity_report()';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_ca_mint_velocity_watch', 'fn_ca_quick_reconcile', 'fn_chip_integrity_report')) <> 3 THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: a second overload exists';
  END IF;
  IF (SELECT def_hash FROM public.ca_guard_defs WHERE proname = 'fn_ca_mint_velocity_watch')
       IS DISTINCT FROM '925cb8e643ecf6fae94aefbd7c266e62'
     OR (SELECT def_hash FROM public.ca_guard_defs WHERE proname = 'fn_ca_quick_reconcile')
       IS DISTINCT FROM '99634ed56c884f968ec7d43de6f16f14' THEN
    RAISE EXCEPTION 'OPENING_GRANT_BASELINE_DRIFT: a watched baseline is not the live text; an undeclared change is pending and must be reviewed first';
  END IF;
  -- The exclusion is written against what the grant's own triggers write.
  -- If either has moved, refuse rather than exclude a shape nothing writes.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_seed_new_club_opening_bank()')
       AND md5(pg_get_functiondef(p.oid)) = 'd926c3930f8737b9a708285c35f6828e') THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: fn_seed_new_club_opening_bank() is not the declared grant this file excludes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_record_new_club_opening_bank()')
       AND md5(pg_get_functiondef(p.oid)) = 'cef97b2c3914625761ee140736be52d5') THEN
    RAISE EXCEPTION 'OPENING_GRANT_PREIMAGE_DRIFT: fn_record_new_club_opening_bank() is not the register writer this file relies on';
  END IF;
  -- Midway's drift lock and the incident door, as they are now: the post-check
  -- proves this file leaves both byte-identical.
  PERFORM set_config('ca.opening_grant_midway_md5',
    md5(pg_get_functiondef(to_regprocedure('public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)'))), true);
  PERFORM set_config('ca.opening_grant_raise_md5',
    (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
       FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident'), true);
END $pre$;

-- 2. The velocity watch leaves the declared opening grant out of the sum.
CREATE OR REPLACE FUNCTION public.fn_ca_mint_velocity_watch()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_mint numeric; v_burn numeric; v_grants bigint; v_grant_chips numeric;
BEGIN
  /* THE NEW-CLUB OPENING GRANT IS NEVER DRIFT (2026-09-23). Creating a
     standalone chip club mints its declared 100,000-chip opening bank
     (fn_seed_new_club_opening_bank declares it, fn_record_new_club_opening_bank
     registers it). This sum had no entity dimension, so three new clubs
     inside ten minutes filed a warning and eleven a critical, and
     fn_ca_is_midway_scope files a raise with no dimension into Midway's own
     incident flow. A grant is left out ONLY in its exact declared shape:
     the journal leg issuance_reserve (system_mint before 2026-09-03) ->
     club_treasury, category mint, posted, exactly 100,000, landing in the
     club it names, keyed 'club-opening-grant:<that club>', AND linked from
     the mint register row the grant's own trigger wrote for that club and
     that amount. Short of all of it, the leg is still counted. What is
     left out rides along as metadata on any raise this watch still makes;
     it never makes one. */
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type IN ('system_mint','issuance_reserve')
                                          AND NOT g.declared_opening_grant), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.to_type   IN ('system_burn','chip_retirement')), 0),
         count(*) FILTER (WHERE g.declared_opening_grant),
         COALESCE(sum(l.amount) FILTER (WHERE g.declared_opening_grant), 0)
    INTO v_mint, v_burn, v_grants, v_grant_chips
    FROM public.chip_ledger l
    CROSS JOIN LATERAL (
      SELECT (l.category = 'mint'
          AND l.from_type IN ('issuance_reserve', 'system_mint')
          AND l.to_type = 'club_treasury'
          AND l.status = 'posted'
          AND l.amount = 100000
          AND l.to_entity_id = l.club_id
          AND l.idempotency_key = 'club-opening-grant:' || l.to_entity_id::text
          AND EXISTS (
            SELECT 1 FROM public.ca_mint_ledger m
             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.action = 'mint' AND m.asset = 'chips'
               AND m.holder_type = 'club' AND m.holder_id = l.to_entity_id
               AND m.amount = 100000)) IS TRUE AS declared_opening_grant
    ) g
   WHERE l.created_at > now() - interval '10 minutes';

  IF v_mint > 250000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance',
      CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END,
      'mint-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_mint, 250000, v_mint, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_mint, 2) || ' chips minted in 10 minutes, declared new-club opening grants not counted - far above the expected trickle; if this is not a deliberate batch (an epoch reset), a mint loop is running',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2),
                               'opening_grants_10m', v_grants,
                               'opening_grant_chips_10m', round(v_grant_chips,2)));
  END IF;

  IF v_burn > 1000000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance', 'warning',
      'burn-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_burn, 1000000, v_burn, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_burn, 2) || ' chips burned in 10 minutes - expected only during an epoch reset or a mass cleanup; verify the operation is deliberate',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2)));
  END IF;

  RETURN v_mint;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_mint_velocity_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_velocity_watch() TO service_role;

-- 3. The reconcile exemption accepts both declared counterparties (3f only).
CREATE OR REPLACE FUNCTION public.fn_ca_quick_reconcile()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD; n int := 0; v_frozen numeric; v_now numeric; v_left numeric;
BEGIN
  -- 3a. Negative balances (credit-line members are checked against their BOUND)
  FOR r IN
    SELECT 'player_wallet' AS pool, m.user_id AS entity_id, m.club_id, m.chip_balance AS amt,
           false AS ok
      FROM club_members m
     WHERE COALESCE(m.chip_balance,0) < 0
       AND COALESCE(m.chip_balance,0) < -COALESCE(m.credit_limit,0)
    UNION ALL
    SELECT 'club_treasury', c.id, c.id, c.chip_treasury, false FROM clubs c
     WHERE COALESCE(c.chip_treasury,0) < 0
    UNION ALL
    SELECT 'union_wallet', w.union_id, NULL, LEAST(w.chip_balance, w.rake_wallet, w.bbj_wallet,
           w.promo_wallet, w.insurance_wallet, COALESCE(w.spin_reserve_wallet,0)), false
      FROM union_wallets w
     WHERE LEAST(w.chip_balance, w.rake_wallet, w.bbj_wallet, w.promo_wallet,
                 w.insurance_wallet, COALESCE(w.spin_reserve_wallet,0)) < 0
    UNION ALL
    SELECT 'agent_wallet', a.user_id, a.club_id,
           LEAST(COALESCE(a.agent_wallet_balance,0), COALESCE(a.promo_wallet_balance,0)), false
      FROM agents a
     WHERE LEAST(COALESCE(a.agent_wallet_balance,0), COALESCE(a.promo_wallet_balance,0)) < 0
    UNION ALL
    SELECT 'bbj_pool', b.id, b.club_id,
           LEAST(b.main_balance, b.backup_balance, b.promo_balance), false
      FROM bbj_pools b
     WHERE LEAST(b.main_balance, b.backup_balance, b.promo_balance) < 0
    LIMIT 50
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:negative_balance',
      CASE WHEN r.pool = 'club_treasury' THEN 'treasury_error'
           WHEN r.pool = 'player_wallet' THEN 'credit_line_error'
           ELSE 'ledger_imbalance' END,
      CASE WHEN r.pool = 'club_treasury' THEN 'warning' ELSE 'critical' END,
      'qr:neg:' || r.pool || ':' || COALESCE(r.entity_id::text,'-') || ':' || CURRENT_DATE::text,
      abs(r.amt), 0, r.amt, 'ledger', r.pool, r.entity_id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      CASE WHEN r.pool = 'player_wallet'
           THEN 'player balance below the authorized credit-line bound'
           ELSE 'unauthorized negative balance in ' || r.pool END,
      NULL, '{}'::jsonb);
    n := n + 1;
  END LOOP;

  -- 3b. Frozen pool must not move
  SELECT frozen_total INTO v_frozen
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  -- The frozen pool is the PRE-FREEZE rows (verified: the 690 rows created
  -- before 2026-08-22 sum to the baseline exactly). Post-freeze rows belong
  -- to certification/test accounts whose harness chips cycle through the
  -- no-club fallback and are deleted by the certification cleanup - they are
  -- not the stranded pool and must not page anyone.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets
   WHERE created_at < '2026-08-22';
  -- 2026-09-02: a pre-freeze row can also LEAVE, because public.wallets
  -- cascades from profiles and auth.users and 188 pre-freeze rows belong to
  -- certification accounts that are torn down routinely. A deleted row is not
  -- a write, so add recorded departures back before comparing: an
  -- attributable teardown nets to zero, an unrecorded change still pages.
  SELECT COALESCE(SUM(deleted_balance), 0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  v_now := v_now + COALESCE(v_left, 0);
  IF v_frozen IS NOT NULL AND v_now <> v_frozen THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:frozen_pool', 'unauthorized_adjustment', 'critical',
      'qr:frozen_wallets:' || CURRENT_DATE::text,
      v_now - v_frozen, v_frozen, v_now, 'ledger', 'frozen_wallets_pool',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the dead public.wallets pool changed by an amount no recorded deletion explains - either a money path wrote to it, or a row left without the recording trigger firing',
      NULL, '{}'::jsonb);
    n := n + 1;
  END IF;

  -- 3c. Settlements stuck in flight (> 5 minutes)
  FOR r IN
    SELECT table_id, hand_id, first_attempt_at
      FROM settlement_idempotency_keys
     WHERE status = 'in_flight' AND last_attempt_at < now() - interval '5 minutes'
     LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:settlement_stuck', 'settlement_error', 'critical',
      'qr:stuck:' || r.table_id::text || ':' || COALESCE(r.hand_id::text,'-'),
      0, NULL, NULL, 'settlement', 'settlement_idempotency_keys', r.hand_id,
      NULL, NULL, r.table_id, NULL, r.hand_id,
      'hand:' || r.table_id::text, NULL, NULL,
      'settlement in_flight for more than 5 minutes (crashed mid-settlement?)',
      NULL, jsonb_build_object('first_attempt_at', r.first_attempt_at));
    n := n + 1;
  END LOOP;

  -- 3d. Union PnL settlements stuck in_progress (> 10 minutes) - the
  -- half-collected/half-paid trap the audit flagged.
  FOR r IN
    SELECT id, union_id, period_start
      FROM union_pnl_settlements
     WHERE status = 'in_progress'
       AND COALESCE(settled_at, period_end, now() - interval '1 day') < now() - interval '10 minutes'
     LIMIT 10
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:union_pnl_stuck', 'settlement_error', 'critical',
      'qr:pnl:' || r.id::text,
      0, NULL, NULL, 'settlement', 'union_pnl_settlements', r.id,
      NULL, r.union_id, NULL, NULL, NULL,
      'union_pnl:' || r.id::text, NULL, NULL,
      'union PnL settlement stuck in_progress - money may be half-collected/half-paid; resume or reconcile manually',
      NULL, jsonb_build_object('period_start', r.period_start));
    n := n + 1;
  END LOOP;

  -- 3e. Fresh unaccounted cash seat exits
  FOR r IN
    SELECT * FROM public.fn_unaccounted_seat_exits('30 minutes'::interval, '10 minutes'::interval)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:seat_exit', 'missing_payment', 'critical',
      'qr:seatexit:' || r.exit_id::text,
      -r.stack, r.stack, 0, 'ledger', 'seat_stack_exit', r.user_id,
      r.club_id, NULL, r.table_id, NULL, NULL, NULL, NULL, NULL,
      'seat exited with ' || r.stack || ' chips and no matching wallet credit',
      false, jsonb_build_object('exit_id', r.exit_id, 'exit_kind', r.exit_kind));
    n := n + 1;
  END LOOP;

  -- 3f. Ledger write failures
  -- The opening grant journals issuance_reserve -> club_treasury since
  -- 2026-09-03 and system_mint -> club_treasury before it. A refusal of its
  -- already-posted key is an idempotency refusal in either shape; matching
  -- system_mint alone left this exemption dead for every newer club
  -- (2026-09-23).
  FOR r IN
    SELECT * FROM public.ca_ledger_write_failures f
     WHERE f.occurred_at > now() - interval '10 minutes'
        AND public.fn_ca_is_midway_scope(NULL, f.club_id, NULL, NULL, '{}'::jsonb)
        AND NOT (
          f.sqlstate = '23505'
          AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
          AND EXISTS (
            SELECT 1 FROM public.chip_ledger l
             WHERE l.club_id = f.club_id
               AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
               AND l.category = 'mint' AND l.from_type IN ('system_mint', 'issuance_reserve')
               AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
               AND l.amount = 100000 AND l.status = 'posted'
          )
        )
     LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:ledger_write_failure', 'ledger_imbalance', 'critical',
      'qr:lwf:' || r.id::text,
      COALESCE(r.delta,0), NULL, NULL, 'ledger', 'ca_ledger_write_failures', r.user_id,
      r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a balance moved but its ledger row could not be written: ' || COALESCE(r.message,''),
      false, jsonb_build_object('sqlstate', r.sqlstate));
    n := n + 1;
  END LOOP;

  -- 3g. Unclassified (suspense) flow - info-severity daily rollup: it is a
  -- category-migration metric, not a discrepancy; the dashboard shows it.
  -- NET, NOT GROSS (2026-09-09): a chip that enters suspense and leaves it
  -- declared its counterparty on the way out. Counting both legs made a
  -- correction cancelling its own auto-ledger twin read as 720.00 of
  -- undeclared flow when it left nothing behind at all.
  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)
  HAVING abs(round(COALESCE(sum(CASE WHEN to_type = 'settlement_suspense' THEN amount ELSE -amount END), 0), 2)) > 1.00;
  IF FOUND THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:suspense_flow', 'unknown', 'info',
      'qr:suspense:' || CURRENT_DATE::text,
      (SELECT round(COALESCE(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),0),2)
         FROM public.chip_ledger
        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
          AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)),
      NULL, NULL, 'ledger', 'settlement_suspense', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      'suspense is holding chips it was not handed a counterparty for: this is the NET of what entered and left today, not the gross flow through it',
      true, '{}'::jsonb);
  END IF;

  RETURN n;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_quick_reconcile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_quick_reconcile() TO service_role;

-- 4. The integrity report's exemption, the same fix.
CREATE OR REPLACE FUNCTION public.fn_chip_integrity_report()
 RETURNS TABLE(check_name text, severity text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sev text; v_finding text; v_days integer;
  v_drift_rows bigint; v_worst numeric;
  v_fail bigint; v_exits bigint;
  v_frozen numeric; v_last_write timestamptz;
  v_free bigint; v_lost numeric;
  v_flag bigint; v_flag_chips numeric;
  v_base numeric; v_left numeric;
BEGIN
  SELECT l.severity, l.finding, l.silent_for_days INTO v_sev, v_finding, v_days
    FROM public.fn_ledger_liveness() l;
  check_name := 'ledger_liveness'; severity := v_sev; detail := v_finding;
  RETURN NEXT;

  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drift_rows, v_worst FROM public.fn_chip_drift_since_baseline() d;
  check_name := 'drift_since_baseline';
  severity   := CASE WHEN v_drift_rows = 0 THEN 'ok' WHEN v_worst <= 1 THEN 'warn' ELSE 'critical' END;
  detail     := format('%s member(s) drifting, worst %s. Baseline 2026-08-26.', v_drift_rows, round(v_worst,2));
  RETURN NEXT;

  -- Excludes the idempotency refusal, matching fn_ca_quick_reconcile 3f:
  -- the opening grant's refused key in either declared shape, issuance_reserve
  -- since 2026-09-03 or system_mint before it (2026-09-23).
  SELECT count(*) INTO v_fail
    FROM public.ca_ledger_write_failures f
   WHERE f.occurred_at > now() - interval '48 hours'
     AND NOT (
     f.sqlstate = '23505'
     AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
     AND EXISTS (
       SELECT 1 FROM public.chip_ledger l
        WHERE l.club_id = f.club_id
          AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
          AND l.category = 'mint' AND l.from_type IN ('system_mint', 'issuance_reserve')
          AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
          AND l.amount = 100000 AND l.status = 'posted'));
  check_name := 'ledger_write_failures';
  severity   := CASE WHEN v_fail = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s swallowed ledger write(s) in the last 48 hours (idempotency refusals of an already-posted grant excluded). Older ones stay in ca_ledger_write_failures; a closed episode must be able to age out or this check can never read ok again.', v_fail);
  RETURN NEXT;

  SELECT count(*) INTO v_exits FROM public.fn_unaccounted_seat_exits();
  check_name := 'unaccounted_seat_exits';
  severity   := CASE WHEN v_exits = 0 THEN 'ok' ELSE 'critical' END;
  detail     := format('%s seat exit(s) with a non-zero stack and no wallet credit.', v_exits);
  RETURN NEXT;

  SELECT count(*), COALESCE(sum(u.uncollected),0) INTO v_free, v_lost
    FROM public.fn_unpriced_tournaments('7 days') u;
  check_name := 'unpriced_tournaments';
  severity   := CASE WHEN v_free = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s COMPLETED tournament(s) in 7 days took a buy-in and earned no rake, ~%s uncollected.',
                       v_free, round(v_lost,2));
  RETURN NEXT;

  SELECT b.memberships, b.chips_held INTO v_flag, v_flag_chips
    FROM public.fn_bot_flag_disagreement() b;
  check_name := 'bot_flag_disagreement';
  severity   := CASE WHEN v_flag = 0 THEN 'ok' ELSE 'warn' END;
  detail     := format('%s membership(s) holding %s chips have club_members.is_bot disagreeing '
                       || 'with profiles.is_horse. Every is_bot-keyed report is wrong by this much.',
                       v_flag, round(v_flag_chips,2));
  RETURN NEXT;

  SELECT COALESCE(sum(balance),0), max(updated_at) FILTER (WHERE balance <> 0)
    INTO v_frozen, v_last_write FROM public.wallets;
  SELECT COALESCE(frozen_total, 732591994.33) INTO v_base
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  SELECT COALESCE(sum(deleted_balance),0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  check_name := 'legacy_wallets_frozen';
  severity   := CASE WHEN round(v_frozen + COALESCE(v_left,0), 2) <> round(COALESCE(v_base,0),2) THEN 'critical'
                     WHEN v_last_write > now() - interval '2 days' THEN 'critical'
                     ELSE 'ok' END;
  detail     := format('public.wallets holds %s chips plus %s recorded as having left, against a frozen baseline of %s. Last MONEY write %s. A zero-balance row created at signup is not a movement; a changed total is, and so is a row that cascaded away.',
                       round(v_frozen,2), round(COALESCE(v_left,0),2), round(COALESCE(v_base,0),2),
                       COALESCE(v_last_write::text,'never'));
  RETURN NEXT;
END;
$function$
;
REVOKE ALL ON FUNCTION public.fn_chip_integrity_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chip_integrity_report() TO service_role;

-- 5. Declared, not raised: both watched guards move their baselines here,
--    naming this file, so fn_ca_guard_defs_watch has nothing to report.
DO $declare$
DECLARE
  v_hash text;
BEGIN
  v_hash := public.fn_ca_declare_guard_redefinition(
    'fn_ca_mint_velocity_watch', 'migration 20260923143450_the_new_club_opening_grant_is_never_drift');
  IF v_hash IS DISTINCT FROM md5(pg_get_functiondef(to_regprocedure('public.fn_ca_mint_velocity_watch()'))) THEN
    RAISE EXCEPTION 'OPENING_GRANT_DECLARATION_REFUSED: fn_ca_mint_velocity_watch baseline % is not its definition', v_hash;
  END IF;
  v_hash := public.fn_ca_declare_guard_redefinition(
    'fn_ca_quick_reconcile', 'migration 20260923143450_the_new_club_opening_grant_is_never_drift');
  IF v_hash IS DISTINCT FROM md5(pg_get_functiondef(to_regprocedure('public.fn_ca_quick_reconcile()'))) THEN
    RAISE EXCEPTION 'OPENING_GRANT_DECLARATION_REFUSED: fn_ca_quick_reconcile baseline % is not its definition', v_hash;
  END IF;
END $declare$;

-- 6. The exact post-images (md5 computed on an isolated PostgreSQL 17 fixture
--    built from the live text), unchanged owner, grants and settings, the two
--    declarations in place, and Midway's lock and the incident door untouched.
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_mint_velocity_watch()')
       AND md5(p.prosrc) = '54e131e87868fcf8c5961e2454a282db'
       AND md5(pg_get_functiondef(p.oid)) = '0d9601f47ad215035eaa01b7284c1cf4'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_POSTIMAGE_DRIFT: fn_ca_mint_velocity_watch()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_ca_quick_reconcile()')
       AND md5(p.prosrc) = '6d5fce1d7f9dd09341801139b99c7e14'
       AND md5(pg_get_functiondef(p.oid)) = '1fa22b57be6709733e7b851aa1fb4005'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_POSTIMAGE_DRIFT: fn_ca_quick_reconcile()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure('public.fn_chip_integrity_report()')
       AND md5(p.prosrc) = 'fb3d87703bf7e5a93ae94ac2fe8e13cf'
       AND md5(pg_get_functiondef(p.oid)) = 'f87b9efb48d0bb8930358fabb7ebd870'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'OPENING_GRANT_POSTIMAGE_DRIFT: fn_chip_integrity_report()';
  END IF;
  IF (SELECT count(*) FROM public.ca_guard_defs g
       WHERE g.proname IN ('fn_ca_mint_velocity_watch', 'fn_ca_quick_reconcile')
         AND g.declared_ref = 'migration 20260923143450_the_new_club_opening_grant_is_never_drift'
         AND g.def_hash = CASE g.proname
               WHEN 'fn_ca_mint_velocity_watch' THEN '0d9601f47ad215035eaa01b7284c1cf4'
               ELSE '1fa22b57be6709733e7b851aa1fb4005' END) <> 2 THEN
    RAISE EXCEPTION 'OPENING_GRANT_DECLARATION_MISSING: a watched guard is not declared at its new definition';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_is_midway_scope(uuid,uuid,uuid,uuid,jsonb)')))
       IS DISTINCT FROM current_setting('ca.opening_grant_midway_md5', true)
     OR (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'fn_ca_raise_drift_incident')
       IS DISTINCT FROM current_setting('ca.opening_grant_raise_md5', true) THEN
    RAISE EXCEPTION 'OPENING_GRANT_MIDWAY_TOUCHED: the Midway drift lock or the incident door changed inside this file';
  END IF;
END $post$;

COMMIT;
