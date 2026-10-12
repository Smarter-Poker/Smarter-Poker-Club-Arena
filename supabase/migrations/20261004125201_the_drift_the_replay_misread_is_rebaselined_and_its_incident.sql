-- 20261004125201_the_drift_the_replay_misread_is_rebaselined_and_its_incident.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DRIFT THE REPLAY MISREAD IS REBASELINED AND ITS INCIDENTS CLOSE (chip
-- drift). Records only. Full account:
-- docs/changelog/2026-10-04-the-ledger-replay-sees-what-a-subtransaction-wrote.md.
-- Requires 20261004124640 (the payers name their column, the replay judges a
-- leg by the transaction that commits it).
--
-- The 2026-10-04 06:41 reading filed four accounts. Each residue is read back
-- to the legs that make it, and none is a lost chip:
--
--   union_wallet:fade0000...:union_wallets.rake_wallet   -1,489,348.47
--     = -1,489,358.47 of rakeback and retained share written with no column
--       label (590 legs, 2026-10-01 22:43 to 2026-10-03 10:25; the wallet's
--       own history debits exactly these amounts from rake_wallet)
--     + 10.00 tournament rake leg of 2026-10-01 06:39:52, xmin 750498599, a
--       subtransaction whose parent was still running at the 06:47 reading.
--   player_wallet:70fa710b...:club_members.chip_balance        +190.00
--     = the prize leg of that same transaction (xmin 750498527). The
--       member's own drift reading is 0.00 in all three clubs.
--   bbj_pool:a7a65cfc...:bbj_pools.promo_balance                -6.21
--   promo_wallet:2a1132b9...:clubs.promo_balance                +6.21
--     = one 06:40 promo sweep leg (xmin 750500000) that straddled the 06:47
--       reading the same way; 2.31 of the cumulative is the 2026-09-30
--       sweep (xmin 710724517) straddling that night's reading.
--
-- A reading cannot be re-judged after the fact, and the next reading would
-- carry these cumulatives forward (a same-sign interval is judged on the
-- cumulative). So each account gets a fresh baseline: its balance and the
-- snapshot it was read under, in one statement, exactly as the replay
-- records a first reading. The six incidents and the kill-switch alert close
-- with these root causes. No chips move.
--
-- @live-proof: (SELECT count(*) FROM public.ca_account_snapshots WHERE note LIKE 'rebaselined by 20261004125201%') = 4

BEGIN;
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
    RAISE EXCEPTION 'DRIFT_MISREAD_PREIMAGE_CHANGED: an account was read again since 06:41';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.chip_ledger'::regclass AND attname = 'top_xid')
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) IS DISTINCT FROM 'fddb201e23c57a4f1de95940325ea646' THEN
    RAISE EXCEPTION 'DRIFT_MISREAD_FIX_NOT_INSTALLED: apply 20261004124640 first';
  END IF;
  IF (SELECT count(*) FROM public.ca_drift_incidents
       WHERE status = 'open'
         AND id IN ('30bf6669-3eaf-4fdc-a31c-7550b884b8b0', '18f578be-5223-4364-83a9-56599d1a9844',
                    'de1c3649-4a7e-4fee-84a9-75191f48ce08', 'c8a4dcb2-5c67-444c-a705-37865adea380',
                    'f972f5db-c9b3-4960-832b-d9a137dd867a', '89f91485-762f-4a00-bd68-138c6c598fb2')) <> 6
     OR (SELECT count(*) FROM public.financial_alerts
          WHERE id = '0884f538-bd16-4431-a426-a6132356d61c' AND NOT resolved) <> 1 THEN
    RAISE EXCEPTION 'DRIFT_MISREAD_PREIMAGE_CHANGED: an incident moved';
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
       'rebaselined by 20261004125201: ' || d.why || '. Not a lost chip; the reader was wrong, and 20261004124640 fixes it.',
       pg_current_snapshot()::text
  FROM drift_misread d
  JOIN LATERAL (SELECT x.* FROM public.ca_account_snapshots x
                 WHERE x.account_key = d.account_key ORDER BY x.taken_at DESC LIMIT 1) s ON true;

