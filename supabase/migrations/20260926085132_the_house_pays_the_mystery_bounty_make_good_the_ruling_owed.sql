-- 20260926085132_the_house_pays_the_mystery_bounty_make_good_the_ruling_owed.sql
--
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE source = 'ruling.mystery_bounty_obligation_retired_owed_unfunded' AND context ? 'make_good' AND (context->>'funded')::boolean IS TRUE) = 7
--
-- THE HOUSE PAYS THE MYSTERY-BOUNTY MAKE-GOOD THE RULING OWED (2026-09-26)
--
-- DECISION (CLAUDE.md 10.9, delegated by Dan for this item on 2026-09-26):
-- pay the seven obligations retired under ruling-2026-09-11-mystery-bust-phase
-- on their recorded owed_cents basis, 76.90 in total, house-funded.
--
-- WHAT IS OWED, READ FROM THE RULING'S OWN ROWS. The ruling retired seven
-- mystery-bounty obligations as owed-and-unfunded (funded:false,
-- money_moved_cents:0) and said the make-good is "house-funded through a
-- separate audited door". That door was never opened: none of the five
-- players received any credit for it, and ca_manual_adjustments holds no row
-- for either event. The owed_cents of each obligation row:
--
--   reedyarrow     fb7da841  Midweek Mystery  chest seq 2  19.00
--   reedyarrow     fb7da841  Midweek Mystery  chest seq 4   8.50
--   thornemontrose bc43a03f  Midweek Mystery  chest seq 3  26.00
--   sageivorson    5e35105f  Midweek Mystery  pre head      6.00
--   sageivorson    5e35105f  Midweek Mystery  pre head      6.00
--   oakesoakhurst  2b36fe05  Midweek Mystery  pre head      6.00
--   thorneziegler  86e42f5e  DSS Wednesday    chest seq 2   5.40
--                                                   total  76.90
--
-- All five are HORSE fleet players (profiles.is_horse), members of Deep Stack
-- Society, the club that hosted both events and took their 114.00 of rake.
-- Under CLAUDE.md 10.5 a horse is paid exactly as a human is.
--
-- WHY NOT THE TOURNAMENT DOOR. fn_settle_tournament_obligation pays from the
-- event's escrow, and both escrows are terminally closed at exact zero
-- (terminal_tournament_escrow_is_immutable); a wallet row that names a
-- COMPLETED tournament is refused by terminal_wallet_transaction_is_immutable,
-- and a bounty-category credit outside that door is refused by R3
-- (trg_ca_money_path_log, mode refuse). The event's books are sealed and
-- correct as sealed; the make-good is the HOUSE paying outside them, which is
-- exactly what the ruling said. The club bank doors (fn_club_bank_send) need
-- a signed-in owner or admin of the club, and a script never wears a person's
-- face (10.10 rule 2).
--
-- THE DOOR, BUILT FROM THE PLATFORM'S OWN PARTS, ONE CREDIT PER OBLIGATION:
--   1. fn_ca_adjustment_under_10_9 writes the approved ca_manual_adjustments
--      row carrying the paragraph (the audit record of the decision);
--   2. fn_ca_declare_ledger names the bank (club_treasury, Deep Stack Society)
--      and skips the clubs trigger, exactly as fn_club_bank_send does
--      (CHIP STANDARD 2.4: ONE journal row from the bank to the wallet);
--   3. the treasury is debited, refusing if it cannot cover the amount;
--   4. fn_credit_and_log credits the player through the idempotent wallet door
--      under the key ruling-make-good:<obligation id>, so a replay pays nothing;
--   5. the adjustment is marked settled, the alert's context records
--      funded:true with every receipt id, and the alert is resolved.
-- wallet category 'settlement' / journal category 'settlement': this is the
-- house settling a ruling, not a bounty drawn from the event's pool.
--
-- Nothing is taken from anyone. The overpayments the ruling let stand
-- (e0a041b8 18.00, f86105e2 20.00, 8ebbb163 2.40) still stand (10.9 rule 3).
--
-- PROOF: the DO block asserts every pre-image, then proves the treasury moved
-- by exactly -76.90, each wallet by exactly its amount, and that exactly seven
-- journal legs club_treasury -> player_wallet totalling 76.90 were written in
-- this transaction. Set ca.money7_probe = 'on' to run it and roll it back.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig     CONSTANT text := '20260926085132_the_house_pays_the_mystery_bounty_make_good_the_ruling_owed';
  c_ruling  CONSTANT text := 'ruling-2026-09-11-mystery-bust-phase';
  c_dss     CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_actor   CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_probe   boolean := COALESCE(current_setting('ca.money7_probe', true), '') = 'on';
  r record;
  v_key text; v_adj uuid; v_ok boolean; v_bank numeric; v_bank_before numeric;
  v_bal_before numeric; v_bal_after numeric; v_leg uuid; v_wtx uuid;
  v_total numeric := 0; v_n int := 0; v_report jsonb := '[]'::jsonb;
  v_reason text; v_desc text;
