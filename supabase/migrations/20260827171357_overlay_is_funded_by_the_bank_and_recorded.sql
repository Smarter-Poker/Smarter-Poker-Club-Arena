-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827171357; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- AN OVERLAY IS REAL MONEY AND MUST LEAVE A REAL BANK — Dan 2026-08-27:
-- "IF A GUARANTEED PRIZE POOL FALLS SHORT OR HAS AN OVERLAY THAT MONEY COMES
--  FROM THE UNION BANK, OR THE CLUB BANK IF ITS A STAND ALONE CLUB... THERE
--  MUST BE A TRANSACTION HISTORY OF THOSE CHIPS LEAVING THE BANK TO FUND THE
--  OVERLAY."
--
-- Until now the guarantee was honoured by WRITING A BIGGER NUMBER into
-- tournaments.prize_pool. No bank was debited and nothing was recorded, so
-- every overlay chip was minted from nothing: 136,593.10 chips across 3,393
-- completed guaranteed events, and zero transaction rows to show for it.
--
-- fn_fund_tournament_overlay is the single sanctioned way to apply a
-- guarantee. It is ATOMIC (locks the tournament row), IDEMPOTENT (one funding
-- row per tournament, unique), and it never mints: the shortfall is debited
-- from the union bank, or from the club's own bank when the club has no union.
--
-- It NEVER refuses. A guarantee is a promise already advertised to players —
-- a bank too thin to cover it must not silently shrink the pool mid-event. It
-- funds, drives the bank negative if it must, and files a CRITICAL financial
-- alert naming the shortfall. Loud, not blocking — the same doctrine as the
-- seat-stack-exit trigger and the insurance under-collection alert.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.tournament_overlay_funding (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL UNIQUE,
  club_id         uuid,
  union_id        uuid,
  bank_type       varchar(10) NOT NULL,
  bank_entity_id  uuid,
  guaranteed      numeric NOT NULL,
  pool_before     numeric NOT NULL,
  overlay_amount  numeric NOT NULL,
  bank_before     numeric,
  bank_after      numeric,
  underfunded     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_overlay_funding_created_idx
  ON public.tournament_overlay_funding (created_at DESC);
CREATE INDEX IF NOT EXISTS tournament_overlay_funding_bank_idx
  ON public.tournament_overlay_funding (bank_type, bank_entity_id, created_at DESC);

ALTER TABLE public.tournament_overlay_funding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_overlay_funding FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.fn_fund_tournament_overlay(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_t              record;
  v_union_id       uuid;
  v_bank_type      varchar(10);
  v_bank_entity    uuid;
  v_pool_before    numeric;
  v_gtd            numeric;
  v_overlay        numeric;
  v_bank_before    numeric;
  v_bank_after     numeric;
  v_underfunded    boolean := false;
  v_existing       record;
BEGIN
  SELECT t.id, t.club_id, t.prize_pool, t.guaranteed_prize
    INTO v_t
    FROM tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  -- Idempotent: a tournament's overlay is funded exactly once, ever.
  SELECT * INTO v_existing FROM tournament_overlay_funding
   WHERE tournament_id = p_tournament_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_funded', true,
                              'overlay_amount', v_existing.overlay_amount,
                              'bank_type', v_existing.bank_type);
  END IF;

  v_pool_before := COALESCE(v_t.prize_pool, 0);
  v_gtd         := COALESCE(v_t.guaranteed_prize, 0);
  v_overlay     := ROUND(GREATEST(v_gtd - v_pool_before, 0), 2);

  IF v_overlay <= 0 THEN
    -- The field covered the guarantee. Nothing leaves the bank, and we do NOT
    -- write a funding row, so a later genuine overlay is still fundable.
    RETURN jsonb_build_object('ok', true, 'overlay_amount', 0, 'no_overlay', true);
  END IF;

  SELECT union_id INTO v_union_id FROM clubs WHERE id = v_t.club_id;
  IF v_union_id IS NOT NULL THEN
    v_bank_type := 'union';  v_bank_entity := v_union_id;
  ELSE
    v_bank_type := 'club';   v_bank_entity := v_t.club_id;
  END IF;

  IF v_bank_entity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_bank_resolves');
  END IF;

  -- Debit the bank. Row-locked additive update; may go negative (see header).
  IF v_bank_type = 'union' THEN
    INSERT INTO union_wallets (union_id, chip_balance)
    VALUES (v_bank_entity, 0)
    ON CONFLICT (union_id) DO NOTHING;

    SELECT COALESCE(chip_balance, 0) INTO v_bank_before
      FROM union_wallets WHERE union_id = v_bank_entity FOR UPDATE;

    UPDATE union_wallets
       SET chip_balance = COALESCE(chip_balance, 0) - v_overlay,
           updated_at = now()
     WHERE union_id = v_bank_entity
     RETURNING chip_balance INTO v_bank_after;
  ELSE
    INSERT INTO club_wallets (club_id, chip_balance)
    VALUES (v_bank_entity, 0)
    ON CONFLICT (club_id) DO NOTHING;

    SELECT COALESCE(chip_balance, 0) INTO v_bank_before
      FROM club_wallets WHERE club_id = v_bank_entity FOR UPDATE;

    UPDATE club_wallets
       SET chip_balance = COALESCE(chip_balance, 0) - v_overlay,
           updated_at = now()
     WHERE club_id = v_bank_entity
     RETURNING chip_balance INTO v_bank_after;
  END IF;

  v_underfunded := COALESCE(v_bank_after, 0) < 0;

  -- The prize pool becomes the guarantee, and stops moving.
  UPDATE tournaments
     SET prize_pool = v_gtd,
         prize_pool_finalized = true
   WHERE id = p_tournament_id;

  INSERT INTO tournament_overlay_funding
    (tournament_id, club_id, union_id, bank_type, bank_entity_id,
     guaranteed, pool_before, overlay_amount, bank_before, bank_after, underfunded)
  VALUES
    (p_tournament_id, v_t.club_id, v_union_id, v_bank_type, v_bank_entity,
     v_gtd, v_pool_before, v_overlay, v_bank_before, v_bank_after, v_underfunded);

  -- THE TRANSACTION HISTORY Dan asked for: chips leaving the bank, named.
  INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
     balance_after, metadata)
  VALUES
    (v_t.club_id, NULL, NULL, v_overlay, 'overlay_funding',
     'Overlay funding: ' || v_bank_type || ' bank covered the guarantee shortfall',
     v_bank_after,
     jsonb_build_object('tournament_id', p_tournament_id,
                        'bank_type', v_bank_type,
                        'bank_entity_id', v_bank_entity,
                        'guaranteed', v_gtd,
                        'pool_before', v_pool_before,
                        'underfunded', v_underfunded));

  IF v_underfunded THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical',
      'overlay_funding_drove_bank_negative',
      'Overlay of ' || v_overlay || ' for tournament ' || p_tournament_id ||
      ' drove the ' || v_bank_type || ' bank to ' || v_bank_after,
      jsonb_build_object('tournament_id', p_tournament_id, 'overlay', v_overlay,
                         'bank_type', v_bank_type, 'bank_entity_id', v_bank_entity,
                         'bank_after', v_bank_after));
  END IF;

  RETURN jsonb_build_object('ok', true, 'overlay_amount', v_overlay,
                            'bank_type', v_bank_type, 'bank_after', v_bank_after,
                            'underfunded', v_underfunded);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_fund_tournament_overlay(uuid) FROM PUBLIC, anon;
