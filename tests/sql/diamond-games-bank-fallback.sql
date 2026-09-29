-- Run only in the private Diamond fixture created by test-accounting-delivery.sh.
-- Exercise the real payout writer, money triggers, invoice writer and delivery.
BEGIN;
SET LOCAL statement_timeout = '90s';
SET LOCAL lock_timeout = '2s';

DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'diamond_games_probe'
     OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs
                    WHERE name = 'Isolated Diamond financial probe' AND is_current) THEN
    RAISE EXCEPTION 'bank fallback probe requires its isolated synthetic fixture';
  END IF;
END $$;

-- Compare every persisted public/auth row around a rejected payout, including
-- invoice counters, messages and notifications. Sequences are not row state.
CREATE FUNCTION pg_temp.diamond_bank_rows() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE relation record; rows jsonb; result jsonb := '{}'::jsonb;
BEGIN
  FOR relation IN
    SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'auth')
    ORDER BY n.nspname, c.relname
  LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_value ORDER BY row_value), ''[]''::jsonb)
                    FROM (SELECT to_jsonb(t) AS row_value FROM %I.%I t) rows',
                   relation.nspname, relation.relname) INTO rows;
    result := result || jsonb_build_object(relation.nspname || '.' || relation.relname, rows);
  END LOOP;
  RETURN result;
END $$;

DO $$
DECLARE
  fixture record; wallet_before record; wallet_after record; unrelated_before record; unrelated_after record;
  result record; leg record;
  host uuid; kind text; bank_store uuid; promo_store uuid; member_before numeric; member_after numeric;
  player constant uuid := 'd1000000-0000-4000-8000-000000000001';
  operator constant uuid := 'd1000000-0000-4000-8000-000000000002';
  other_admin constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  key text; first_key text; category text; categories text[] := ARRAY['mines_prize', 'plinko_prize', 'crash_prize', 'crossing_prize'];
  expected_promo numeric; expected_bank numeric; amount numeric; expected_member numeric;
  expected_recipients uuid[];
  ledger_count integer; ledger_total numeric; invoice_count integer; bank_count integer := 0;
  frozen_rows jsonb; affiliated_before jsonb; affiliated_after jsonb; refusal boolean; host_count integer := 0;