DO $close$
DECLARE
  r record;
  v jsonb;
  c_fix CONSTANT text := 'migrations 20261004124640 (payers name the rake wallet; the replay judges a leg by top_xid) and 20261004125201 (rebaseline)';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('30bf6669-3eaf-4fdc-a31c-7550b884b8b0'::uuid,
     'Not a lost chip. union_wallets.rake_wallet moved -754,464.37; the keyed journal held only the 734,884.10 of rake in. The 590 payments out (1,446,346.26 rakeback to clubs and players, 43,012.21 retained share to the union bank, 2026-10-01 22:43 to 2026-10-03 10:25) were written with no from_label, so the replay counted them as unkeyable instead of against this wallet; union_wallet_transactions debits exactly those amounts from rake_wallet. The remaining +10.00 is a tournament rake leg (2026-10-01 06:39:52, xmin 750498599) inserted in a subtransaction whose parent straddled the 06:47 reading. -754,464.37 = 734,884.10 - 1,489,358.47 + 10.00.'),
    ('18f578be-5223-4364-83a9-56599d1a9844'::uuid,
     'The kill switch read the replay''s -1,489,348.47 on Midway''s rake wallet, which is the unlabelled payments described on incident 30bf6669 plus 10.00 of straddled rake. No chip left the estate and no freeze was warranted.'),
    ('de1c3649-4a7e-4fee-84a9-75191f48ce08'::uuid,
     'Mirror of financial alert 0884f538 (the kill switch on the ledger replay); closed with it. Root cause on incident 30bf6669.'),
    ('c8a4dcb2-5c67-444c-a705-37865adea380'::uuid,
     'Not a lost chip. The +190.00 is the prize leg of 2026-10-01 06:39:52 (xmin 750498527), inserted in a subtransaction whose parent was still running at the 06:47 reading: pg_visible_in_snapshot judged the subtransaction id visible, so the next window excluded it, and the reading itself could not see it. The member''s own drift (fn_chip_drift_since_baseline) is 0.00 in all three of his clubs.'),
    ('f972f5db-c9b3-4960-832b-d9a137dd867a'::uuid,
     'Not a lost chip. The 06:40 promo sweep runs in the same minute as the replay; its legs (6.21 on 2026-10-01, xmin 750500000, and the 2026-09-30 one, xmin 710724517) were inserted in subtransactions that straddled the reading, so neither reading counted them. The club promo bank on the other side of the same legs reads the mirror (+6.21, incident 89f91485).'),
    ('89f91485-762f-4a00-bd68-138c6c598fb2'::uuid,
     'Not a lost chip. The other side of the straddled 06:40 promo sweep legs on incident f972f5db: +6.21 (2026-10-01) and +2.31 (2026-09-30), each inserted in a subtransaction that straddled the replay''s reading.')
  ) AS t(id, root) LOOP
    v := public.fn_ca_incident_action(r.id, 'resolve',
           'No chips moved to close this. The reader was wrong, the payers and the reader are fixed, and the account is rebaselined.',
           NULL, r.root, c_fix);
    IF COALESCE((v->>'ok')::boolean, true) IS NOT TRUE THEN
      RAISE EXCEPTION 'DRIFT_MISREAD_CLOSE_REFUSED: % %', r.id, v;
    END IF;
  END LOOP;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(),
         resolution = 'Closed by 20261004125201_the_drift_the_replay_misread_is_rebaselined_and_its_incident. Not a leak: the replay could not key 1,489,358.47 of rakeback and retained share paid from Midway''s rake wallet without a column label, and missed 10.00 of rake inserted in a subtransaction that straddled the previous reading. Fixed at the payers and the reader in 20261004124640; the account is rebaselined. No chips moved.'
   WHERE id = '0884f538-bd16-4431-a426-a6132356d61c' AND NOT resolved;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRIFT_MISREAD_PREIMAGE_CHANGED: the kill-switch alert moved';
  END IF;
END
$close$;

DO $post$
BEGIN
  IF (SELECT count(*) FROM public.ca_account_snapshots WHERE note LIKE 'rebaselined by 20261004125201%' AND is_baseline AND cum_unexplained = 0 AND balance IS NOT NULL) <> 4
     OR (SELECT count(*) FROM public.ca_drift_incidents
          WHERE status = 'resolved'
            AND id IN ('30bf6669-3eaf-4fdc-a31c-7550b884b8b0', '18f578be-5223-4364-83a9-56599d1a9844',
                       'de1c3649-4a7e-4fee-84a9-75191f48ce08', 'c8a4dcb2-5c67-444c-a705-37865adea380',
                       'f972f5db-c9b3-4960-832b-d9a137dd867a', '89f91485-762f-4a00-bd68-138c6c598fb2')) <> 6 THEN
    RAISE EXCEPTION 'DRIFT_MISREAD_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
