-- Return an inactive Spin board's outstanding seed once it has no live games.
--
-- A seed is operator capital, not revenue. The old deactivation function left
-- it in the reserve indefinitely even after every sold game was settled. That
-- made a disabled board look like a permanent debit from the club bank.

CREATE OR REPLACE FUNCTION public.fn_spin_deactivate(
  p_club_id uuid,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_owner uuid;
  v_kind text;
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_live_games integer := 0;
  v_seed_returned numeric := 0;
  v_wallet_after numeric := NULL;
  v_balance_after numeric := 0;
  v_seed_returned_total numeric := 0;
  v_actor uuid := COALESCE(p_actor, auth.uid(),
    '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
BEGIN
  v_owner := public.fn_spin_reserve_pool(p_club_id);
  v_kind := public.fn_spin_owner_kind(v_owner);

  SELECT * INTO v_pool
    FROM public.spin_bonus_pools
   WHERE club_id = v_owner
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Spin Reserve Not Found For Owner %', v_owner;
  END IF;

  UPDATE public.spin_bonus_pools
     SET is_active = false,
         deactivated_at = now(),
         updated_at = now()
   WHERE club_id = v_owner;

  SELECT count(*)::integer INTO v_live_games
    FROM public.tournaments t
   WHERE upper(COALESCE(t.tournament_type::text, '')) = 'SPIN'
     AND public.fn_spin_reserve_owner(t.club_id) = v_owner
     AND upper(COALESCE(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED');

  IF COALESCE(v_pool.seeded_amount, 0) > 0
     AND v_pool.seed_source_wallet IS NOT NULL
     AND v_live_games = 0
     AND v_pool.balance >= v_pool.seeded_amount
  THEN
    -- This is one transfer represented by two balance-store updates. Suppress
    -- the generic per-store writers and append one explicit journal row, so a
    -- stale pooled-session category can never misclassify a seed return as
    -- rake (and the same transfer is never counted twice).
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    PERFORM set_config('app.ledger_autoskip_spin_bonus_pools', '1', true);

    v_wallet_after := public.fn_spin_move_owner_wallet(
      v_owner,
      v_kind,
      v_pool.seed_source_wallet,
      v_pool.seeded_amount
    );
    IF v_wallet_after IS NULL THEN
      RAISE EXCEPTION 'Spin Seed Could Not Be Returned To % %',
        v_kind, v_pool.seed_source_wallet;
    END IF;

    UPDATE public.spin_bonus_pools
       SET balance = balance - v_pool.seeded_amount,
           seeded_amount = 0,
           seed_returned_amount = seed_returned_amount + v_pool.seeded_amount,
           seed_returned_at = now(),
           updated_at = now()
     WHERE club_id = v_owner
     RETURNING balance INTO v_balance_after;

    v_seed_returned := v_pool.seeded_amount;
    v_seed_returned_total := COALESCE(v_pool.seed_returned_amount, 0) + v_seed_returned;

    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, from_label,
       to_type, to_entity_id, to_label, amount, category,
       club_id, union_id, description, idempotency_key,
       pre_from_balance, post_from_balance, pre_to_balance, post_to_balance,
       metadata)
    VALUES
      (v_actor, 'spin_reserve', v_owner, 'spin_bonus_pools.balance',
       CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
       v_owner,
       CASE WHEN v_kind = 'union' THEN 'union_wallets.' || v_pool.seed_source_wallet
            ELSE 'clubs.' || v_pool.seed_source_wallet END,
       v_seed_returned, 'reversal',
       CASE WHEN v_kind = 'club' THEN v_owner END,
       CASE WHEN v_kind = 'union' THEN v_owner END,
       'Outstanding Spin Seed Returned After Deactivation And Final Settlement',
       format('spin-deactivation-seed-return:%s:%s', v_owner, v_seed_returned_total),
       v_pool.balance, v_balance_after,
       v_wallet_after - v_seed_returned, v_wallet_after,
       jsonb_build_object('economic_event', 'spin_seed_return',
                          'live_games_at_return', v_live_games,
                          'source_wallet', v_pool.seed_source_wallet));

    INSERT INTO public.spin_reserve_ledger
      (club_id, kind, amount, balance_after, note)
    VALUES
      (v_owner, 'seed_return', -v_seed_returned, v_balance_after,
       format('inactive board seed returned to %s %s after all live Spins settled',
              v_kind, v_pool.seed_source_wallet));
  ELSE
    v_balance_after := v_pool.balance;
  END IF;

  IF v_kind = 'union' THEN
    UPDATE public.clubs
       SET spins_enabled = false,
           spins_preseed_amount = CASE WHEN v_seed_returned > 0 THEN 0
                                       ELSE spins_preseed_amount END,
           updated_at = now()
     WHERE union_id = v_owner;
  ELSE
    UPDATE public.clubs
       SET spins_enabled = false,
           spins_preseed_amount = CASE WHEN v_seed_returned > 0 THEN 0
                                       ELSE spins_preseed_amount END,
           updated_at = now()
     WHERE id = v_owner;
  END IF;

  INSERT INTO public.spin_reserve_ledger (club_id, kind, amount, balance_after, note)
  VALUES (
    v_owner,
    'deactivation',
    0,
    v_balance_after,
    CASE
      WHEN v_seed_returned > 0 THEN
        format('Spins deactivated; %s seed chips returned after all live games settled',
               v_seed_returned)
      WHEN v_live_games > 0 THEN
        format('Spins deactivated; seed remains locked behind %s live games', v_live_games)
      ELSE 'Spins deactivated; no outstanding refundable seed'
    END
  );

  PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_spin_bonus_pools', '', true);

  RETURN jsonb_build_object(
    'ok', true,
    'owner_id', v_owner,
    'balance', v_balance_after,
    'live_games', v_live_games,
    'seed_returned', v_seed_returned,
    'source_wallet_after', v_wallet_after
  );
END;
$fn$;

COMMENT ON FUNCTION public.fn_spin_deactivate(uuid, uuid) IS
  'Stops new Spins. Returns outstanding seed principal only when no live Spin games remain and the reserve can cover the return; settled net proceeds remain in the reserve.';

REVOKE ALL ON FUNCTION public.fn_spin_deactivate(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Production repair for Deep Stack Society (Club 11192). This is deliberately
-- narrow, guarded and idempotent. It calls the same hardened function every
-- club will use rather than editing a balance directly.
DO $repair$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  v_pool public.spin_bonus_pools%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club) THEN
    RETURN;
  END IF;

  SELECT * INTO v_pool
    FROM public.spin_bonus_pools
   WHERE club_id = v_club
   FOR UPDATE;

  IF NOT FOUND OR COALESCE(v_pool.seeded_amount, 0) = 0 THEN
    RETURN;
  END IF;

  IF v_pool.seeded_amount <> 20000
     OR v_pool.seed_source_wallet <> 'chip_treasury'
     OR v_pool.balance < v_pool.seeded_amount
     OR v_pool.is_active
  THEN
    RAISE EXCEPTION 'Deep Stack Spin Repair Guard Failed: Unexpected Pool State';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.club_id = v_club
       AND upper(COALESCE(t.tournament_type::text, '')) = 'SPIN'
       AND upper(COALESCE(t.status::text, '')) NOT IN ('COMPLETED', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'Deep Stack Spin Repair Guard Failed: Live Spin Games Exist';
  END IF;

  v_result := public.fn_spin_deactivate(v_club, NULL);
  IF COALESCE((v_result ->> 'seed_returned')::numeric, 0) <> 20000 THEN
    RAISE EXCEPTION 'Deep Stack Spin Repair Returned %, Expected 20000',
      COALESCE(v_result ->> 'seed_returned', '0');
  END IF;
END;
$repair$;

-- The production repair initially passed through two generic auto-ledger
-- writers before the explicit single-entry path above was added. Preserve the
-- immutable rows and annotate their true economic meaning; neither amount nor
-- hash-covered identity fields are rewritten. Reporting must prefer this
-- canonical classification over the stale pooled-session category.
UPDATE public.chip_ledger
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
     'economic_event', 'spin_seed_return',
     'accounting_classification', 'reversal',
     'not_rake', true,
     'canonical_classification', true)
 WHERE club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid
   AND amount = 20000
   AND category = 'rake'
   AND created_at >= '2026-09-01 01:19:29+00'::timestamptz
   AND created_at < '2026-09-01 01:19:31+00'::timestamptz
   AND description IN (
     'auto-ledgered spin_bonus_pools.balance delta -20000.00',
     'auto-ledgered clubs.chip_treasury delta 20000.00'
   );

DO $verify$
DECLARE
  v_club constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = v_club)
     AND EXISTS (
       SELECT 1
         FROM public.spin_bonus_pools p
         JOIN public.clubs c ON c.id = v_club
        WHERE p.club_id = v_club
          AND (p.seeded_amount <> 0
               OR p.balance <> 873.20
               OR c.chip_treasury <> 103950.80
               OR c.spins_enabled
               OR c.spins_preseed_amount <> 0)
     )
  THEN
    RAISE EXCEPTION 'Deep Stack Spin Repair Postcondition Failed';
  END IF;
END;
$verify$;