BEGIN
  FOR fixture IN SELECT * FROM (VALUES
    ('a0000000-0000-0000-0000-000000000001'::uuid, 'club'::text,
     'a0000000-0000-0000-0000-000000000001'::uuid,
     'd1000000-0000-4000-8000-000000000004'::uuid, 'union'::text),
    ('2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid, 'union'::text,
     'd1000000-0000-4000-8000-000000000004'::uuid,
     'a0000000-0000-0000-0000-000000000001'::uuid, 'club'::text)
  ) AS hosts(club_id, host_kind, host_id, unrelated_host, unrelated_kind)
  LOOP
    host_count := host_count + 1;
    SELECT host_id, host_kind INTO STRICT host, kind FROM public.fn_wheel_host(fixture.club_id);
    IF ROW(host, kind) IS DISTINCT FROM ROW(fixture.host_id, fixture.host_kind) THEN
      RAISE EXCEPTION 'bank fallback host identity mismatch';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', operator::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', operator, 'role', 'authenticated')::text, true);
    SELECT * INTO STRICT wallet_before FROM public.fn_diamond_game_cover_lock(host, kind);
    SELECT * INTO STRICT unrelated_before FROM public.fn_diamond_game_cover_lock(fixture.unrelated_host, fixture.unrelated_kind);
    SELECT jsonb_build_object('promo', c.promo_balance, 'bank', c.chip_treasury) INTO STRICT affiliated_before
      FROM public.clubs c WHERE c.id = fixture.club_id;
    SELECT chip_balance INTO STRICT member_before FROM public.club_members
     WHERE club_id = fixture.club_id AND user_id = player AND status = 'active' FOR UPDATE;
    IF (wallet_before.o_promo >= 0.02 AND wallet_before.o_bank >= 0.04 AND member_before = 0) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'bank fallback fixture starting balances are missing or unsuitable';
    END IF;
    IF kind = 'union' THEN
      SELECT id INTO STRICT bank_store FROM public.union_wallets WHERE union_id = host;
      promo_store := bank_store;
      IF bank_store = host THEN RAISE EXCEPTION 'union fixture must distinguish physical wallet and accounting party'; END IF;
      expected_recipients := ARRAY[player, operator];
    ELSE
      bank_store := host; promo_store := host;
      expected_recipients := ARRAY[player, operator, other_admin];
    END IF;
    SELECT array_agg(x ORDER BY x) INTO expected_recipients FROM unnest(expected_recipients) x;

    first_key := 'diamond-bank-probe:' || kind || ':promo:' || gen_random_uuid();
    SELECT * INTO STRICT result FROM public.fn_diamond_game_pay_chips(
      'mines_prize', host, kind, fixture.club_id, player, 0.01, first_key, 'Isolated Promo Order Proof', '{}'::jsonb);
    IF ROW(result.from_promo, result.from_bank, result.promo_after, result.bank_after,
           result.cover_after, result.member_after)
       IS DISTINCT FROM ROW(0.01::numeric, 0::numeric, wallet_before.o_promo - 0.01,
                            wallet_before.o_bank, wallet_before.o_cover - 0.01, member_before + 0.01) THEN
      RAISE EXCEPTION 'Promo must pay first without debiting the % Main Bank', kind;
    END IF;
    SELECT count(*), sum(l.amount) INTO ledger_count, ledger_total FROM public.chip_ledger l WHERE l.idempotency_key = first_key;
    IF ROW(ledger_count, ledger_total) IS DISTINCT FROM ROW(1, 0.01::numeric)
       OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = first_key || ':bank') THEN
      RAISE EXCEPTION 'Promo-only journal is incorrect for %', kind;
    END IF;
    SELECT * INTO STRICT leg FROM public.chip_ledger WHERE idempotency_key = first_key;
    IF ROW(leg.from_type, leg.from_entity_id, leg.from_label, leg.to_type, leg.to_entity_id,
           leg.amount, leg.category, leg.club_id, leg.union_id, leg.status)
       IS DISTINCT FROM ROW(CASE WHEN kind = 'union' THEN 'union_wallet' ELSE 'promo_wallet' END,
         promo_store, CASE WHEN kind = 'union' THEN 'union_wallets.promo_wallet' ELSE 'clubs.promo_balance' END,
         'player_wallet'::text, player, 0.01::numeric, 'mines_prize'::text,
         CASE WHEN kind = 'union' THEN NULL::uuid ELSE fixture.club_id END,
         CASE WHEN kind = 'union' THEN host ELSE NULL::uuid END, 'posted'::text) THEN
      RAISE EXCEPTION 'Promo journal source, recipient or host identity is wrong';
    END IF;
    IF kind = 'club' AND EXISTS (SELECT 1 FROM public.settlement_invoices WHERE source_ledger_id = leg.id) THEN
      RAISE EXCEPTION 'Club Promo must preserve the existing invoice-trigger predicate';
    END IF;
    expected_member := member_before + 0.01;
    expected_promo := wallet_before.o_promo - 0.01;
    expected_bank := wallet_before.o_bank;

    FOREACH category IN ARRAY categories LOOP
      -- The first payout consumes the remaining Promo and exactly one bank cent.
      -- The other three game categories then exercise the empty-Promo boundary.
      amount := expected_promo + 0.01;
      key := 'diamond-bank-probe:' || kind || ':' || category || ':' || gen_random_uuid();
      SELECT * INTO STRICT result FROM public.fn_diamond_game_pay_chips(
        category, host, kind, fixture.club_id, player, amount, key, 'Isolated Main Bank Proof', '{}'::jsonb);
      expected_member := expected_member + amount;
      expected_bank := expected_bank - 0.01;
      IF ROW(result.from_promo, result.from_bank, result.promo_after, result.bank_after,
             result.cover_after, result.member_after)
         IS DISTINCT FROM ROW(expected_promo, 0.01::numeric, 0::numeric, expected_bank, expected_bank, expected_member) THEN
        RAISE EXCEPTION 'Main Bank must cover only the exact % shortfall for %', category, kind;
      END IF;
      SELECT count(*), sum(l.amount) INTO ledger_count, ledger_total FROM public.chip_ledger l
       WHERE l.idempotency_key IN (key, key || ':bank');
      IF ROW(ledger_count, ledger_total) IS DISTINCT FROM ROW(CASE WHEN expected_promo > 0 THEN 2 ELSE 1 END, amount) THEN
        RAISE EXCEPTION 'split journal does not reconcile for % %', kind, category;
      END IF;
      IF expected_promo > 0 THEN
        SELECT * INTO STRICT leg FROM public.chip_ledger WHERE idempotency_key = key;
        IF ROW(leg.from_type, leg.from_entity_id, leg.from_label, leg.to_type, leg.to_entity_id,
               leg.amount, leg.category, leg.club_id, leg.union_id, leg.status)
           IS DISTINCT FROM ROW(CASE WHEN kind = 'union' THEN 'union_wallet' ELSE 'promo_wallet' END,
             promo_store, CASE WHEN kind = 'union' THEN 'union_wallets.promo_wallet' ELSE 'clubs.promo_balance' END,
             'player_wallet'::text, player, expected_promo, category,
             CASE WHEN kind = 'union' THEN NULL::uuid ELSE fixture.club_id END,
             CASE WHEN kind = 'union' THEN host ELSE NULL::uuid END, 'posted'::text) THEN
          RAISE EXCEPTION 'split Promo journal source, recipient or host identity is wrong';
        END IF;
      END IF;
      SELECT * INTO STRICT leg FROM public.chip_ledger WHERE idempotency_key = key || ':bank';
      IF ROW(leg.from_type, leg.from_entity_id, leg.from_label, leg.to_type, leg.to_entity_id, leg.amount,
             leg.category, leg.club_id, leg.union_id, leg.status)
         IS DISTINCT FROM ROW(CASE WHEN kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
           bank_store, CASE WHEN kind = 'union' THEN 'union_wallets.chip_balance' ELSE 'clubs.chip_treasury' END,
           'player_wallet'::text, player, 0.01::numeric, category,
           CASE WHEN kind = 'union' THEN NULL::uuid ELSE fixture.club_id END,
           CASE WHEN kind = 'union' THEN host ELSE NULL::uuid END, 'posted'::text) THEN
        RAISE EXCEPTION 'bank journal source, recipient or host identity is wrong for % %', kind, category;
      END IF;
      -- Owner ruling 2026-09-21, R17 (migration 20260921202827): a Diamond Spins
      -- prize leg keeps its journal rows and issues NO accounting document,
      -- Messenger invoice, notification or push, for the player or the host
      -- roster. Before that ruling this block required exactly one invoice with
      -- its message and notification per bank leg (20260914121645).
      SELECT count(*) INTO invoice_count FROM public.settlement_invoices WHERE source_ledger_id = leg.id;
      IF invoice_count IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'a Diamond Spins bank leg must issue no accounting document'; END IF;
      IF EXISTS (SELECT 1 FROM public.notifications n WHERE n.type = 'accounting_invoice' AND n.created_at >= leg.created_at
                   AND n.user_id = ANY (expected_recipients))
         OR EXISTS (SELECT 1 FROM public.social_messages m WHERE m.message_type = 'invoice' AND m.created_at >= leg.created_at) THEN
        RAISE EXCEPTION 'a Diamond Spins bank leg must deliver no invoice message or notification';
      END IF;
      expected_promo := 0;
      bank_count := bank_count + 1;
    END LOOP;

    SELECT * INTO STRICT wallet_after FROM public.fn_diamond_game_cover_lock(host, kind);
    IF ROW(wallet_after.o_promo, wallet_after.o_bank, wallet_after.o_cover)
       IS DISTINCT FROM ROW(0::numeric, expected_bank, expected_bank) THEN
      RAISE EXCEPTION 'stored Main Bank balance does not match the payout receipts';
    END IF;
    SELECT chip_balance INTO STRICT member_after FROM public.club_members
      WHERE club_id = fixture.club_id AND user_id = player AND status = 'active';
    IF member_after IS DISTINCT FROM expected_member THEN
      RAISE EXCEPTION 'stored player balance does not match the exact sum of prizes';
    END IF;
    IF kind = 'union' THEN
      SELECT jsonb_build_object('promo', c.promo_balance, 'bank', c.chip_treasury) INTO STRICT affiliated_after
        FROM public.clubs c WHERE c.id = fixture.club_id;
      IF affiliated_after IS DISTINCT FROM affiliated_before THEN
        RAISE EXCEPTION 'Union payout must not debit the affiliated Club wallets';
      END IF;
    END IF;
    SELECT * INTO STRICT unrelated_after FROM public.fn_diamond_game_cover_lock(fixture.unrelated_host, fixture.unrelated_kind);
    IF to_jsonb(unrelated_after) IS DISTINCT FROM to_jsonb(unrelated_before) THEN
      RAISE EXCEPTION 'payout changed another host wallet';
    END IF;
    frozen_rows := pg_temp.diamond_bank_rows();
    refusal := false;
    BEGIN
      PERFORM public.fn_diamond_game_pay_chips('mines_prize', host, kind, fixture.club_id, player,
        expected_bank + 0.01, 'diamond-bank-probe:refusal:' || gen_random_uuid(), 'Isolated Insufficient Cover Proof', '{}'::jsonb);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'diamond games: cover %' THEN RAISE; END IF;
      refusal := true;
    END;
    IF refusal IS DISTINCT FROM true OR pg_temp.diamond_bank_rows() IS DISTINCT FROM frozen_rows THEN
      RAISE EXCEPTION 'insufficient cover must refuse atomically with every persisted row unchanged';
    END IF;
  END LOOP;
  IF ROW(host_count, bank_count) IS DISTINCT FROM ROW(2, 8) THEN
    RAISE EXCEPTION 'bank fallback coverage is incomplete';
  END IF;
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  RAISE NOTICE 'PASS Diamond Main Bank fallback: Union and Club, Promo first, exact shortfall, four game categories, balanced journals, no documents, messages or notifications (owner ruling 2026-09-21 R17), host isolation, atomic insufficient cover';
END $$;
ROLLBACK;