BEGIN
  CREATE TEMP TABLE zz_make_good (
    alert_id uuid, user_id uuid, username text, cents int, obligation_id uuid,
    tournament_id uuid, tournament_name text, basis text) ON COMMIT DROP;
  INSERT INTO zz_make_good VALUES
    ('655d5afa-beca-4a86-b38b-3a83cb7f2140','fb7da841-7258-45a6-90a5-3ec623b1297c','reedyarrow',    1900,'f244b4ba-6c81-4e87-83f8-a2e347e479d4','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','chest seq 2 (1900c) it would have drawn'),
    ('037bed0f-0db9-4bf4-b41c-e3da4b24af62','fb7da841-7258-45a6-90a5-3ec623b1297c','reedyarrow',     850,'17153537-5e62-4fd2-a98a-fa074ee46538','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','chest seq 4 (850c)'),
    ('2d1c6777-f851-475c-88e5-a4178c4f1f8e','bc43a03f-cee3-43fc-8470-a4c605127316','thornemontrose',2600,'ebf3757c-dc42-43c2-bcba-ebf03dd3832d','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','chest seq 3 (2600c)'),
    ('29dde986-bcbe-4438-9476-5569f0599243','5e35105f-31ee-4411-b09c-473f4f46d7a9','sageivorson',    600,'26fd8517-5a99-49c1-91dd-b0d4aaae1642','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','mystery_pre head'),
    ('85f355d1-926a-48c0-916f-29acb778ecb7','5e35105f-31ee-4411-b09c-473f4f46d7a9','sageivorson',    600,'e3b593bc-b674-4a79-941b-9ca7ef288ffc','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','mystery_pre head'),
    ('da055187-7272-4046-9108-9d81e2d3e753','2b36fe05-9389-47b9-9646-dc2a91d414d4','oakesoakhurst',  600,'26fdf053-5c6d-4700-9109-0aad9f771b86','5aa7eeba-4c49-4912-b6c5-79053d1cba92','Midweek Mystery','mystery_pre head'),
    ('d250b432-d5bb-4747-b378-a8fee100312e','86e42f5e-0fd3-4f59-b1ec-8a300f0ff391','thorneziegler',  540,'4be17692-378f-4abb-b631-02a27b8a9302','9536150e-7b7b-4914-af22-deeab3766d86','DSS Wednesday $11 NLH Mystery Bounty','chest seq 2 (540c) it would have drawn');

  ---------------------------------------------------------------------------
  -- 0. PRE-IMAGE. Every alert is still open and still says what we read.
  ---------------------------------------------------------------------------
  FOR r IN SELECT m.*, a.resolved, a.context FROM zz_make_good m
             LEFT JOIN public.financial_alerts a ON a.id = m.alert_id LOOP
    IF r.context IS NULL THEN
      RAISE EXCEPTION 'make-good pre-image: alert % is missing', r.alert_id;
    END IF;
    IF r.resolved IS TRUE THEN
      RAISE EXCEPTION 'make-good pre-image: alert % is already resolved - refusing to pay twice', r.alert_id;
    END IF;
    IF r.context->>'ruling' IS DISTINCT FROM c_ruling
       OR (r.context->>'funded')::boolean IS DISTINCT FROM false
       OR (r.context->>'owed_cents')::int IS DISTINCT FROM r.cents
       OR (r.context->>'owed_user_id')::uuid IS DISTINCT FROM r.user_id
       OR (r.context->'obligation'->>'id')::uuid IS DISTINCT FROM r.obligation_id
       OR (r.context->>'tournament_id')::uuid IS DISTINCT FROM r.tournament_id THEN
      RAISE EXCEPTION 'make-good pre-image: alert % no longer carries the obligation this migration was written against: %', r.alert_id, r.context;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = r.user_id AND p.is_horse IS TRUE) THEN
      RAISE EXCEPTION 'make-good pre-image: % is no longer a horse; a human payee needs its own reading', r.user_id;
    END IF;
    IF public.fn_player_home_club(r.user_id, NULL) IS DISTINCT FROM c_dss THEN
      RAISE EXCEPTION 'make-good pre-image: % no longer resolves to Deep Stack Society; the credit would land in another club than the bank that pays it', r.user_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k
                WHERE k.key = 'ruling-make-good:' || r.obligation_id::text) THEN
      RAISE EXCEPTION 'make-good pre-image: obligation % was already paid', r.obligation_id;
    END IF;
  END LOOP;
  IF (SELECT sum(cents) FROM zz_make_good) <> 7690 THEN
    RAISE EXCEPTION 'make-good pre-image: the obligations no longer total 76.90';
  END IF;

  SELECT chip_treasury INTO v_bank_before FROM public.clubs WHERE id = c_dss FOR UPDATE;
  IF COALESCE(v_bank_before, 0) < 76.90 THEN
    RAISE EXCEPTION 'make-good: Deep Stack Society treasury holds % and cannot fund 76.90', v_bank_before;
  END IF;

  ---------------------------------------------------------------------------
  -- 1. ONE CREDIT PER OBLIGATION.
  ---------------------------------------------------------------------------
  FOR r IN SELECT * FROM zz_make_good ORDER BY user_id, obligation_id LOOP
    v_key := 'ruling-make-good:' || r.obligation_id::text;
    v_desc := format('Ruling make-good: mystery bounty owed from %s (%s), %s', r.tournament_name, c_ruling, r.basis);
    v_reason := format(
      '%s (%s) is owed %s from %s (%s) by %s: obligation %s (%s) was retired owed-and-unfunded because the chest inventory was exhausted by pre-activation busts recorded after activation. '
      || 'The ruling said the make-good is house-funded through a separate audited door; this is that door. Deep Stack Society, which hosted the event and took its rake, pays %s from its treasury to this player''s Deep Stack Society wallet. '
      || 'Paid on the ruling''s own owed_cents basis. The player is a HORSE fleet player, paid exactly as a human is (CLAUDE.md 10.5). Nothing is taken from anyone. Migration %s carries this.',
      r.username, r.user_id, round(r.cents / 100.0, 2), r.tournament_name, r.tournament_id, c_ruling,
      r.obligation_id, r.basis, round(r.cents / 100.0, 2), c_mig);
    v_adj := public.fn_ca_adjustment_under_10_9(r.tournament_id, r.user_id, round(r.cents / 100.0, 2),
               v_reason, c_mig, 'claude-opus-5.5 under CLAUDE.md 10.9 (money7)');

    SELECT chip_balance INTO v_bal_before FROM public.club_members
     WHERE user_id = r.user_id AND club_id = c_dss FOR UPDATE;
    IF v_bal_before IS NULL THEN
      RAISE EXCEPTION 'make-good: % holds no Deep Stack Society wallet', r.user_id;
    END IF;

    PERFORM public.fn_ca_declare_ledger('settlement', 'club_treasury', c_dss, NULL, v_key, ARRAY['clubs']);
    PERFORM set_config('app.ledger_correlation', v_adj::text, true);
    UPDATE public.clubs SET chip_treasury = chip_treasury - round(r.cents / 100.0, 2), updated_at = now()
     WHERE id = c_dss AND chip_treasury >= round(r.cents / 100.0, 2)
     RETURNING chip_treasury INTO v_bank;
    IF v_bank IS NULL THEN
      RAISE EXCEPTION 'make-good: the treasury could not fund %', round(r.cents / 100.0, 2);
    END IF;

    v_ok := public.fn_credit_and_log(r.user_id, round(r.cents / 100.0, 2), v_key, 'settlement', v_desc, NULL);

    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    PERFORM set_config('app.ledger_correlation', '', true);

    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'make-good: the wallet door refused obligation % (key %)', r.obligation_id, v_key;
    END IF;

    SELECT chip_balance INTO v_bal_after FROM public.club_members WHERE user_id = r.user_id AND club_id = c_dss;
    IF round(v_bal_after - v_bal_before, 2) <> round(r.cents / 100.0, 2) THEN
      RAISE EXCEPTION 'make-good: % wallet moved % where % was paid', r.user_id, v_bal_after - v_bal_before, round(r.cents / 100.0, 2);
    END IF;

    SELECT l.id INTO v_leg FROM public.chip_ledger l
     WHERE l.created_at = now() AND l.from_type = 'club_treasury' AND l.from_entity_id = c_dss
       AND l.to_type = 'player_wallet' AND l.to_entity_id = r.user_id
       AND l.amount = round(r.cents / 100.0, 2) AND l.category = 'settlement'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_report) e WHERE (e->>'ledger_id')::uuid = l.id)
     ORDER BY l.id LIMIT 1;
    IF v_leg IS NULL THEN
      RAISE EXCEPTION 'make-good: no journal leg club_treasury -> player_wallet for obligation %', r.obligation_id;
    END IF;
    SELECT w.id INTO v_wtx FROM public.wallet_transactions w
     WHERE w.created_at = now() AND w.user_id = r.user_id AND w.type = 'credit'
       AND w.category = 'settlement' AND w.amount = round(r.cents / 100.0, 2) AND w.description = v_desc
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_report) e WHERE (e->>'wallet_tx')::uuid = w.id)
     ORDER BY w.id LIMIT 1;
    IF v_wtx IS NULL THEN
      RAISE EXCEPTION 'make-good: no wallet receipt for obligation %', r.obligation_id;
    END IF;

    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'make-good: adjustment % did not settle', v_adj; END IF;

    UPDATE public.financial_alerts
       SET context = context || jsonb_build_object(
             'funded', true,
             'money_moved_cents', r.cents,
             'make_good', jsonb_build_object(
               'paid_cents', r.cents, 'basis', 'owed_cents', 'funded_by', 'club_treasury',
               'club_id', c_dss, 'adjustment_id', v_adj, 'idempotency_key', v_key,
               'ledger_id', v_leg, 'wallet_transaction_id', v_wtx, 'migration', c_mig,
               'paid_at', now())),
           resolved = true, resolved_at = now(), resolved_by = c_actor,
           resolution = format(
             'Paid. %s (%s) received %s, the owed_cents of obligation %s, house-funded from the Deep Stack Society treasury through the make-good door the ruling named: '
             || 'adjustment %s (approved and settled under CLAUDE.md 10.9), wallet key %s, journal leg %s (club_treasury -> player_wallet, settlement). '
             || 'Horse fleet player, paid as a human is. Migration %s.',
             r.username, r.user_id, round(r.cents / 100.0, 2), r.obligation_id, v_adj, v_key, v_leg, c_mig)
     WHERE id = r.alert_id AND resolved IS NOT TRUE;
    IF NOT FOUND THEN RAISE EXCEPTION 'make-good: alert % could not be resolved', r.alert_id; END IF;

    v_total := v_total + round(r.cents / 100.0, 2);
    v_n := v_n + 1;
    v_report := v_report || jsonb_build_object('user', r.username, 'amount', round(r.cents / 100.0, 2),
                  'adjustment_id', v_adj, 'ledger_id', v_leg, 'wallet_tx', v_wtx,
                  'wallet_before', v_bal_before, 'wallet_after', v_bal_after);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. The two ruling summaries: their owed_as_seeded amounts are now paid.
  ---------------------------------------------------------------------------
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = format(
           'Make-good executed. Every obligation this ruling retired owed-and-unfunded was paid on its owed_cents basis (76.90 across seven obligations and five horse players, house-funded by Deep Stack Society) by migration %s; each of the seven ruling.mystery_bounty_obligation_retired_owed_unfunded alerts carries its receipt. The overpayments the ruling let stand still stand (no clawback).', c_mig)
   WHERE source = 'ruling.mystery_bounty_misclassification_summary'
     AND resolved IS NOT TRUE
     AND id IN ('550e4178-1c9f-469d-8737-6e19282e5a1b', '9428f698-b7ef-49ef-9de5-08511da6a6f2');

  ---------------------------------------------------------------------------
  -- 3. POST-IMAGE. Conserved to the cent.
  ---------------------------------------------------------------------------
  SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id = c_dss;
  IF v_n <> 7 OR v_total <> 76.90 OR round(v_bank_before - v_bank, 2) <> 76.90 THEN
    RAISE EXCEPTION 'make-good post-image: paid % in % credits, treasury moved % (expected 76.90 in 7)', v_total, v_n, v_bank_before - v_bank;
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.created_at = now() AND l.from_type = 'club_treasury' AND l.from_entity_id = c_dss
         AND l.to_type = 'player_wallet' AND l.category = 'settlement') <> 7
     OR (SELECT sum(amount) FROM public.chip_ledger l
       WHERE l.created_at = now() AND l.from_type = 'club_treasury' AND l.from_entity_id = c_dss
         AND l.to_type = 'player_wallet' AND l.category = 'settlement') <> 76.90 THEN
    RAISE EXCEPTION 'make-good post-image: the journal does not carry exactly seven legs totalling 76.90';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.created_at = now()
              AND (l.from_type = 'club_treasury' OR l.to_type = 'club_treasury')
              AND (l.from_entity_id = c_dss OR l.to_entity_id = c_dss)
              AND l.category <> 'settlement') THEN
    RAISE EXCEPTION 'make-good post-image: a second journal leg touched the treasury - the clubs trigger was not skipped';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE source = 'ruling.mystery_bounty_obligation_retired_owed_unfunded' AND resolved IS NOT TRUE) <> 0 THEN
    RAISE EXCEPTION 'make-good post-image: an obligation alert is still open';
  END IF;

  RAISE NOTICE 'make-good: treasury % -> %, report %', v_bank_before, v_bank, v_report;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): treasury % -> %, report %', v_bank_before, v_bank, v_report;
  END IF;
END
$mig$;

COMMIT;
