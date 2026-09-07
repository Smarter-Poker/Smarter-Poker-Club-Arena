-- ═══════════════════════════════════════════════════════════════════════════
--  THE MINI JACKPOT IS A FLAT AMOUNT OUT OF THE RESERVE
--  BBJ build plan phase 6 of 6 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's design, signed off 2026-09-07 after the measurement below was put to
-- him. The build plan required exactly that order - "design first, for Dan's
-- sign-off, because it sets future payouts (CLAUDE.md 10.9)".
--
--   qualifying hand   PER GAME: hold'em aces full or better loses;
--                     PLO quads or better loses
--   payout            a FLAT amount per stakes tier
--   split             the main jackpot's, 50 loser / 25 winner / 25 table
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHERE THE NUMBERS COME FROM (derived, not guessed - CLAUDE.md 10.84)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Seven days of live cash play, showdowns where the loser was beaten, pot at
-- or over the existing 10bb payout floor, at exactly the bar Dan chose:
--
--   tier    hold'em/day   PLO/day   total/day
--   ─────────────────────────────────────────
--   nano        1.00        0.14       1.14
--   micro       1.29          -        1.29
--   small       1.00        0.43       1.43
--   mid         0.43          -        0.43
--   high           -          -          0
--   nosebleeds     -          -          0
--                                     ─────
--                                      4.29
--
-- Adding the winner-holds-quads gate this function requires changes none of
-- those counts: anything that beats aces full already is quads or better.
--
-- THE BUDGET IS THE RESERVE'S GROWTH, not its balance. `backup_balance` holds
-- 48,917.35 across the estate and takes **4,522.54 a day** in fresh
-- contributions, and until today nothing spent it:
-- `fn_bbj_reseed_main_from_backup` is its only consumer and fires only when a
-- hit takes 100% of main, which no tier does (nosebleeds is 85%). It is idle
-- money, which is why Dan wanted the mini funded from it.
--
-- The amounts take the shape of `bbj_stakes_tiers.payout_total_pct` (15 / 25 /
-- 40 / 55 / 70 / 85) so a mini scales with stakes the way the main jackpot
-- already does, scaled to spend about half the daily inflow:
--
--   nano 250 · micro 425 · small 700 · mid 950 · high 1,200 · nosebleeds 1,500
--
-- At the measured distribution that is **2,242.75 a day against 4,522.54** -
-- 49.6%. The reserve still grows by ~2,280 a day and the 48,917 already banked
-- is never touched. The two tiers with no observed hits are priced on the same
-- curve rather than left out, because "we have not seen one yet" is not the
-- same as "it cannot happen".
--
-- THEY ARE A CONFIG ROW, NOT CODE. What the next hit owes is Dan's (10.9), so
-- changing any amount is one UPDATE on `bbj_mini_tiers` with no deploy, and
-- `enabled` turns a tier off without deleting the number.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS PROTECTS
-- ═══════════════════════════════════════════════════════════════════════════
--
--   * `bbj_pools.mini_reserve_floor` (5,000 default). The mini may never take
--     the reserve below it, so the main jackpot always has something to reseed
--     from. A mini that cannot be paid IN FULL is refused rather than shrunk -
--     paying a partial would publish one number to the player and pay another.
--   * The same kill switch (`ca_payout_freeze` scope `bbj_payouts`) and the
--     same P0404 error class as the main, so the engine's existing retry queue
--     handles a frozen mini with no new code.
--   * The same idempotency key as the main - `bbj_payouts_pool_table_hand_uidx`
--     - so one hand can produce one payout of either kind and never both.
--   * The same crediting path, `bbj_credit_one_recipient`, so a mini inherits
--     phase 2.3's parked-share behaviour: one recipient with no club wallet
--     parks their share instead of rolling back everybody else's.
--   * `total_paid_out` moves with every mini. Phase 5.3 compares that counter
--     against the `bbj_payouts` rows; a payout that wrote a row and left the
--     counter behind would take `paid_without_a_payout_row_since` negative and
--     the lifetime verdict false. The migration asserts the check still passes.
--
-- Conservation holds by construction: a mini takes X out of `backup_balance`
-- (inside `balances`) and adds X to `bbj_payouts` (inside `outflow`), so the
-- lifetime identity does not move at all.
--
-- ROLLBACK: `DROP FUNCTION public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb);`
-- `DROP TABLE public.bbj_mini_tiers;` and drop the three added columns. No
-- money has moved through it at the time of writing.

