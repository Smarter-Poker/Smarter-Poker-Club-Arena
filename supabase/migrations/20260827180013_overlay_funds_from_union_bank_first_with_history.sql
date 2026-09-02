-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827180013; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- OVERLAY FUNDS FROM THE UNION BANK FIRST, AND LEAVES A TRANSACTION HISTORY
-- Dan 2026-08-27:
--   "IF A GUARANTEED PRIZE POOL FALLS SHORT OR HAS AN OVERLAY THAT MONEY
--    COMES FROM THE UNION BANK, OR THE CLUB BANK IF ITS A STAND ALONE CLUB
--    NOT ATTACHED TO A UNION. THERE MUST BE A TRANSACTION HISTORY OF THOSE
--    CHIPS LEAVING THE BANK TO FUND THE OVERLAY."
--
-- fn_apply_prize_guarantee (shipped earlier today) already funds the overlay
-- atomically and idempotently — that part is kept exactly as it is. Two things
-- did not match the instruction:
--
--   1. It always debited clubs.chip_treasury, even when the club belongs to a
--      union. The union bank is the funder for an affiliated club; the club's
--      own bank pays only when the club is STANDALONE.
--   2. It recorded the overlay in tournament_guarantee_overlays but wrote NO
--      chip_transactions row, so the chips left a bank with no transaction
--      history — the specific thing Dan asked for.
--
-- This rewrites the funding half only. The claim/idempotency (PK-claimed
-- INSERT ... ON CONFLICT DO NOTHING), the finalization, the negative-bank
-- alert and the return shape are preserved, so the three engine call sites
-- already on main need no change.
--
-- I also drop the parallel implementation I had started building before this
-- one appeared on main (fn_fund_tournament_overlay + tournament_overlay_funding
-- + ca_club_overlay_pnl). Two competing overlay systems is exactly the
-- duplicate-infrastructure trap RULE 12 forbids; this is the canonical one.
-- ═══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.ca_club_overlay_pnl(uuid, integer);
DROP FUNCTION IF EXISTS public.fn_fund_tournament_overlay(uuid);
DROP TABLE IF EXISTS public.tournament_overlay_funding;

ALTER TABLE public.tournament_guarantee_overlays
  ADD COLUMN IF NOT EXISTS bank_type varchar(10),
  ADD COLUMN IF NOT EXISTS bank_entity_id uuid,
  ADD COLUMN IF NOT EXISTS union_id uuid;

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_treasury numeric;
  v_union_id uuid; v_bank_type varchar(10); v_bank_entity uuid;
BEGIN
  SELECT t.id, t.club_id, t.name, COALESCE(t.prize_pool, 0) AS pool,
         COALESCE(t.guaranteed_prize, 0) AS gtd, COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_t.finalized THEN
    RETURN jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  END IF;

  v_final := GREATEST(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  IF v_overlay > 0 THEN
    -- WHOSE BANK: the union's when the club belongs to one, otherwise the
    -- standalone club's own treasury.
    SELECT union_id INTO v_union_id FROM public.clubs WHERE id = v_t.club_id;
    IF v_union_id IS NOT NULL THEN
      v_bank_type := 'union';  v_bank_entity := v_union_id;
    ELSE
      v_bank_type := 'club';   v_bank_entity := v_t.club_id;
    END IF;

    INSERT INTO public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source,
       bank_type, bank_entity_id, union_id)
    VALUES (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final,
            COALESCE(p_source, 'engine'), v_bank_type, v_bank_entity, v_union_id)
    ON CONFLICT (tournament_id) DO NOTHING;
    GET DIAGNOSTICS v_claimed = ROW_COUNT;

    IF v_claimed = 0 THEN
      UPDATE public.tournaments SET prize_pool_finalized = true WHERE id = p_tournament_id;
      RETURN jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    END IF;

    IF v_bank_type = 'union' THEN
      INSERT INTO public.union_wallets (union_id, chip_balance)
      VALUES (v_bank_entity, 0) ON CONFLICT (union_id) DO NOTHING;

      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) - v_overlay,
             updated_at = now()
       WHERE union_id = v_bank_entity
       RETURNING chip_balance INTO v_treasury;
    ELSE
      UPDATE public.clubs
         SET chip_treasury = COALESCE(chip_treasury, 0) - v_overlay,
             updated_at = now()
       WHERE id = v_bank_entity
       RETURNING chip_treasury INTO v_treasury;
    END IF;

    UPDATE public.tournament_guarantee_overlays
       SET treasury_after = v_treasury
     WHERE tournament_id = p_tournament_id;

    -- THE TRANSACTION HISTORY: chips leaving the bank to fund the overlay.
    INSERT INTO public.chip_transactions
      (club_id, from_user_id, to_user_id, amount, transaction_type, notes,
       balance_after, metadata)
    VALUES
      (v_t.club_id, NULL, NULL, v_overlay, 'overlay_funding',
       'Overlay funding: ' || v_bank_type || ' bank covered the guarantee shortfall on ' ||
         COALESCE(v_t.name, 'tournament'),
       v_treasury,
       jsonb_build_object('tournament_id', p_tournament_id,
                          'bank_type', v_bank_type,
                          'bank_entity_id', v_bank_entity,
                          'union_id', v_union_id,
                          'guaranteed', v_t.gtd,
                          'pool_before', v_t.pool,
                          'source', COALESCE(p_source, 'engine')));

    IF v_treasury IS NOT NULL AND v_treasury < 0 THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_apply_prize_guarantee',
              'Guarantee overlay drove the ' || v_bank_type || ' bank negative: ' ||
                COALESCE(v_t.name, 'tournament'),
              jsonb_build_object('tournament_id', p_tournament_id, 'club_id', v_t.club_id,
                                 'bank_type', v_bank_type, 'bank_entity_id', v_bank_entity,
                                 'overlay', v_overlay, 'treasury_after', v_treasury));
    END IF;
  END IF;

  UPDATE public.tournaments
     SET prize_pool = v_final, prize_pool_finalized = true
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', COALESCE(v_overlay, 0), 'treasury_after', v_treasury,
    'bank_type', v_bank_type);
END;
$function$;
