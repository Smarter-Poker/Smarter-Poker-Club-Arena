-- 20261004144112_the_misread_drift_accounts_are_rebaselined_on_the_live_repla.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MISREAD DRIFT ACCOUNTS ARE REBASELINED ON THE LIVE REPLAY FIX (chip
-- drift). Records only. Replaces 20261004125201, which required
-- 20261004124640; both were superseded before they ran, because another task
-- fixed the same two defects live first: 20261004123650 (a union rake
-- treasury leg names its wallet) and 20261004135607 (the ledger replay knows
-- which legs its snapshot saw). Those closed the six incidents and the
-- kill-switch alert; nothing here closes anything.
-- Full account: docs/changelog/2026-10-04-the-ledger-replay-sees-what-a-subtransaction-wrote.md.
--
-- The 2026-10-04 06:41 reading filed four accounts, none of them a lost chip:
--   union_wallet:fade0000...:union_wallets.rake_wallet   -1,489,348.47
--     (590 unlabelled rake payments, 1,489,358.47, plus 10.00 of rake whose
--     subtransaction straddled the 2026-10-01 06:47 reading)
--   player_wallet:70fa710b...:club_members.chip_balance        +190.00
--     (the prize leg of that same straddling transaction)
--   bbj_pool:a7a65cfc... promo -6.21 / promo_wallet:2a1132b9... promo +6.21
--     (06:40 promo sweep legs straddling the replay's own reading)
--
-- Their cumulatives are still stored, and the next reading carries a
-- cumulative forward: a same-sign interval is judged on it, so a -0.10 move
-- on the rake wallet tonight re-trips the kill switch at -1.49M. Each account
-- gets a fresh baseline: its balance and the snapshot it was read under, in
-- one statement, as the replay records a first reading. The transaction is
-- REPEATABLE READ and records what its snapshot saw in
-- ca_ledger_replay_readings, exactly as the replay does since 20261004135607,
-- so the next window judges a leg that straddles this baseline correctly.
-- No chips move.
--
-- @live-proof: (SELECT count(*) FROM public.ca_account_snapshots WHERE note LIKE 'rebaselined by 20261004144112%') = 4

BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE drift_misread (account_key text PRIMARY KEY, unexplained numeric NOT NULL, cum numeric NOT NULL, why text NOT NULL) ON COMMIT DROP;
INSERT INTO drift_misread VALUES
  ('union_wallet:fade0000-0000-0000-0000-000000000001:union_wallets.rake_wallet', -1489348.47, -1489348.23,
   'the reading of 2026-10-04 06:41 missed 1,489,358.47 of rakeback and retained share paid out of this wallet with no column label (fn_union_weekly_rakeback_close, fn_union_close_post_rake_debit, fn_accounting_legacy_pay_week and the 2026-10-03 overdue-commission funding) and 10.00 of tournament rake whose leg was inserted in a subtransaction straddling the 2026-10-01 06:47 reading'),
  ('player_wallet:70fa710b-3180-4ae4-98fd-95d4f9eb8d7c:club_members.chip_balance', 190.00, 190.00,
   'a 190.00 prize leg (2026-10-01 06:39:52, xmin 750498527) inserted in a subtransaction whose parent straddled the 2026-10-01 06:47 reading, so neither reading counted it'),
  ('bbj_pool:a7a65cfc-64e8-4134-afe5-68d3c1a86348:bbj_pools.promo_balance', -6.21, -8.33,
   'the 06:40 promo sweep legs (6.21 on 2026-10-01, xmin 750500000; 2026-09-30, xmin 710724517) were inserted in subtransactions straddling the replay''s own reading'),
  ('promo_wallet:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3:clubs.promo_balance', 6.21, 8.52,
   'the other side of the same promo sweep legs (6.21 on 2026-10-01, 2.31 on 2026-09-30), each inserted in a subtransaction straddling the replay''s own reading');

DO $pre$
BEGIN
  IF (SELECT count(*) FROM drift_misread d
        JOIN LATERAL (SELECT s.* FROM public.ca_account_snapshots s
                       WHERE s.account_key = d.account_key ORDER BY s.taken_at DESC LIMIT 1) s ON true
       WHERE s.taken_at = '2026-10-04 06:41:00.370541+00'
         AND s.unexplained = d.unexplained AND s.cum_unexplained = d.cum
         AND s.basis_version = 'one-snapshot-v4' AND NOT s.is_baseline) <> 4 THEN
    RAISE EXCEPTION 'DRIFT_REBASE_PREIMAGE_CHANGED: an account was read again since 06:41';
  END IF;
  IF to_regclass('public.ca_ledger_replay_readings') IS NULL
     OR position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) = 0
     OR position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) = 0
     OR position('''union_wallets.rake_wallet'') RETURNING id INTO v_ledger_id' in pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DRIFT_REBASE_FIX_NOT_INSTALLED: 20261004123650 and 20261004135607 must be live';
  END IF;
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'DRIFT_REBASE_NOT_REPEATABLE_READ';
  END IF;
  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE status = 'resolved'
         AND id IN ('30bf6669-3eaf-4fdc-a31c-7550b884b8b0', '18f578be-5223-4364-83a9-56599d1a9844',
                    'de1c3649-4a7e-4fee-84a9-75191f48ce08', 'c8a4dcb2-5c67-444c-a705-37865adea380',
                    'f972f5db-c9b3-4960-832b-d9a137dd867a', '89f91485-762f-4a00-bd68-138c6c598fb2')) <> 6
     OR (SELECT count(*) FROM public.financial_alerts
          WHERE id = '0884f538-bd16-4431-a426-a6132356d61c' AND resolved) <> 1 THEN
    RAISE EXCEPTION 'DRIFT_REBASE_PREIMAGE_CHANGED: the incidents were expected closed with the fix';
  END IF;
END
$pre$;

-- One statement: the balance and the snapshot it was read under, as the
-- replay records a first reading. The next 06:40 run judges from here.
INSERT INTO public.ca_account_snapshots
  (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
   is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
SELECT s.account_key, s.account_type, s.entity_id, s.club_id, s.column_name,
       public.fn_ca_account_balance(s.account_type, s.entity_id, s.club_id, s.column_name),
       clock_timestamp(), true, NULL, 0, 'one-snapshot-v4',
       'rebaselined by 20261004144112: ' || d.why || '. Not a lost chip; the reader was wrong, and 20261004123650 and 20261004135607 fix it.',
       pg_current_snapshot()::text
  FROM drift_misread d
  JOIN LATERAL (SELECT x.* FROM public.ca_account_snapshots x
                 WHERE x.account_key = d.account_key ORDER BY x.taken_at DESC LIMIT 1) s ON true;

-- What this snapshot saw, recorded as the replay records it (20261004135607),
-- so the next window treats a leg that straddles this baseline correctly.
INSERT INTO public.ca_ledger_replay_readings (read_snapshot, read_at, committed_legs)
SELECT pg_current_snapshot()::text, clock_timestamp(), COALESCE(array_agg(l.id ORDER BY l.id), '{}')
  FROM public.chip_ledger l
 WHERE l.created_at > now() - interval '30 minutes'
   AND public.fn_ca_xid8(l.xmin) >= pg_snapshot_xmin(pg_current_snapshot())
ON CONFLICT (read_snapshot) DO NOTHING;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.ca_account_snapshots
       WHERE note LIKE 'rebaselined by 20261004144112%' AND is_baseline AND cum_unexplained = 0
         AND balance IS NOT NULL AND read_snapshot = pg_current_snapshot()::text) <> 4
     OR NOT EXISTS (SELECT 1 FROM public.ca_ledger_replay_readings WHERE read_snapshot = pg_current_snapshot()::text) THEN
    RAISE EXCEPTION 'DRIFT_REBASE_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
