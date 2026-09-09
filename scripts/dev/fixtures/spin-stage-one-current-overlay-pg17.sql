\set ON_ERROR_STOP on

-- Production-shape fixture for the one historical Spin explicitly accepted by
-- the Stage 1 cutover. Run only in a disposable PostgreSQL 17 replay database.
-- Foreign-key triggers are suppressed because this fixture carries the exact
-- financial witnesses, not unrelated account/profile rows.
BEGIN;
SET LOCAL session_replication_role = replica;

INSERT INTO public.engine_maintenance_break (
  id, phase, announced_at, break_started_at, break_ends_at, reason,
  declared_by, enforce_freeze, ownership_token)
VALUES (
  true, 'counting_down', now(), now(), now() + interval '10 minutes',
  'Stage 1 replay', 'Codex PG17 proof', true,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

INSERT INTO public.tournaments (
  id, name, variant, buy_in_amount, buy_in_fee, start_time, status,
  max_players, prize_pool, spin_multiplier, club_id, started_at, ended_at,
  current_players, prize_pool_finalized)
VALUES (
  '6d688095-c3c5-4d40-a5a0-952934667732',
  '1 Chip Deep Stack Spin PLO5', 'Spin', 1, 0, now() - interval '3 days',
  'COMPLETED', 3, 3, 10, 'fade0000-0000-0000-0000-000000000001',
  now() - interval '3 days', now() - interval '3 days', 3, true);

INSERT INTO public.tournament_players (
  tournament_id, user_id, position, prize, status)
VALUES
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'a70a0d4c-232e-482d-898f-37518fe134bc', 1, 9.40, 'eliminated'),
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 2, 2.00, 'eliminated');

INSERT INTO public.spin_reserve_ledger (
  id, club_id, tournament_id, kind, amount, balance_after, multiplier,
  buy_in, seats, house_rake)
VALUES
  ('10000000-0000-4000-8000-000000000001',
   'fade0000-0000-0000-0000-000000000001',
   '6d688095-c3c5-4d40-a5a0-952934667732',
   'contribution', 2.76, 100, 1, 1, 3, 0.24),
  ('10000000-0000-4000-8000-000000000002',
   'fade0000-0000-0000-0000-000000000001',
   '6d688095-c3c5-4d40-a5a0-952934667732',
   'jackpot_draw', -10, 90, 10, 1, 3, NULL);

INSERT INTO public.chip_ledger (
  id, performed_by, from_type, from_entity_id, to_type, to_entity_id,
  amount, category, tournament_id, union_id, idempotency_key, status)
VALUES
  ('20000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-00000000c1a9', 'spin_reserve',
   '20000000-0000-4000-8000-000000000011', 'prize_liability',
   '6d688095-c3c5-4d40-a5a0-952934667732', 10, 'spin_prize',
   '6d688095-c3c5-4d40-a5a0-952934667732',
   'fade0000-0000-0000-0000-000000000001', 'spin-draw-fixture', 'posted'),
  ('20000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-00000000c1a9', 'union_bank',
   '20000000-0000-4000-8000-000000000012', 'prize_liability',
   '6d688095-c3c5-4d40-a5a0-952934667732', 1.40, 'overlay',
   '6d688095-c3c5-4d40-a5a0-952934667732',
   'fade0000-0000-0000-0000-000000000001',
   'spin-ladder-overlay:6d688095-c3c5-4d40-a5a0-952934667732', 'posted'),
  ('20000000-0000-4000-8000-000000000003',
   '00000000-0000-0000-0000-00000000c1a9', 'prize_liability',
   '6d688095-c3c5-4d40-a5a0-952934667732', 'player_wallet',
   'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 1.40,
   'tournament_prize', '6d688095-c3c5-4d40-a5a0-952934667732',
   NULL, NULL, 'posted');

INSERT INTO public.tournament_escrow (
  tournament_id, opened_from, gross_in, fee_entries_in, overlay_in,
  prize_out, fee_out, prize_balance, fee_balance, reserve_out, reserve_in,
  closed_at)
VALUES (
  '6d688095-c3c5-4d40-a5a0-952934667732', 'production-shape replay',
  3, 0.24, 1.40, 11.40, 0.24, 0, 0, 2.76, 10,
  now() - interval '3 days');

INSERT INTO public.tournament_payouts (
  tournament_id, user_id, position, amount, source)
VALUES
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'a70a0d4c-232e-482d-898f-37518fe134bc', 1, 3, 'payout'),
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'a70a0d4c-232e-482d-898f-37518fe134bc', 1, 6.4, 'spin_backpay'),
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 2, 0.6, 'reconcile'),
  ('6d688095-c3c5-4d40-a5a0-952934667732',
   'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 2, 1.4, 'reconcile');

INSERT INTO public.wallet_transactions (
  user_id, wallet_type, amount, type, category, related_entity_id)
VALUES
  ('a70a0d4c-232e-482d-898f-37518fe134bc', 'PLAYER', 3,
   'credit', 'prize', '6d688095-c3c5-4d40-a5a0-952934667732'),
  ('a70a0d4c-232e-482d-898f-37518fe134bc', 'PLAYER', 6.4,
   'credit', 'prize', '6d688095-c3c5-4d40-a5a0-952934667732'),
  ('bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 'PLAYER', 0.6,
   'credit', 'prize', '6d688095-c3c5-4d40-a5a0-952934667732'),
  ('bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 'PLAYER', 1.4,
   'credit', 'prize', '6d688095-c3c5-4d40-a5a0-952934667732');

INSERT INTO public.ca_manual_adjustments (
  id, actor, approver, reason, amount, target_kind, target_id,
  tournament_id, status, approved_at, decision_note, actor_label, asset)
VALUES (
  '04069754-fba7-46e4-89d5-5f96fe4fd437',
  '00000000-0000-0000-0000-00000000c1a9',
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
  'Exact production correction', 2, 'player_wallet',
  'bbcaaed4-92b3-4ad7-86ee-7770bb36751a',
  '6d688095-c3c5-4d40-a5a0-952934667732', 'approved',
  now() - interval '1 day',
  'migration 20260909110818_the_spin_runner_up_gets_the_share_the_ladder_promised',
  'chip standard 10.9 (Claude)', 'chips');

INSERT INTO public.tournament_obligations (
  tournament_id, kind, place, user_id, amount_owed, amount_paid, source,
  settled_at, adjustment_id)
VALUES
  ('6d688095-c3c5-4d40-a5a0-952934667732', 'place', 1,
   'a70a0d4c-232e-482d-898f-37518fe134bc', 9.4, 9.4,
   'spin_backpay', now() - interval '3 days', NULL),
  ('6d688095-c3c5-4d40-a5a0-952934667732', 'place', 2,
   'bbcaaed4-92b3-4ad7-86ee-7770bb36751a', 2, 2,
   'reconcile', now() - interval '1 day',
   '04069754-fba7-46e4-89d5-5f96fe4fd437');

INSERT INTO public.financial_alerts (
  id, severity, source, message, context, resolved)
VALUES (
  '514fdb44-0433-4602-bb5e-4ddf4597b4b0', 'info',
  'fn_spin_repair_missing_multiplier',
  'Spin lost its draw stamp; multiplier restored from the reserve ledger: 1 Chip Deep Stack Spin PLO5',
  jsonb_build_object(
    'tournament_id', '6d688095-c3c5-4d40-a5a0-952934667732'),
  false);

COMMIT;
