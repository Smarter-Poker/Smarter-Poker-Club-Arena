-- 20261002082429_pko_3f19bd70_champion_is_paid_the_unclaimed_bounty.sql
--
-- THE PKO 3f19bd70 CHAMPION IS PAID THE UNCLAIMED BOUNTY BY THE EVENT'S OWN RULE (2026-10-02)
--
-- DECISION. Dan, 2026-10-02, on the two owed items still open: "pay it how you
-- feel it's necessary or don't, it doesn't matter as long as the bug or glitch
-- is done." The rule applied: pay exactly what the platform's own rules compute
-- exactly from surviving rows, to the recipient those rules name, and never
-- invent a recipient or an amount. CLAUDE.md 10.5 (a horse is paid exactly as a
-- human is) and 10.9 rule 3 (nothing is taken back for our mistake) bind.
--
-- WHAT IS OWED, READ FROM ROWS (2026-10-02, production)
--   Sunday Funday High Roller PKO 3f19bd70, Deep Stack Society, COMPLETED
--   2026-09-07, 66 entrants by satellite seat, buy-in 67.50 + 7.50, bounty 35.00,
--   guarantee 3,500.00. fn_tournament_entry_split carves the 35.00 bounty out of
--   each 67.50, so the advertised structure is a 3,500.00 ladder (66 x 32.50 =
--   2,145.00 is under the guarantee) plus a 2,310.00 bounty pool: 5,810.00.
--   The 2026-09-04 satellite-award path put the whole 67.50 into the ladder, so
--   places 1-10 were paid 4,455.00 on the event's percentages and the bounty
--   pool paid nothing (tournament_payouts: source 'structure' only; no
--   knockout, bounty award or candidate row exists; hand history pruned).
--
--   The event's own rule for a bounty nobody claimed is fn_finalize_bounty_pool:
--   the unclaimed remainder goes to the CHAMPION. On 2026-09-07 the platform ran
--   exactly that, 2,310.00 to 13133bc4 (ridgethackeray, position 1), and was
--   refused only because the bounty escrow held 0.00 (alert 85253851). No
--   knockout was ever recorded, so the whole pool is unclaimed under that rule
--   and the champion is its recipient by the rule, not by choice.
--
--   The champion's entitlement on the advertised structure, every term a row:
--     ladder share  = 1,306.65 / 4,455.00 of 3,500.00   = 1,026.55
--     bounty        = the unclaimed pool                 = 2,310.00
--     received      = tournament_players.prize           = 1,306.65
--     OWED          = 1,026.55 + 2,310.00 - 1,306.65     = 2,029.90
--   Places 2-10 received 674.90 more ladder than the advertised 3,500.00 ladder
--   gives them; that overpay was our defect and stays with them (10.9 rule 3).
--   The house therefore pays 2,029.90, 674.90 more than the field-level
--   1,355.00 shortfall recorded on the alerts; that difference is the cost of
--   not taking the overpay back. Nothing of this item is left unattributed.
--
-- WHO PAYS. Deep Stack Society hosted the event, took its 495.00 rake, and is
-- the club whose guarantee overlay the mis-split suppressed. Its treasury pays.
--
-- THE DOOR (same parts as 20260926085132, the house paying a ruling outside an
-- event whose books are sealed): the escrow is terminally closed at zero and a
-- wallet row naming a COMPLETED tournament is refused by
-- terminal_wallet_transaction_is_immutable, so this is a settlement, not a
-- bounty drawn from the pool:
--   1. fn_ca_adjustment_under_10_9 writes the approved ca_manual_adjustments row;
--   2. fn_ca_declare_ledger names the bank (club_treasury, Deep Stack Society)
--      and skips the clubs trigger: ONE journal leg club_treasury -> player_wallet;
--   3. the treasury is debited, refusing if it cannot cover the amount;
--   4. fn_credit_and_log credits the champion's Deep Stack Society wallet under
--      the key pko-unclaimed-bounty:<event>:<champion>, so a replay pays nothing;
--   5. the adjustment is settled and the three alerts are resolved with the
--      receipt ids. The tournament, its payouts and its escrow are not touched.
--
-- No is_horse condition anywhere: the champion is paid as a human champion is.
-- PROOF: every pre-image is asserted (alerts open and still saying 1,355.00
-- owed, the rows still computing 2,029.90, the key unused), and the post-image
-- proves the treasury moved -2,029.90, the wallet +2,029.90, and exactly one
-- journal leg club_treasury -> player_wallet of 2,029.90 was written.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'settlement'->>'migration' = '20261002082429_pko_3f19bd70_champion_is_paid_the_unclaimed_bounty') = 3

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  c_mig       CONSTANT text := '20261002082429_pko_3f19bd70_champion_is_paid_the_unclaimed_bounty';
  c_event     CONSTANT uuid := '3f19bd70-d88c-420a-bc6a-8d4a6d9b11f6';
  c_dss       CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_champion  CONSTANT uuid := '13133bc4-9139-4066-8b55-8edd31ef2318';
  c_actor     CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_alerts    CONSTANT uuid[] := ARRAY['3a511087-1ba0-499c-88e4-dcc622aa06ae',
                                       '85253851-b062-4e7f-ac49-83db4c09b8c3',
                                       'fe0e2bab-1922-4575-a3c0-6c753d64e56e']::uuid[];
  v_key       CONSTANT text := 'pko-unclaimed-bounty:3f19bd70-d88c-420a-bc6a-8d4a6d9b11f6:13133bc4-9139-4066-8b55-8edd31ef2318';
  v_probe     boolean := COALESCE(current_setting('ca.pko_owed_probe', true), '') = 'on';
  t record;
  v_ladder_paid numeric; v_champ_prize numeric; v_champ_pos int; v_champ_name text;
  v_entrants int; v_ladder_share numeric; v_owed numeric;
  v_adj uuid; v_ok boolean; v_bank_before numeric; v_bank numeric;
  v_bal_before numeric; v_bal_after numeric; v_leg uuid; v_wtx uuid;
  v_desc text; v_reason text; v_n int;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. PRE-IMAGE: the event, the rows the amount is computed from, the alerts.
  ---------------------------------------------------------------------------
  SELECT * INTO t FROM public.tournaments WHERE id = c_event;
  IF t.id IS NULL OR upper(t.status::text) <> 'COMPLETED' OR t.club_id IS DISTINCT FROM c_dss
     OR t.buy_in_amount <> 67.50 OR t.buy_in_fee <> 7.50 OR t.bounty_amount <> 35.00
     OR t.guaranteed_prize <> 3500.00 OR t.bounty_pool <> 2310.00 OR COALESCE(t.bounty_pool_paid, 0) <> 0 THEN
    RAISE EXCEPTION 'pko owed pre-image: 3f19bd70 no longer reads COMPLETED / DSS / 67.50+7.50, 35.00 bounty, 3,500.00 guarantee, 2,310.00 pool unpaid';
  END IF;

  SELECT count(*) INTO v_entrants FROM public.tournament_players WHERE tournament_id = c_event;
  SELECT round(sum(amount), 2) INTO v_ladder_paid FROM public.tournament_payouts
   WHERE tournament_id = c_event AND source = 'structure';
  IF v_entrants <> 66 OR v_ladder_paid <> 4455.00
     OR EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id = c_event AND source <> 'structure')
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards WHERE tournament_id = c_event)
     OR EXISTS (SELECT 1 FROM public.tournament_knockout_candidates WHERE tournament_id = c_event)
     OR EXISTS (SELECT 1 FROM public.wallet_transactions w WHERE w.related_entity_id = c_event AND w.category = 'bounty') THEN
    RAISE EXCEPTION 'pko owed pre-image: 3f19bd70 is no longer 66 entrants, 4,455.00 structure ladder, no bounty paid and no knockout recorded';
  END IF;

  SELECT tp.position, tp.prize, p.username INTO v_champ_pos, v_champ_prize, v_champ_name
    FROM public.tournament_players tp JOIN public.profiles p ON p.id = tp.user_id
   WHERE tp.tournament_id = c_event AND tp.user_id = c_champion;
  IF v_champ_pos IS DISTINCT FROM 1
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = c_event AND position = 1) <> 1 THEN
    RAISE EXCEPTION 'pko owed pre-image: 13133bc4 is no longer the sole position 1 of 3f19bd70';
  END IF;
  IF (SELECT round(amount, 2) FROM public.tournament_payouts
       WHERE tournament_id = c_event AND user_id = c_champion AND source = 'structure') IS DISTINCT FROM v_champ_prize
     OR v_champ_prize <> 1306.65 THEN
    RAISE EXCEPTION 'pko owed pre-image: the champion''s recorded ladder payout is no longer 1,306.65';
  END IF;

  -- The amount, from the rows: advertised ladder share + unclaimed pool - received.
  v_ladder_share := round(v_champ_prize * t.guaranteed_prize / v_ladder_paid, 2);
  v_owed := round(v_ladder_share + t.bounty_pool - v_champ_prize, 2);
  IF v_ladder_share <> 1026.55 OR v_owed <> 2029.90 THEN
    RAISE EXCEPTION 'pko owed pre-image: the rows compute ladder share % and owed %, not 1,026.55 and 2,029.90', v_ladder_share, v_owed;
  END IF;

  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE
         AND context->'owed'->>'status' = 'owed_unpaid'
         AND (context->'owed'->>'amount')::numeric = 1355.00
         AND context->>'tournament_id' = c_event::text) <> 3 THEN
    RAISE EXCEPTION 'pko owed pre-image: the three 3f19bd70 alerts are no longer open and owed_unpaid 1,355.00 - refusing to pay twice';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key)
     OR EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                 WHERE a.tournament_id = c_event AND a.target_id = c_champion) THEN
    RAISE EXCEPTION 'pko owed pre-image: the champion was already paid for 3f19bd70';
  END IF;
  IF public.fn_player_home_club(c_champion, NULL) IS DISTINCT FROM c_dss THEN
    RAISE EXCEPTION 'pko owed pre-image: 13133bc4 no longer resolves to Deep Stack Society; the credit would land in another club than the bank that pays it';
  END IF;

  SELECT chip_treasury INTO v_bank_before FROM public.clubs WHERE id = c_dss FOR NO KEY UPDATE;
  IF COALESCE(v_bank_before, 0) < v_owed THEN
    RAISE EXCEPTION 'pko owed: Deep Stack Society treasury holds % and cannot fund %', v_bank_before, v_owed;
  END IF;
  SELECT chip_balance INTO v_bal_before FROM public.club_members
   WHERE user_id = c_champion AND club_id = c_dss FOR NO KEY UPDATE;
  IF v_bal_before IS NULL THEN
    RAISE EXCEPTION 'pko owed: 13133bc4 holds no Deep Stack Society wallet';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. ONE CREDIT, ONE LEG.
  ---------------------------------------------------------------------------
  v_desc := 'PKO make-good: Sunday Funday High Roller PKO (3f19bd70) unclaimed bounty and advertised ladder, champion settlement';
  v_reason := format(
    '%s (%s), champion of Sunday Funday High Roller PKO %s (2026-09-07, Deep Stack Society), is owed %s. '
    || 'The 2026-09-04 satellite-award path put each 67.50 seat wholly into the prize ladder, so places 1-10 were paid 4,455.00 and the 2,310.00 bounty pool paid nothing; no knockout was ever recorded. '
    || 'The event''s own rule (fn_finalize_bounty_pool) pays an unclaimed bounty remainder to the champion and attempted exactly that on 2026-09-07, refused escrow_short. '
    || 'Owed on the advertised structure: ladder share 1,026.55 (1,306.65 / 4,455.00 of the 3,500.00 guarantee) + bounty 2,310.00 - received 1,306.65 = 2,029.90. '
    || 'Places 2-10 keep their 674.90 ladder overpay (CLAUDE.md 10.9 rule 3). Horse fleet player, paid exactly as a human champion is (10.5). '
    || 'Deep Stack Society, which hosted the event and took its rake, pays from its treasury. Decided under Dan''s 2026-10-02 ruling. Migration %s carries this.',
    v_champ_name, c_champion, c_event, v_owed, c_mig);
  v_adj := public.fn_ca_adjustment_under_10_9(c_event, c_champion, v_owed, v_reason, c_mig,
             'claude-opus-5.5 under CLAUDE.md 10.9 (owed-close 2026-10-02)');

  PERFORM public.fn_ca_declare_ledger('settlement', 'club_treasury', c_dss, NULL, v_key, ARRAY['clubs']);
  PERFORM set_config('app.ledger_correlation', v_adj::text, true);
  UPDATE public.clubs SET chip_treasury = chip_treasury - v_owed, updated_at = now()
   WHERE id = c_dss AND chip_treasury >= v_owed
   RETURNING chip_treasury INTO v_bank;
  IF v_bank IS NULL THEN
    RAISE EXCEPTION 'pko owed: the treasury could not fund %', v_owed;
  END IF;

  v_ok := public.fn_credit_and_log(c_champion, v_owed, v_key, 'settlement', v_desc, NULL);

  PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  PERFORM set_config('app.ledger_correlation', '', true);

  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'pko owed: the wallet door refused key %', v_key;
  END IF;

  SELECT chip_balance INTO v_bal_after FROM public.club_members WHERE user_id = c_champion AND club_id = c_dss;
  IF round(v_bal_after - v_bal_before, 2) <> v_owed THEN
    RAISE EXCEPTION 'pko owed: the champion''s wallet moved % where % was paid', v_bal_after - v_bal_before, v_owed;
  END IF;

  SELECT l.id INTO v_leg FROM public.chip_ledger l
   WHERE l.created_at = now() AND l.from_type = 'club_treasury' AND l.from_entity_id = c_dss
     AND l.to_type = 'player_wallet' AND l.to_entity_id = c_champion
     AND l.amount = v_owed AND l.category = 'settlement'
   ORDER BY l.id LIMIT 1;
  IF v_leg IS NULL THEN
    RAISE EXCEPTION 'pko owed: no journal leg club_treasury -> player_wallet of %', v_owed;
  END IF;
  SELECT w.id INTO v_wtx FROM public.wallet_transactions w
   WHERE w.created_at = now() AND w.user_id = c_champion AND w.type = 'credit'
     AND w.category = 'settlement' AND w.amount = v_owed AND w.description = v_desc
   ORDER BY w.id LIMIT 1;
  IF v_wtx IS NULL THEN
    RAISE EXCEPTION 'pko owed: no wallet receipt for %', v_key;
  END IF;

  UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
  IF NOT FOUND THEN RAISE EXCEPTION 'pko owed: adjustment % did not settle', v_adj; END IF;

  ---------------------------------------------------------------------------
  -- 2. THE THREE ALERTS CLOSE, CARRYING THE RECEIPT.
  ---------------------------------------------------------------------------
  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object(
           'owed', (context->'owed') || jsonb_build_object('status', 'paid', 'paid_amount', v_owed),
           'settlement', jsonb_build_object(
             'decision', 'paid_to_champion_by_event_rule',
             'ruling', 'Dan 2026-10-02: pay it how you feel it''s necessary or don''t, as long as the bug is done',
             'basis', 'fn_finalize_bounty_pool unclaimed remainder to the champion, made whole against the advertised structure',
             'recipient', c_champion, 'amount', v_owed,
             'ladder_share', v_ladder_share, 'bounty', t.bounty_pool, 'received', v_champ_prize,
             'overpay_kept_by_places_2_10', 674.90, 'unattributed', 0,
             'funded_by', 'club_treasury', 'club_id', c_dss,
             'adjustment_id', v_adj, 'idempotency_key', v_key,
             'ledger_id', v_leg, 'wallet_transaction_id', v_wtx,
             'migration', c_mig, 'paid_at', now())),
         resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = format(
           'Paid. Champion %s (%s) received %s from the Deep Stack Society treasury: the unclaimed 2,310.00 bounty pool the event''s own rule (fn_finalize_bounty_pool) assigns to the champion, made whole against the advertised 3,500.00 ladder (share 1,026.55, received 1,306.65). '
           || 'Places 2-10 keep their 674.90 ladder overpay (10.9 rule 3); nothing is unattributed. Adjustment %s (settled), wallet key %s, journal leg %s (club_treasury -> player_wallet, settlement). Migration %s.',
           v_champ_name, c_champion, v_owed, v_adj, v_key, v_leg, c_mig)
   WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 3 THEN RAISE EXCEPTION 'pko owed: expected to resolve 3 alerts, resolved %', v_n; END IF;

  ---------------------------------------------------------------------------
  -- 3. POST-IMAGE. Conserved to the cent.
  ---------------------------------------------------------------------------
  SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id = c_dss;
  IF round(v_bank_before - v_bank, 2) <> v_owed THEN
    RAISE EXCEPTION 'pko owed post-image: treasury moved % (expected %)', v_bank_before - v_bank, v_owed;
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.created_at = now() AND (l.from_entity_id = c_dss OR l.to_entity_id = c_dss)
         AND (l.from_type = 'club_treasury' OR l.to_type = 'club_treasury')) <> 1 THEN
    RAISE EXCEPTION 'pko owed post-image: the treasury carries other than exactly one journal leg in this transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts
              WHERE context->>'tournament_id' = c_event::text AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'pko owed post-image: an alert on 3f19bd70 is still open';
  END IF;

  RAISE NOTICE 'pko owed: paid % to % (adjustment %, leg %, wallet tx %); DSS treasury % -> %',
    v_owed, c_champion, v_adj, v_leg, v_wtx, v_bank_before, v_bank;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): paid % to %; treasury % -> %', v_owed, c_champion, v_bank_before, v_bank;
  END IF;
END
$mig$;

COMMIT;
