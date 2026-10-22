-- Fixture rows for the hourly sweep qualification. Every time is relative to
-- now(), so the six-hour horizon, the 24-hour liveness window, the seven-day
-- seat-exit window, the three-day payout window and the 24-hour prize window
-- each have rows on both sides.
DO $data$
DECLARE
  c1 uuid := 'c1000000-0000-0000-0000-000000000001';
  c2 uuid := 'c2000000-0000-0000-0000-000000000002';
  u1 uuid := '00000000-0000-0000-0000-0000000000a1';
  u2 uuid := '00000000-0000-0000-0000-0000000000a2';
  u3 uuid := '00000000-0000-0000-0000-0000000000a3';
  horse uuid := '00000000-0000-0000-0000-0000000000b1';
  p0 uuid := 'b0000000-0000-0000-0000-000000000000';
  p1 uuid := 'b0000000-0000-0000-0000-000000000001';
  p2 uuid := 'b0000000-0000-0000-0000-000000000002';
  p3 uuid := 'b0000000-0000-0000-0000-000000000003';
  epoch timestamptz := now() - interval '18 days';
  t0 timestamptz := now() - interval '20 days';
  i int;
BEGIN
  -- Members and their opening balances (a horse is a member like any other).
  INSERT INTO public.ca_chip_baseline VALUES
    (c1, u1, 1000, 0, 0, t0), (c1, u2, 500, 0, 0, t0 + interval '1 hour'),
    (c1, horse, 2000, 0, 0, t0), (c2, u1, 300, 0, 0, t0), (c2, u3, 0, 0, 0, t0);
  INSERT INTO public.club_members (club_id, user_id, chip_balance, updated_at) VALUES
    (c1, u1, 1105.50, now() - interval '2 days'), (c1, u2, 470, now() - interval '3 hours'),
    (c1, horse, 1990.25, now() - interval '30 days'), (c2, u1, 300, now() - interval '30 days'),
    (c2, u3, 12.34, now() - interval '1 hour'), (c2, u2, 99, now());

  -- Player wallet legs on every side of the baseline and of the horizon.
  INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at) VALUES
    ('club_treasury', c1, 'player_wallet', u1, 50, 'transfer', c1, t0 - interval '1 day'),
    ('club_treasury', c1, 'player_wallet', u1, 100, 'transfer', c1, t0),
    ('club_treasury', c1, 'player_wallet', u1, 5.50, 'transfer', c1, now() - interval '15 days'),
    ('player_wallet', u2, 'player_wallet', u1, 20, 'rakeback', c1, now() - interval '9 days'),
    ('player_wallet', u1, 'table_stack', NULL, 20, 'buyin', c1, now() - interval '7 hours'),
    ('table_stack', NULL, 'player_wallet', horse, 10.25, 'cashout', c1, now() - interval '6 hours 30 seconds'),
    ('player_wallet', horse, 'table_stack', NULL, 20, 'buyin', c1, now() - interval '5 hours 59 minutes'),
    ('player_wallet', u2, 'table_stack', NULL, 10, 'buyin', c1, now() - interval '2 hours'),
    ('club_treasury', c2, 'player_wallet', u3, 12.34, 'transfer', c2, now() - interval '30 minutes'),
    ('club_treasury', c2, 'player_wallet', u3, 7, 'transfer', NULL, now() - interval '3 days'),
    ('club_treasury', c2, 'player_wallet', NULL, 7, 'transfer', c2, now() - interval '3 days'),
    ('player_wallet', u1, 'club_treasury', c2, 1, 'transfer', c2, now() - interval '12 days'),
    ('club_treasury', c2, 'player_wallet', u1, 1, 'transfer', c2, now() - interval '12 days');

  -- BBJ: the original pool, a pool opened after the epoch, a later pool not
  -- yet opened, and a pool created before the epoch that was never opened.
  INSERT INTO public.bbj_pools (id, club_id, created_at, main_balance, backup_balance, promo_balance, total_paid_out, pool_amount, merged_into_pool_id) VALUES
    (p0, NULL, epoch - interval '30 days', 900, 50, 25, 71749.31, 1000, NULL),
    (p1, c1, now() - interval '10 days', 140, 10, 0, 0, 100, NULL),
    (p2, c2, now() - interval '2 hours', 100, 0, 0, 0, 100, NULL),
    (p3, c2, epoch - interval '5 days', 0, 0, 0, 0, 0, p0);
  INSERT INTO public.ca_bbj_pool_snapshots (pool_id, taken_at, is_baseline, main, backup, promo) VALUES
    (p0, epoch, true, 800, 40, 20), (p1, now() - interval '10 days' + interval '1 minute', true, 100, 0, 0),
    (p0, now() - interval '1 day', false, 0, 0, 0);
  INSERT INTO public.bbj_conservation_baseline VALUES (1, 70000, 1.00, now(), 'fixture', 3.21, 71000, 1000, 0.5);
  INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, created_at) VALUES
    ('table_stack', NULL, 'bbj_pool', p0, 1.00, 'bbj_contribution', c1, epoch),
    ('bbj_pool', p0, 'player_wallet', u1, 40, 'bbj_payout', c1, now() - interval '17 days'),
    ('bbj_pool', p0, 'promo_wallet', NULL, 5, 'promo', c1, now() - interval '16 days'),
    ('system_mint', NULL, 'bbj_pool', p1, 100, 'bbj_seed', c1, now() - interval '10 days'),
    ('table_stack', NULL, 'bbj_pool', p1, 2.50, 'bbj_contribution', c1, now() - interval '10 days' + interval '1 minute'),
    ('table_stack', NULL, 'bbj_pool', p1, 3.50, 'bbj_contribution', c1, now() - interval '8 days'),
    ('system_mint', NULL, 'bbj_pool', p1, 30, NULL, c1, now() - interval '7 days'),
    ('bbj_pool', p1, 'system_burn', NULL, 1.25, 'bbj_burn', c1, now() - interval '6 days'),
    ('bbj_pool', p1, 'bbj_pool', p1, 4, 'bbj_rebalance', c1, now() - interval '6 hours 10 seconds'),
    ('bbj_pool', p1, 'player_wallet', u2, 2, 'bbj_payout', c1, now() - interval '5 hours'),
    ('system_mint', NULL, 'bbj_pool', p2, 100, 'bbj_seed', c2, now() - interval '2 hours'),
    ('table_stack', NULL, 'bbj_pool', NULL, 0.75, 'bbj_contribution', c2, now() - interval '9 days'),
    ('system_mint', NULL, 'bbj_pool', p3, 9, 'bbj_seed', c2, now() - interval '4 days'),
    ('bbj_pool', p0, 'bbj_pool', p1, 3, 'bbj_transfer', c1, now() - interval '1 hour');
  FOR i IN 1..40 LOOP
    INSERT INTO public.chip_ledger (from_type, to_type, to_entity_id, amount, category, club_id, created_at)
    VALUES ('table_stack', 'bbj_pool', p0, 0.10 * i, 'bbj_contribution', c1, now() - (i * interval '11 hours'));
  END LOOP;
  INSERT INTO public.bbj_contributions (amount, created_at) VALUES (12.34, now() - interval '3 days'), (1.11, now());
  INSERT INTO public.money_flow_checkpoint VALUES ('bbj_contributions_inflow', now() - interval '2 days', 1297368.04, 3, now(), now());
  INSERT INTO public.union_wallet_transactions (amount, tx_type) VALUES (5, 'bbj_fund'), (2.5, 'bbj_promo_sweep');
  INSERT INTO public.chip_transactions (amount, transaction_type) VALUES (1, 'bbj_promo_sweep');
  INSERT INTO public.bbj_payouts (total_amount) VALUES (40), (2);
  INSERT INTO public.wallet_transactions (user_id, type, category, description, amount, created_at)
  VALUES (u1, 'credit', 'promotion', 'BBJ promo pool payout', 3, now() - interval '4 days');

  -- Liveness: hands in and out of 24 hours.
  INSERT INTO public.hand_history (created_at) VALUES (now() - interval '1 hour'), (now() - interval '25 hours'), (now() - interval '2 hours');
  INSERT INTO public.ca_ledger_write_failures (occurred_at, club_id, sqlstate, message) VALUES (now() - interval '50 hours', c1, 'XX000', 'old');
  INSERT INTO public.wallets (balance, updated_at) VALUES (732591994.33, now() - interval '30 days');
  INSERT INTO public.ca_frozen_pool_baseline VALUES ('public.wallets', 732591994.33);

  -- Seat exits: credited, uncredited, corrected, a tournament seat, outside the window.
  INSERT INTO public.tables VALUES ('d0000000-0000-0000-0000-000000000001', NULL), ('d0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000009');
  INSERT INTO public.ca_seat_stack_exits (id, table_id, user_id, club_id, stack, exit_kind, occurred_at) VALUES
    (1, 'd0000000-0000-0000-0000-000000000001', u1, c1, 40, 'leave', now() - interval '2 days'),
    (2, 'd0000000-0000-0000-0000-000000000001', u2, c1, 25, 'leave', now() - interval '3 days'),
    (3, 'd0000000-0000-0000-0000-000000000001', horse, c1, 60, 'leave', now() - interval '1 day'),
    (4, 'd0000000-0000-0000-0000-000000000002', u3, c2, 70, 'bust', now() - interval '1 day'),
    (5, 'd0000000-0000-0000-0000-000000000001', u3, c2, 15, 'leave', now() - interval '9 days'),
    (6, 'd0000000-0000-0000-0000-000000000001', horse, c1, 30, 'leave', now() - interval '4 days'),
    (51, 'd0000000-0000-0000-0000-000000000001', u2, c1, 33, 'leave', now() - interval '5 days');
  INSERT INTO public.wallet_transactions (user_id, type, category, description, amount, created_at) VALUES
    (u1, 'credit', 'cashout', 'Cash-out from table', 40, now() - interval '2 days' + interval '1 minute'),
    (horse, 'credit', 'cashout', 'Cash-out from table', 59.995, now() - interval '1 day' - interval '14 minutes'),
    (u2, 'credit', 'correction', 'Correction: seat exit 2', 25, now() - interval '1 day'),
    (horse, 'debit', 'buyin', 'buy', 30, now() - interval '4 days'),
    (u2, 'credit', 'cashout', 'Cash-out from table', 10, now() - interval '5 days');

  -- Payouts: claimed in the window, claimed long before it, unclaimed, keyless,
  -- outside the window, a source the check does not read, a zero amount.
  INSERT INTO public.tournaments (id, name, status, variant, spin_multiplier, buy_in_amount, prize_pool, ended_at) VALUES
    ('e0000000-0000-0000-0000-000000000001', 'Spin Overlay Funded', 'COMPLETED', 'spin', 10, 5, 15, now() - interval '3 hours'),
    ('e0000000-0000-0000-0000-000000000002', 'Spin Overlay Unfunded', 'COMPLETED', 'spin', 2, 5, 15, now() - interval '4 hours'),
    ('e0000000-0000-0000-0000-000000000003', 'Spin No Escrow', 'COMPLETED', 'spin', 3, 5, 15, now() - interval '5 hours'),
    ('e0000000-0000-0000-0000-000000000004', 'MTT Over', 'COMPLETED', 'nlh', NULL, 10, 100, now() - interval '6 hours'),
    ('e0000000-0000-0000-0000-000000000005', 'MTT Acknowledged', 'COMPLETED', 'nlh', NULL, 10, 100, now() - interval '7 hours'),
    ('e0000000-0000-0000-0000-000000000006', 'MTT Old', 'COMPLETED', 'nlh', NULL, 10, 100, now() - interval '30 hours'),
    ('e0000000-0000-0000-0000-000000000007', 'Spin Infinite Escrow', 'COMPLETED', 'spin', 2, 5, 15, now() - interval '2 hours'),
    ('e0000000-0000-0000-0000-000000000008', 'Running', 'RUNNING', 'nlh', NULL, 10, 100, NULL),
    ('e0000000-0000-0000-0000-000000000010', 'Spin Zero Escrow Over', 'COMPLETED', 'spin', 2, 5, 15, now() - interval '1 hour');
  INSERT INTO public.tournament_escrow VALUES
    ('e0000000-0000-0000-0000-000000000001', 20), ('e0000000-0000-0000-0000-000000000002', 30),
    ('e0000000-0000-0000-0000-000000000007', 'Infinity'), ('e0000000-0000-0000-0000-000000000010', 0),
    ('e0000000-0000-0000-0000-000000000004', 50);
  INSERT INTO public.chip_ledger (from_type, to_type, to_entity_id, amount, category, club_id, tournament_id, status, created_at) VALUES
    ('union_bank', 'prize_liability', 'e0000000-0000-0000-0000-000000000001', 20, 'overlay', c1, 'e0000000-0000-0000-0000-000000000001', 'posted', now() - interval '3 hours'),
    ('club_treasury', 'prize_liability', 'e0000000-0000-0000-0000-000000000002', 10, 'overlay', c1, 'e0000000-0000-0000-0000-000000000002', 'posted', now() - interval '4 hours');
  INSERT INTO public.tournament_conservation_baseline VALUES ('e0000000-0000-0000-0000-000000000005', 30);
  INSERT INTO public.wallet_transactions (user_id, type, category, amount, related_entity_id, created_at) VALUES
    (u1, 'credit', 'prize', 70.004, 'e0000000-0000-0000-0000-000000000001', now() - interval '3 hours'),
    (u2, 'credit', 'prize', 0.01, 'e0000000-0000-0000-0000-000000000001', now() - interval '3 hours'),
    (u1, 'credit', 'prize', 10.006, 'e0000000-0000-0000-0000-000000000002', now() - interval '4 hours'),
    (u1, 'credit', 'prize', 16, 'e0000000-0000-0000-0000-000000000003', now() - interval '5 hours'),
    (horse, 'credit', 'prize', 120, 'e0000000-0000-0000-0000-000000000004', now() - interval '6 hours'),
    (u1, 'credit', 'prize', 125, 'e0000000-0000-0000-0000-000000000005', now() - interval '7 hours'),
    (u1, 'credit', 'prize', 500, 'e0000000-0000-0000-0000-000000000006', now() - interval '30 hours'),
    (u1, 'debit', 'prize', 500, 'e0000000-0000-0000-0000-000000000004', now() - interval '6 hours'),
    (u3, 'credit', 'prize', 11, 'e0000000-0000-0000-0000-000000000007', now() - interval '2 hours'),
    (u3, 'credit', 'prize', 10.01, 'e0000000-0000-0000-0000-000000000010', now() - interval '1 hour');
  INSERT INTO public.wallet_credit_idempotency VALUES
    ('k-recent', u1, 10, now() - interval '1 day'), ('k-old', u1, 10, now() - interval '20 days'),
    ('k-edge', u1, 10, now() - interval '4 days' + interval '1 second');
  INSERT INTO public.tournament_payouts (tournament_id, user_id, position, amount, source, idempotency_key, paid_at) VALUES
    ('e0000000-0000-0000-0000-000000000004', u1, 1, 10, 'structure', 'k-recent', now() - interval '1 day'),
    ('e0000000-0000-0000-0000-000000000004', u2, 2, 5, 'reconcile', 'k-old', now() - interval '2 days'),
    ('e0000000-0000-0000-0000-000000000004', horse, 3, 4, 'structure', 'k-missing', now() - interval '2 days'),
    ('e0000000-0000-0000-0000-000000000005', u3, 1, 3, 'spin_backpay', NULL, now() - interval '1 hour'),
    ('e0000000-0000-0000-0000-000000000005', u1, 2, 3, 'structure', 'k-edge', now() - interval '2 hours'),
    ('e0000000-0000-0000-0000-000000000006', u1, 1, 9, 'structure', 'k-late', now() - interval '5 days'),
    ('e0000000-0000-0000-0000-000000000006', u2, 2, 9, 'manual', 'k-manual', now() - interval '1 day'),
    ('e0000000-0000-0000-0000-000000000006', u3, 3, 0, 'structure', 'k-zero', now() - interval '1 day'),
    ('e0000000-0000-0000-0000-000000000006', NULL, 4, 2, 'structure', 'k-nouser', now() - interval '1 day'),
    ('e0000000-0000-0000-0000-000000000099', u1, 1, 2, 'structure', 'k-orphan', now() - interval '1 day');
END $data$;