BEGIN;

/* bbj_pools takes ~40,000 updates a day, so every AccessExclusiveLock here
   races live play. Fail fast on contention rather than deadlocking against
   PostgREST's own schema reload, and take the hot tables FIRST so the window
   is as short as possible. A lock_timeout refusal is safe to retry; the
   deadlock this replaced rolled the whole migration back. */
SET LOCAL lock_timeout = '8s';

ALTER TABLE public.bbj_pools
  ADD COLUMN IF NOT EXISTS mini_reserve_floor numeric(14,2) NOT NULL DEFAULT 5000.00;
ALTER TABLE public.bbj_payouts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'main';
ALTER TABLE public.bbj_winners ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'main';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bbj_payouts_kind_check') THEN
    ALTER TABLE public.bbj_payouts ADD CONSTRAINT bbj_payouts_kind_check CHECK (kind IN ('main','mini'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bbj_winners_kind_check') THEN
    ALTER TABLE public.bbj_winners ADD CONSTRAINT bbj_winners_kind_check CHECK (kind IN ('main','mini'));
  END IF;
END $$;

COMMENT ON COLUMN public.bbj_pools.mini_reserve_floor IS
  'Backup chips the Mini BBJ may never spend below, so the main jackpot always has something to reseed from (fn_bbj_reseed_main_from_backup). 5,000 by default against a 48,917 reserve growing 4,522/day. Raise it per pool if a club wants a deeper cushion.';

COMMENT ON COLUMN public.bbj_payouts.kind IS
  'main = the jackpot itself, paid as a percentage of main_balance. mini = a flat amount out of the backup reserve for a hand that came close but did not meet the main bar. Every existing row is main, which is what the default says.';

CREATE TABLE IF NOT EXISTS public.bbj_mini_tiers (
  tier_id      text PRIMARY KEY REFERENCES public.bbj_stakes_tiers(id) ON DELETE RESTRICT,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  enabled      boolean NOT NULL DEFAULT true,
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bbj_mini_tiers IS
  'What a Mini BBJ hit pays, flat, per stakes tier (Dan 2026-09-07). A CONFIG ROW, not code: changing what the next mini owes is Dan''s call (CLAUDE.md 10.9) and needs one UPDATE, no deploy. Derived 2026-09-07 from 7 days of live cash play at the qualifying bar Dan chose - 4.29 hits a day against 4,522.54 a day of reserve growth - shaped by bbj_stakes_tiers.payout_total_pct so a mini scales with stakes exactly as the main jackpot does.';

COMMENT ON COLUMN public.bbj_mini_tiers.amount IS
  'Flat chips paid for a mini hit at this tier, split 50 loser / 25 winner / 25 table like the main. At the measured hit distribution these spend 2,242.75 a day against 4,522.54 a day of backup inflow - 49.6%, so the reserve still grows.';

INSERT INTO public.bbj_mini_tiers (tier_id, amount, note) VALUES
  ('nano',        250.00, 'measured 1.14 hits/day; 15% shape'),
  ('micro',       425.00, 'measured 1.29 hits/day; 25% shape'),
  ('small',       700.00, 'measured 1.43 hits/day; 40% shape'),
  ('mid',         950.00, 'measured 0.43 hits/day; 55% shape'),
  ('high',       1200.00, 'no hit observed in 7 days; 70% shape'),
  ('nosebleeds', 1500.00, 'no hit observed in 7 days; 85% shape')
ON CONFLICT (tier_id) DO NOTHING;

ALTER TABLE public.bbj_mini_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY mini_tiers_are_public_reading ON public.bbj_mini_tiers FOR SELECT USING (true);
REVOKE ALL ON public.bbj_mini_tiers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bbj_mini_tiers TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_bbj_mini_payout(
  p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_tier_id text,
  p_loser_user_id uuid, p_winner_user_id uuid,
  p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(applied boolean, already_paid boolean, refused text,
              payout_id uuid, total_payout numeric, loser_share numeric,
              winner_share numeric, table_share numeric, per_player_share numeric,
              backup_after numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_backup numeric; v_floor numeric; v_amount numeric; v_enabled boolean;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric; v_per numeric;
  v_payout_id uuid; v_existing uuid; v_table_ids uuid[]; v_n_table integer;
  v_club_id uuid; v_uid uuid; v_remainder numeric; v_hand_id uuid;
  v_loser_name text; v_winner_name text;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_mini_payout is service only' USING ERRCODE = '42501';
  END IF;

  /* The same kill switch the main jackpot honours, and the same error class,
     so the engine's queue retries a mini frozen mid-flight exactly as it
     retries a main one. */
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
              WHERE f.scope = 'bbj_payouts' AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: jackpot payouts are frozen by the kill switch (ca_payout_freeze scope bbj_payouts); the engine retries when it is cleared'
      USING ERRCODE = 'P0404';
  END IF;

  SELECT amount, enabled INTO v_amount, v_enabled
    FROM public.bbj_mini_tiers WHERE tier_id = p_tier_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'no_mini_amount_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;
  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, false, 'mini_disabled_for_tier'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* IDEMPOTENT ON THE HAND, and it shares the key with the main jackpot on
     purpose: bbj_payouts_pool_table_hand_uidx means one hand can produce one
     payout of either kind and never both. A mini only ever runs when
     detectBBJHit refused the main, so the two cannot race for the same hand -
     and if that ever stops being true, this is where it stops, not a second
     row nobody reconciles. */
  SELECT id INTO v_existing FROM public.bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table
      FROM public.bbj_payouts bp WHERE bp.id = v_existing;
    SELECT COALESCE(backup_balance,0) INTO v_backup FROM public.bbj_pools WHERE id = p_pool_id;
    RETURN QUERY SELECT false, true, NULL::text, v_existing, v_total, v_loser, v_winner,
      v_table, 0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(backup_balance,0), COALESCE(mini_reserve_floor, 0), club_id
    INTO v_backup, v_floor, v_club_id
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pool_not_found'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, 0::numeric;
    RETURN;
  END IF;

  /* THE FLOOR IS NOT NEGOTIABLE AND THE MINI IS NOT SHRUNK TO FIT.
     Paying a partial mini would publish one number to the player and pay
     another; a mini that cannot be paid in full is simply not owed. */
  IF v_backup - v_amount < v_floor THEN
    RETURN QUERY SELECT false, false, 'reserve_at_floor'::text, NULL::uuid,
      0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_backup;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  v_total  := round(v_amount, 2);
  v_loser  := round(v_total * 0.50, 2);
  v_winner := round(v_total * 0.25, 2);
  v_table  := round(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN
    v_per := round(v_table / v_n_table, 2);
  ELSE
    /* Nobody else was dealt in: the table quarter goes to the player who took
       the beat rather than staying in a bank nobody can see. */
    v_per := 0;
    v_loser := round(v_loser + v_table, 2);
    v_table := 0;
  END IF;

  SELECT id INTO v_hand_id FROM public.hand_history
   WHERE table_id = p_table_id AND hand_number = p_hand_number
   ORDER BY created_at DESC LIMIT 1;

  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'bbj_pool', p_pool_id, NULL,
            'bbj_mini:' || p_pool_id::text || ':' || p_table_id::text || ':' || p_hand_number::text, NULL);
  UPDATE public.bbj_pools
     SET backup_balance = GREATEST(0, COALESCE(backup_balance,0) - v_total),
         /* The pool's own paid-out counter moves with every payout of either
            kind. fn_bbj_conservation_check compares that counter against the
            bbj_payouts rows (phase 5.3); a mini that wrote a row and left the
            counter behind would take `paid_without_a_payout_row_since`
            negative and the lifetime verdict false. */
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         updated_at = now()
   WHERE id = p_pool_id
   RETURNING COALESCE(backup_balance,0) INTO v_backup;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO public.bbj_payouts
    (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
     total_amount, winner_share, loser_share, table_share, table_player_count, kind, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_winner_user_id, p_loser_user_id,
          v_total, v_winner, v_loser, v_table, v_n_table, 'mini',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('tier_id', p_tier_id, 'funded_from', 'backup_reserve'))
  RETURNING id INTO v_payout_id;

  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser,
            p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner,
            p_winner_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
  IF v_n_table > 0 AND v_per > 0 THEN
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per,
                v_uid = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END LOOP;
    /* Rounding remainder follows the main's rule: it stays with the beat. */
    v_remainder := round(v_table - (v_per * v_n_table), 2);
    IF v_remainder > 0 THEN
      PERFORM public.bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_remainder,
                p_loser_user_id = ANY(COALESCE(p_seated_ids, ARRAY[]::uuid[])));
    END IF;
  END IF;

  SELECT COALESCE(arena_name, username, 'Player') INTO v_loser_name FROM public.profiles WHERE id = p_loser_user_id;
  SELECT COALESCE(arena_name, username, 'Player') INTO v_winner_name FROM public.profiles WHERE id = p_winner_user_id;

  INSERT INTO public.bbj_winners
    (club_id, pool_id, loser_id, winner_id, loser_payout, winner_payout,
     table_share_payout, total_payout, pool_amount_at_hit, stakes_tier,
     table_id, hand_number, awarded_at, winner_display_name, loser_display_name, kind)
  VALUES (v_club_id, p_pool_id, p_loser_user_id, p_winner_user_id, v_loser, v_winner,
          v_table, v_total, v_backup + v_total, p_tier_id,
          p_table_id, p_hand_number, now(), v_winner_name, v_loser_name, 'mini')
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING;

  RETURN QUERY SELECT true, false, NULL::text, v_payout_id, v_total, v_loser, v_winner,
    v_table, v_per, v_backup;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_mini_payout(uuid, uuid, bigint, text, uuid, uuid, uuid[], uuid[], jsonb) TO service_role;

DO $$
DECLARE v_n int; v_sum numeric; v jsonb;
BEGIN
  SELECT count(*), sum(amount) INTO v_n, v_sum FROM public.bbj_mini_tiers;
  IF v_n <> 6 THEN RAISE EXCEPTION 'expected a mini amount for all six tiers, got %', v_n; END IF;
  IF v_sum <> 5025.00 THEN RAISE EXCEPTION 'the derived amounts changed: %', v_sum; END IF;

  IF EXISTS (SELECT 1 FROM public.bbj_payouts WHERE kind <> 'main') THEN
    RAISE EXCEPTION 'every payout that existed before the mini must read as main';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_bbj_mini_payout(uuid,uuid,bigint,text,uuid,uuid,uuid[],uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can pay a mini jackpot';
  END IF;

  /* The phase-5 lifetime identity must be untouched by adding the column. */
  v := public.fn_bbj_conservation_check();
  IF NOT (v->>'lifetime_healthy')::boolean OR NOT (v->>'healthy')::boolean THEN
    RAISE EXCEPTION 'the conservation check broke while the mini was added: %', v;
  END IF;
END $$;

COMMIT;
