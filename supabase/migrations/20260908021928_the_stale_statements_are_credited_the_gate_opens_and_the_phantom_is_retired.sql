BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 6 OF 8 (UNION ACCOUNTING) - THE THREE DECISIONS, 2026-09-08. PART 2 OF 2.
   Decisions 2 and 3 of the previous migration's header (the two stale
   statements credited and the gate opened; the phantom treasury credits
   retired). Rehearsed in full and rolled back at 02:12 UTC: 1,171 / 3,245.35
   and 239 / 442.70 re-measured exactly, both burns accepted by fn_ca_burn, the
   union bank ended where it started, and fn_union_age_invoices run against the
   opened gate sent nothing. */

/* 2. the two stale statements, credited in full - BEFORE the gate opens */
DO $credit$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_inv record; v_r jsonb; v_n int := 0;
BEGIN
  FOR v_inv IN
    SELECT si.id, si.invoice_number, si.net_amount, si.club_id, si.breakdown->>'club_name' AS club_name
      FROM public.settlement_invoices si
     WHERE si.invoice_type = 'union_weekly_squareup'
       AND (si.breakdown->>'union_id')::uuid = v_union
       AND si.invoice_number IN ('MIDWAY-2026-000001', 'MIDWAY-2026-000002')
       AND si.status = 'overdue'
     ORDER BY si.invoice_number
  LOOP
    IF (v_inv.invoice_number = 'MIDWAY-2026-000001' AND v_inv.net_amount <> 7531.11)
       OR (v_inv.invoice_number = 'MIDWAY-2026-000002' AND v_inv.net_amount <> 220615.68) THEN
      RAISE EXCEPTION 'statement % carries % - not the figure this was written against', v_inv.invoice_number, v_inv.net_amount;
    END IF;
    IF public.fn_union_invoice_outstanding(v_inv.id) <> v_inv.net_amount THEN
      RAISE EXCEPTION 'statement % has already been partly credited', v_inv.invoice_number;
    END IF;
    v_r := public.fn_union_issue_credit_note(
      v_inv.id, v_inv.net_amount,
      'Credited in full (Phase 6 of the union accounting rebuild, 2026-09-08). This statement''s '
      || 'ECO square-up for the week of 2026-08-10 was computed on a rake basis that attributed '
      || 'every player''s rake to the club they joined first, which no ruling supports, and on a '
      || 'club-cash-profit figure the platform cannot reproduce on the data it holds (rake '
      || 'attribution was not correct until 2026-09-02). The union starts its books clean from '
      || 'the week of 2026-09-07 (settlement floor, Dan 2026-09-02); nothing is owed on this statement.',
      true);
    IF COALESCE((v_r->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'credit note for % failed: %', v_inv.invoice_number, v_r;
    END IF;
    IF public.fn_union_invoice_outstanding(v_inv.id) <> 0 THEN
      RAISE EXCEPTION 'statement % still shows outstanding %', v_inv.invoice_number, public.fn_union_invoice_outstanding(v_inv.id);
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected to credit exactly 2 statements, found %', v_n; END IF;
END $credit$;

/* the gate opens onto zero outstanding */
UPDATE public.unions
   SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('weekly_invoices_enabled', 1)
 WHERE id = 'fade0000-0000-0000-0000-000000000001';

/* 3. the phantom, re-measured and retired */
DO $burn$
DECLARE
  v_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  v_ds    constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_actor constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_union_phantom numeric; v_union_twins int; v_ds_phantom numeric; v_ds_twins int;
  v_rw numeric; v_cb numeric; v_rw0 numeric; v_cb0 numeric; v_r jsonb;
BEGIN
  -- the union: both calls credited rake_wallet (matched by each call's own created_at and amount)
  WITH n AS (
    SELECT id, club_id, rake_amount, created_at, table_id, metadata->>'hand_number' AS hn
      FROM public.rake_records
     WHERE hand_id IS NULL AND NOT is_tournament AND metadata->>'hand_number' IS NOT NULL
       AND created_at >= '2026-07-30' AND (metadata->>'hand_number')::bigint >= 1000000
  ), twin AS (
    SELECT n.id, n.club_id, n.rake_amount, n.created_at, min(l.created_at) AS lcreated
      FROM n JOIN public.rake_records l
        ON l.table_id = n.table_id AND l.hand_id IS NOT NULL AND l.metadata->>'hand_number' = n.hn
     GROUP BY 1, 2, 3, 4
  ), cr AS (
    SELECT t.*
      FROM twin t JOIN public.clubs c ON c.id = t.club_id
     WHERE c.union_id = v_union
       AND EXISTS (SELECT 1 FROM public.union_wallet_transactions w
                    WHERE w.union_id = v_union AND w.club_id = t.club_id AND w.wallet = 'rake_wallet'
                      AND w.direction = 'credit' AND w.tx_type = 'rake'
                      AND w.created_at = t.created_at AND w.amount = t.rake_amount)
       AND EXISTS (SELECT 1 FROM public.union_wallet_transactions w
                    WHERE w.union_id = v_union AND w.club_id = t.club_id AND w.wallet = 'rake_wallet'
                      AND w.direction = 'credit' AND w.tx_type = 'rake'
                      AND w.created_at = t.lcreated)
  )
  SELECT count(*), round(COALESCE(sum(rake_amount), 0), 2) INTO v_union_twins, v_union_phantom FROM cr;

  -- Deep Stack Society: both calls journalled a rake leg into the treasury
  WITH n AS (
    SELECT id, club_id, rake_amount, created_at, table_id, metadata->>'hand_number' AS hn
      FROM public.rake_records
     WHERE hand_id IS NULL AND NOT is_tournament AND metadata->>'hand_number' IS NOT NULL
       AND created_at >= '2026-07-30' AND (metadata->>'hand_number')::bigint >= 1000000
       AND club_id = v_ds
  ), twin AS (
    SELECT n.id, n.club_id, n.rake_amount, n.created_at, min(l.created_at) AS lcreated
      FROM n JOIN public.rake_records l
        ON l.table_id = n.table_id AND l.hand_id IS NOT NULL AND l.metadata->>'hand_number' = n.hn
     GROUP BY 1, 2, 3, 4
  ), cr AS (
    SELECT t.* FROM twin t
     WHERE EXISTS (SELECT 1 FROM public.chip_ledger w WHERE w.club_id = t.club_id AND w.to_type = 'club_treasury'
                     AND w.category = 'rake' AND w.created_at = t.created_at AND w.amount = t.rake_amount)
       AND EXISTS (SELECT 1 FROM public.chip_ledger w WHERE w.club_id = t.club_id AND w.to_type = 'club_treasury'
                     AND w.category = 'rake' AND w.created_at = t.lcreated)
  )
  SELECT count(*), round(COALESCE(sum(rake_amount), 0), 2) INTO v_ds_twins, v_ds_phantom FROM cr;

  IF v_union_twins <> 1171 OR v_union_phantom <> 3245.35 THEN
    RAISE EXCEPTION 'the union phantom moved: % twins / % (written against 1,171 / 3,245.35) - re-measure', v_union_twins, v_union_phantom;
  END IF;
  IF v_ds_twins <> 239 OR v_ds_phantom <> 442.70 THEN
    RAISE EXCEPTION 'the Deep Stack phantom moved: % twins / % (written against 239 / 442.70) - re-measure', v_ds_twins, v_ds_phantom;
  END IF;

  -- the burn door authenticates as the service role; the claim is transaction-local
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 3a. union: rake_wallet -> bank, the way the weekly close moves the retained share
  SELECT round(rake_wallet, 2), round(chip_balance, 2) INTO v_rw0, v_cb0 FROM public.union_wallets WHERE union_id = v_union FOR UPDATE;
  IF v_rw0 < v_union_phantom THEN RAISE EXCEPTION 'rake_wallet % cannot cover %', v_rw0, v_union_phantom; END IF;
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'union_bank', v_union, NULL,
                                      'phase6:ghost-twin-phantom:union:transfer', ARRAY['union_wallets']);
  UPDATE public.union_wallets
     SET rake_wallet = rake_wallet - v_union_phantom,
         chip_balance = chip_balance + v_union_phantom,
         updated_at = now()
   WHERE union_id = v_union
   RETURNING round(rake_wallet, 2), round(chip_balance, 2) INTO v_rw, v_cb;
  INSERT INTO public.union_wallet_transactions (union_id, amount, tx_type, wallet, direction, balance_after, notes)
  VALUES
    (v_union, v_union_phantom, 'rake_hold', 'rake_wallet', 'debit', v_rw,
     'Phantom rake out of the rake treasury: 1,171 ghost-twin hands credited twice (2026-08-20..2026-09-07); retired via fn_ca_burn'),
    (v_union, v_union_phantom, 'rake_hold', 'chip_balance', 'credit', v_cb,
     'Phantom rake into the bank for retirement: 1,171 ghost-twin hands credited twice (2026-08-20..2026-09-07)');
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, to_type, to_entity_id, amount, category, union_id, description, idempotency_key, metadata)
  VALUES
    (v_actor, 'union_wallet', v_union, 'union_bank', v_union, v_union_phantom, 'treasury_transfer', v_union,
     'Phase 6: phantom rake (1,171 ghost-twin hands, each credited to the rake treasury twice) moved to the bank for retirement',
     'phase6:ghost-twin-phantom:union:transfer',
     jsonb_build_object('twins', v_union_twins, 'phantom', v_union_phantom, 'window', '2026-08-20..2026-09-07',
                        'root_fix', '20260907195116 + the (table, hand number) dedupe of 2026-09-06'));
  PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  v_r := public.fn_ca_burn('chips', 'union', v_union, v_union_phantom,
    'Phase 6 (2026-09-08): phantom rake retired - 1,171 ghost-twin cash hands credited the Midway Union rake treasury twice between 2026-08-20 and 2026-09-07 (3,245.35 that no pot ever paid); read by matching both credit rows per hand',
    'phase6:ghost-twin-phantom:union:' || v_union::text, 'admin');
  IF COALESCE((v_r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'union burn refused: %', v_r;
  END IF;
  IF round((v_r->>'balance_after')::numeric, 2) <> v_cb0 THEN
    RAISE EXCEPTION 'the union bank should end where it started (%), it ended at %', v_cb0, v_r->>'balance_after';
  END IF;

  -- 3b. Deep Stack Society: straight from the treasury through the door
  v_r := public.fn_ca_burn('chips', 'club', v_ds, v_ds_phantom,
    'Phase 6 (2026-09-08): phantom rake retired - 239 ghost-twin cash hands credited the Deep Stack Society treasury twice between 2026-09-02 and 2026-09-07 (442.70 that no pot ever paid); read by matching both journal legs per hand',
    'phase6:ghost-twin-phantom:club:' || v_ds::text, 'admin');
  IF COALESCE((v_r->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Deep Stack burn refused: %', v_r;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
  VALUES ('warning', 'atomic_distribute_rake.ghost_twin_phantom_retired',
    'Ghost-twin phantom rake retired: Midway Union rake treasury 3,245.35 (1,171 hands credited twice, 2026-08-20..2026-09-07) and Deep Stack Society treasury 442.70 (239 hands, 2026-09-02..2026-09-07). Supply no pot ever paid, in treasuries, not player balances.',
    jsonb_build_object('union', jsonb_build_object('union_id', v_union, 'twins', v_union_twins, 'phantom', v_union_phantom,
                                                   'transfer_key', 'phase6:ghost-twin-phantom:union:transfer',
                                                   'burn_op_id', 'phase6:ghost-twin-phantom:union:' || v_union::text),
                       'club', jsonb_build_object('club_id', v_ds, 'twins', v_ds_twins, 'phantom', v_ds_phantom,
                                                  'burn_op_id', 'phase6:ghost-twin-phantom:club:' || v_ds::text),
                       'method', 'both credit rows matched per twin (created_at + amount of the twin''s own call, created_at of the linked row''s call)'),
    true, now(),
    'Retired through fn_ca_burn (keyed chip_retirement legs, ca_mint_ledger rows). The union''s share moved rake_wallet -> bank first with the weekly close''s own two-row transfer. Root cause closed by 20260907195116 (engine mints the hand id) and the 2026-09-06 (table, hand number) dedupe.');
END $burn$;

DO $assert$
BEGIN
  IF public.fn_union_setting('fade0000-0000-0000-0000-000000000001', 'weekly_invoices_enabled', 1) <> 1 THEN
    RAISE EXCEPTION 'weekly_invoices_enabled did not open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.settlement_invoices si WHERE si.invoice_number IN ('MIDWAY-2026-000001', 'MIDWAY-2026-000002')
              AND public.fn_union_invoice_outstanding(si.id) <> 0) THEN
    RAISE EXCEPTION 'a stale statement still carries an outstanding balance';
  END IF;
  IF (SELECT count(*) FROM public.ca_mint_ledger WHERE op_id LIKE 'phase6:ghost-twin-phantom:%' AND action = 'burn') <> 2 THEN
    RAISE EXCEPTION 'expected two retirement rows in ca_mint_ledger';
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key IN ('phase6:ghost-twin-phantom:union:transfer',
        'burn:phase6:ghost-twin-phantom:union:fade0000-0000-0000-0000-000000000001',
        'burn:phase6:ghost-twin-phantom:club:2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')) <> 3 THEN
    RAISE EXCEPTION 'expected three journal legs for the retirement';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE chip_treasury < 0) OR EXISTS (SELECT 1 FROM public.union_wallets WHERE rake_wallet < 0 OR chip_balance < 0) THEN
    RAISE EXCEPTION 'a treasury went negative';
  END IF;
END $assert$;

COMMIT;
