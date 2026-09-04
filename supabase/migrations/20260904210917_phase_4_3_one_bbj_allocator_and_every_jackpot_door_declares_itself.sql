-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4.3 - ONE BBJ ALLOCATOR, AND EVERY JACKPOT DOOR DECLARES ITSELF
-- (chip standard, 2026-09-04). Read from production 20:40-21:10 UTC.
--
-- What was true.
--   1. Two allocators disagreed. The engine (RakeConfig.ts) splits a drop
--      50/25/25 main/backup/promo below the pivot and 25/25/50 at or above
--      it (Dan, 2026-08-18: "pivot is 25/25/50") and sends the three portions;
--      bbj_record_contribution IGNORED them and always allocated 50/25/25 by
--      cumulative rounding. The union pool's main crossed 100,000 at
--      2026-09-03 07:13:51.966 UTC and never dipped below; every drop since
--      (50,279 rows / 16,922.41 chips at the time of reading) put 50% into
--      main where the rule says 25%. fn_bbj_repair_unbanked, the third
--      allocator, did honour the pivot. Now there is one: fn_bbj_allocate,
--      reading ca_bbj_policy, used by the drop, the repair and nothing else;
--      the engine's portions are accepted and ignored. The mis-bucketed
--      amount is moved main -> promo in this migration, asserted from the
--      rows (a bank move inside the pool: chips are conserved, nobody is paid
--      or charged; promo is swept to the union's promo wallet by the sweep
--      that already runs, exactly as the rule intended).
--   2. Bank moves inside a pool were invisible. The reseed (backup -> main on
--      a 100% hit) and the union's backup transfer wrote the columns and
--      nothing else; the autoledger journalled them as bbj_pool ->
--      settlement_suspense. Now every move goes through
--      fn_bbj_move_between_banks: declared (bbj_pool -> bbj_pool, the two
--      bucket labels), recorded in ca_bbj_bucket_moves with a reason and an
--      op id, refused if the source bank cannot cover it.
--   3. The reserve could run dry in silence. A 100% hit with an empty backup
--      restarted main at 0 and nothing said so. The reseed now files a
--      bbj_error incident when it finds the reserve empty.
--   4. The payout was undeclared. bbj_atomic_payout_v2's pool debit fell to
--      settlement_suspense (no payout has happened in 7 days, which is the
--      only reason the suspense count read 0), and a departed recipient's
--      share went to their HOME club wallet through credit_player_wallet -
--      not the wallet they bought in from. Now: the pool debit is declared
--      bbj_payout -> table_stack (the felt of the hitting table); a seated
--      recipient's seat is credited (the felt is derived, no leg); a departed
--      recipient's share is a keyed credit to the wallet of the TABLE's club,
--      declared table_stack -> player_wallet, key bbj:<payout>:<user>.
--      bbj_credit_one_recipient was executable by authenticated (RLS would
--      have refused the recipient insert, so it was not exploitable, but a
--      money door a browser can call is a door too many): service only.
--   5. Union funding and the backup transfer were undeclared, and funding
--      also added to pool_amount, a dead counter the autoledger still
--      journalled as bbj_pool, so a funded amount was journalled twice. Both
--      doors declare now; pool_amount is no longer written or journalled.
--   0. The drift-incident scope admitted Midway Union and its clubs only:
--      an incident about Deep Stack Society - one of Dan's four estates -
--      was dropped before it was filed. Found in the rolled-back probe when
--      the reserve-empty incident for Deep Stack's pool never appeared.
--      Deep Stack is in scope now.
--   6. Seven retired stubs (add_bbj_contribution x3, award_bbj,
--      bbj_atomic_payout, bbj_promo_payout, fn_bbj_payout,
--      fn_union_bbj_pool_payout) refuse every call and have 0 calls; closed
--      to every role and registered closed, DROP with the Phase 3.3 list.
--
-- One transaction. Probed rolled-back first. Every number asserted.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. Deep Stack Society's incidents file ────────────────────────────────
-- The drift-incident scope (fn_ca_is_midway_scope) admitted Midway Union and
-- its clubs and dropped everything else on the floor, including one of the
-- four estates. Found because the reserve-empty incident below never filed
-- for Deep Stack's pool in the rolled-back probe.
CREATE OR REPLACE FUNCTION public.fn_ca_is_midway_scope(p_union_id uuid DEFAULT NULL::uuid, p_club_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((
    -- THE FOUR ESTATES (Dan, 2026-09-03): Midway Union with Club JAQK and
    -- SHARK CLUB inside it, and Deep Stack Society standing alone. Until
    -- chip standard Phase 4.3 (2026-09-04) this scope was Midway only, so an
    -- incident about Deep Stack Society's money - its jackpot reserve running
    -- dry, a payout that could not reconcile - was dropped before it was
    -- filed. Deep Stack is an estate; its incidents file.
    -- platform-substrate incidents: no entity dimension anywhere = global
    -- checks (supply, suspense, guards, crons, diamonds) that protect every
    -- union including Midway. These always file.
    (p_union_id IS NULL AND p_club_id IS NULL AND p_table_id IS NULL
     AND p_tournament_id IS NULL
     AND COALESCE(p_metadata->>'union_id','') = ''
     AND COALESCE(p_metadata->>'club_id','') = '')
    OR p_union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    OR p_club_id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.union_clubs uc
       WHERE uc.club_id = p_club_id
         AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
    )
    OR EXISTS (
      SELECT 1 FROM public.tables t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_table_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR EXISTS (
      SELECT 1 FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
       WHERE t.id = p_tournament_id
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )
    OR COALESCE(p_metadata->>'union_id', '') = 'fade0000-0000-0000-0000-000000000001'
    OR EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id::text = COALESCE(p_metadata->>'club_id', '')
         AND (
           c.id IN ('fade0000-0000-0000-0000-000000000001'::uuid, '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid)
           OR c.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           OR EXISTS (
             SELECT 1 FROM public.union_clubs uc
              WHERE uc.club_id = c.id
                AND uc.union_id = 'fade0000-0000-0000-0000-000000000001'::uuid
           )
         )
    )), false);
$function$;

-- ── 1. The policy and the one allocator ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_bbj_policy (
  id              int PRIMARY KEY CHECK (id = 1),
  pivot_threshold numeric NOT NULL CHECK (pivot_threshold > 0),
  standard_main   numeric NOT NULL CHECK (standard_main >= 0 AND standard_main <= 1),
  standard_backup numeric NOT NULL CHECK (standard_backup >= 0 AND standard_backup <= 1),
  pivot_main      numeric NOT NULL CHECK (pivot_main >= 0 AND pivot_main <= 1),
  pivot_backup    numeric NOT NULL CHECK (pivot_backup >= 0 AND pivot_backup <= 1),
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (standard_main + standard_backup <= 1),
  CHECK (pivot_main + pivot_backup <= 1)
);
INSERT INTO public.ca_bbj_policy (id, pivot_threshold, standard_main, standard_backup, pivot_main, pivot_backup, note)
VALUES (1, 100000, 0.50, 0.25, 0.25, 0.25,
        'Dan 2026-08-18: below the pivot a drop is 50% main / 25% backup / 25% promo; at or above 100,000 in main it is 25 / 25 / 50. Promo is always the remainder. Mirrors server/src/config/RakeConfig.ts; the database is the allocator.')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.ca_bbj_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_bbj_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_bbj_policy TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_allocate(p_amount numeric, p_main_balance numeric)
 RETURNS TABLE(main_portion numeric, backup_portion numeric, promo_portion numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pol public.ca_bbj_policy%ROWTYPE;
  v_rm numeric; v_rb numeric; v_amt numeric := round(COALESCE(p_amount, 0), 2);
BEGIN
  SELECT * INTO v_pol FROM public.ca_bbj_policy WHERE id = 1;
  IF COALESCE(p_main_balance, 0) >= v_pol.pivot_threshold THEN
    v_rm := v_pol.pivot_main; v_rb := v_pol.pivot_backup;
  ELSE
    v_rm := v_pol.standard_main; v_rb := v_pol.standard_backup;
  END IF;
  main_portion   := round(v_amt * v_rm, 2);
  backup_portion := round(v_amt * v_rb, 2);
  -- Promo takes the remainder, so the three always re-sum to the drop.
  promo_portion  := round(v_amt - main_portion - backup_portion, 2);
  RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_allocate(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_allocate(numeric, numeric) TO service_role;

-- ── 2. Bank moves inside a pool are declared and recorded ─────────────────
CREATE TABLE IF NOT EXISTS public.ca_bbj_bucket_moves (
  id           bigserial PRIMARY KEY,
  pool_id      uuid NOT NULL,   -- no FK on purpose: a REFERENCES on the hot bbj_pools table holds a lock on it for the whole apply; fn_bbj_move_between_banks checks the pool exists
  from_bank    text NOT NULL CHECK (from_bank IN ('main', 'backup', 'promo')),
  to_bank      text NOT NULL CHECK (to_bank IN ('main', 'backup', 'promo')),
  amount       numeric NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 10),
  op_id        text NOT NULL UNIQUE,
  performed_by uuid,
  db_role      text NOT NULL DEFAULT current_user,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_bank <> to_bank)
);
CREATE INDEX IF NOT EXISTS ca_bbj_bucket_moves_pool_idx ON public.ca_bbj_bucket_moves (pool_id, created_at DESC);
ALTER TABLE public.ca_bbj_bucket_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_bbj_bucket_moves FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_bbj_bucket_moves TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_move_between_banks(p_pool_id uuid, p_from_bank text, p_to_bank text, p_amount numeric, p_reason text, p_op_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amt numeric := round(COALESCE(p_amount, 0), 2);
  v_pool public.bbj_pools%ROWTYPE; v_have numeric; v_prior public.ca_bbj_bucket_moves%ROWTYPE;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_bbj_move_between_banks is service only' USING ERRCODE = '42501';
  END IF;
  IF p_from_bank NOT IN ('main', 'backup', 'promo') OR p_to_bank NOT IN ('main', 'backup', 'promo') OR p_from_bank = p_to_bank THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'banks_must_be_two_of_main_backup_promo');
  END IF;
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 OR COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_bank_move_needs_a_reason_and_an_op_id');
  END IF;
  SELECT * INTO v_prior FROM public.ca_bbj_bucket_moves WHERE op_id = p_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'move_id', v_prior.id, 'amount', v_prior.amount);
  END IF;
  SELECT * INTO v_pool FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_not_found');
  END IF;
  v_have := CASE p_from_bank WHEN 'main' THEN v_pool.main_balance WHEN 'backup' THEN v_pool.backup_balance ELSE v_pool.promo_balance END;
  IF COALESCE(v_have, 0) < v_amt THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_bank_cannot_cover_it', 'available', COALESCE(v_have, 0), 'requested', v_amt);
  END IF;
  -- Declared as bbj_pool -> bbj_pool: the chips change bank, not account. The
  -- autoledger writes one leg per bucket column with its label, which is what
  -- the per-bank reconcile reads.
  PERFORM public.fn_ca_declare_ledger('adjustment', 'bbj_pool', p_pool_id, NULL, NULL, NULL);
  UPDATE public.bbj_pools
     SET main_balance   = main_balance   + CASE WHEN p_to_bank = 'main'   THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'main'   THEN v_amt ELSE 0 END,
         backup_balance = backup_balance + CASE WHEN p_to_bank = 'backup' THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'backup' THEN v_amt ELSE 0 END,
         promo_balance  = promo_balance  + CASE WHEN p_to_bank = 'promo'  THEN v_amt ELSE 0 END - CASE WHEN p_from_bank = 'promo'  THEN v_amt ELSE 0 END,
         updated_at = now()
   WHERE id = p_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  INSERT INTO public.ca_bbj_bucket_moves (pool_id, from_bank, to_bank, amount, reason, op_id, performed_by)
  VALUES (p_pool_id, p_from_bank, p_to_bank, v_amt, btrim(p_reason), p_op_id, auth.uid())
  RETURNING * INTO v_prior;
  RETURN jsonb_build_object('ok', true, 'replayed', false, 'move_id', v_prior.id, 'amount', v_amt,
                            'from_bank', p_from_bank, 'to_bank', p_to_bank);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_move_between_banks(uuid, text, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_move_between_banks(uuid, text, text, numeric, text, text) TO service_role;

-- ── 3. The reseed is a recorded move, and an empty reserve is said out loud ─
CREATE OR REPLACE FUNCTION public.fn_bbj_reseed_main_from_backup(p_pool_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_main numeric; v_backup numeric; v_res jsonb; v_union uuid; v_club uuid;
BEGIN
  SELECT COALESCE(main_balance, 0), COALESCE(backup_balance, 0), union_id, club_id
    INTO v_main, v_backup, v_union, v_club
    FROM public.bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF NOT FOUND OR v_main > 0 THEN
    RETURN COALESCE(v_main, 0);
  END IF;
  IF v_backup <= 0 THEN
    -- The reserve is empty: the jackpot restarts at zero. Not refused (the
    -- hit has been paid and the pool is what it is), but never silent.
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_bbj_reseed_main_from_backup', 'bbj_error', 'warning',
      'bbj-reserve-empty:' || p_pool_id::text || ':' || to_char(now(), 'YYYY-MM-DD-HH24'),
      0, NULL, 0, 'ledger', 'bbj_pools', p_pool_id, v_club, v_union, NULL, NULL, NULL, NULL, NULL, NULL,
      'a 100% hit drained the main jackpot and the backup reserve was empty, so the jackpot restarts at 0; fund the reserve (fn_union_fund_bbj_pool) or accept the restart',
      true, jsonb_build_object('pool_id', p_pool_id));
    RETURN 0;
  END IF;
  v_res := public.fn_bbj_move_between_banks(p_pool_id, 'backup', 'main', v_backup,
             'reseed: a hit took 100% of main; the reserve becomes the new main jackpot',
             'reseed:' || p_pool_id::text || ':' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'));
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reseed failed: %', v_res;
  END IF;
  RETURN v_backup;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_reseed_main_from_backup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_reseed_main_from_backup(uuid) TO service_role;

-- ── 4. The drop is allocated by the policy, whatever the caller sends ──────
CREATE OR REPLACE FUNCTION public.bbj_record_contribution(p_pool_id uuid, p_hand_id uuid DEFAULT NULL::uuid, p_table_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT 0, p_main_portion numeric DEFAULT 0, p_backup_portion numeric DEFAULT 0, p_promo_portion numeric DEFAULT 0, p_big_blind numeric DEFAULT 2.00, p_hand_number integer DEFAULT NULL::integer, p_club_id uuid DEFAULT NULL::uuid)
 RETURNS bbj_contributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
    v_contribution bbj_contributions;
    v_prev_cum numeric;
    v_main_now numeric;
    v_main     numeric;
    v_backup   numeric;
    v_promo    numeric;
BEGIN
    IF p_hand_id IS NULL THEN
        IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id = p_table_id
               AND hand_number = p_hand_number
             ORDER BY created_at
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id IS NOT DISTINCT FROM p_table_id
               AND hand_number IS NOT DISTINCT FROM p_hand_number
             ORDER BY created_at
             LIMIT 1;
        END IF;

        IF v_contribution.id IS NOT NULL THEN
            RETURN v_contribution;
        END IF;
    END IF;

    SELECT COALESCE(alloc_cum_amount, 0), COALESCE(main_balance, 0) INTO v_prev_cum, v_main_now
      FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bbj_record_contribution: pool % not found', p_pool_id;
    END IF;

    /* ONE ALLOCATOR (chip standard Phase 4.3, 2026-09-04). The split is the
       policy's, read against the pool's main balance under the lock. The
       caller's p_main_portion / p_backup_portion / p_promo_portion are
       accepted for the signature's sake and ignored: the engine computed them
       from a cached balance and, before today, this function ignored them the
       other way (always 50/25/25). alloc_cum_amount is kept running for
       continuity; it no longer decides anything. */
    SELECT a.main_portion, a.backup_portion, a.promo_portion INTO v_main, v_backup, v_promo
      FROM public.fn_bbj_allocate(COALESCE(p_amount, 0), v_main_now) a;

    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        v_main, v_backup, v_promo, p_big_blind, p_hand_number
    )
    ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;

    IF v_contribution.id IS NULL THEN
        IF p_hand_id IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id = p_hand_id
             LIMIT 1;
        ELSIF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
               AND table_id = p_table_id AND hand_number = p_hand_number
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
             LIMIT 1;
        END IF;
        RETURN v_contribution;
    END IF;

    /* ZERO-DRIFT (2026-08-31): the pool credit below auto-journals via
       trg_ca_autoledger; declare what it is. */
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(p_table_id::text, ''), true);

    UPDATE bbj_pools
    SET
        main_balance      = main_balance   + v_main,
        backup_balance    = backup_balance + v_backup,
        promo_balance     = promo_balance  + v_promo,
        total_contributed = total_contributed + p_amount,
        alloc_cum_amount  = v_prev_cum + COALESCE(p_amount, 0),
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at        = now()
    WHERE id = p_pool_id;

    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);

    RETURN v_contribution;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_record_contribution(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric, integer, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
 RETURNS TABLE(hand_id uuid, table_id uuid, club_id uuid, pool_id uuid, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_pool_id uuid; v_main numeric; v_backup numeric; v_promo numeric;
  v_current_main numeric; v_inserted uuid;
BEGIN
  FOR r IN
    SELECT rr.hand_id AS h_id, rr.table_id AS t_id, rr.club_id AS c_id,
           SUM(rr.bbj_contribution) AS amt,
           MAX(COALESCE((rr.metadata->>'big_blind')::numeric, 0)) AS bb,
           MIN(rr.created_at) AS hand_at
    FROM public.rake_records rr
    WHERE rr.hand_id IS NOT NULL
      AND COALESCE(rr.bbj_contribution, 0) > 0
      AND rr.created_at > now() - make_interval(hours => p_since_hours)
      AND rr.created_at < now() - interval '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = rr.hand_id)
    GROUP BY rr.hand_id, rr.table_id, rr.club_id
    ORDER BY MIN(rr.created_at)
    LIMIT p_limit
  LOOP
    SELECT bp.id, bp.main_balance INTO v_pool_id, v_current_main
    FROM public.bbj_pools bp
    WHERE bp.status = 'active'
      AND ((bp.union_id = (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id))
        OR (bp.club_id = r.c_id AND (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id) IS NULL))
    ORDER BY (bp.union_id IS NOT NULL) DESC
    LIMIT 1;

    CONTINUE WHEN v_pool_id IS NULL;

    -- ONE ALLOCATOR (Phase 4.3): the same split the drop uses.
    SELECT a.main_portion, a.backup_portion, a.promo_portion INTO v_main, v_backup, v_promo
      FROM public.fn_bbj_allocate(r.amt, v_current_main) a;

    -- ZERO-DRIFT phase 2: repaired drops = bbj_contribution vs table_stack.
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(r.t_id::text, ''), true);

    WITH ins AS (
      INSERT INTO public.bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number, created_at
      )
      SELECT v_pool_id, r.h_id, r.t_id, r.c_id, r.amt,
             v_main, v_backup, v_promo, NULLIF(r.bb, 0), NULL, r.hand_at
      WHERE NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = r.h_id)
      RETURNING id
    ),
    upd AS (
      UPDATE public.bbj_pools bp
      SET main_balance      = bp.main_balance + v_main,
          backup_balance    = bp.backup_balance + v_backup,
          promo_balance     = bp.promo_balance + v_promo,
          total_contributed = COALESCE(bp.total_contributed, 0) + r.amt,
          hands_contributed = COALESCE(bp.hands_contributed, 0) + 1,
          updated_at        = now()
      FROM ins WHERE bp.id = v_pool_id RETURNING bp.id
    )
    SELECT ins.id INTO v_inserted FROM ins;

    IF v_inserted IS NOT NULL THEN
      hand_id := r.h_id; table_id := r.t_id; club_id := r.c_id;
      pool_id := v_pool_id; amount := r.amt;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) TO service_role;

-- ── 5. The payout declares itself and pays the wallet the player bought in from
CREATE OR REPLACE FUNCTION public.bbj_credit_one_recipient(p_payout_id uuid, p_table_id uuid, p_user_id uuid, p_amount numeric, p_seated boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_claimed integer; v_club uuid; v_after numeric; v_key text;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient is service only' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN false;
  END IF;

  INSERT INTO bbj_payout_recipients (payout_id, user_id, amount)
  VALUES (p_payout_id, p_user_id, p_amount)
  ON CONFLICT (payout_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;  -- already credited under this payout
  END IF;

  IF p_seated THEN
    -- The felt is a derived account: the pool debit (bbj_pool -> table_stack)
    -- is the leg, and the seat row simply holds the chips. Delta-mode hand
    -- writes preserve a credit the engine has not seen yet.
    UPDATE table_seats
       SET stack = COALESCE(stack, 0) + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
    IF FOUND THEN
      RETURN true;
    END IF;
    -- Seat vanished since the engine snapshot: fall through to the wallet.
  END IF;

  /* A departed recipient is paid to the wallet of the TABLE's club - the one
     the seat was bought in from - never to a "home" club. Keyed, so a replay
     of the payout cannot pay twice; declared as the felt paying out to the
     wallet, which is what the pool debit already put on the felt. */
  v_key := 'bbj:' || p_payout_id::text || ':' || p_user_id::text;
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (v_key, p_user_id, p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN false;
  END IF;

  SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = p_table_id;
  IF v_club IS NULL THEN
    SELECT s.club_id INTO v_club FROM public.table_seats s
     WHERE s.table_id = p_table_id AND s.user_id = p_user_id ORDER BY s.joined_at DESC LIMIT 1;
  END IF;
  IF v_club IS NULL THEN
    v_club := public.fn_player_home_club(p_user_id, NULL);
  END IF;
  IF v_club IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient: no club wallet resolves for % at table %', p_user_id, p_table_id;
  END IF;
  PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL, v_key, NULL);
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE user_id = p_user_id AND club_id = v_club
   RETURNING chip_balance INTO v_after;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'bbj_credit_one_recipient: the club wallet for % in % did not take the credit', p_user_id, v_club;
  END IF;
  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, table_id)
  VALUES (v_club, NULL, p_user_id, p_amount, 'bbj_payout',
          'Bad Beat Jackpot share paid to your club wallet (you had left the table)', v_after, p_table_id);
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_credit_one_recipient(uuid, uuid, uuid, numeric, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_credit_one_recipient(uuid, uuid, uuid, numeric, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.bbj_atomic_payout_v2(p_pool_id uuid, p_table_id uuid, p_hand_number bigint, p_payout_total_percent numeric, p_loser_user_id uuid, p_winner_user_id uuid, p_dealt_in_ids uuid[], p_seated_ids uuid[], p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(applied boolean, already_paid boolean, recovered boolean, payout_id uuid, total_payout numeric, loser_share numeric, winner_share numeric, table_share numeric, per_player_share numeric, balance_after numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_main numeric; v_backup numeric;
  v_total numeric; v_loser numeric; v_winner numeric; v_table numeric;
  v_per numeric; v_remainder numeric; v_payout_id uuid; v_existing uuid;
  v_club_id uuid; v_pre_hit_balance numeric; v_winner_name text; v_loser_name text;
  v_table_ids uuid[]; v_n_table integer; v_recovered boolean := false; v_uid uuid;
  v_hand_id uuid;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 is service only' USING ERRCODE = '42501';
  END IF;
  IF p_payout_total_percent IS NULL OR p_payout_total_percent <= 0 OR p_payout_total_percent > 100 THEN
    RAISE EXCEPTION 'bbj payout percent % out of range (0,100]', p_payout_total_percent;
  END IF;

  SELECT COALESCE(array_agg(x), ARRAY[]::uuid[]) INTO v_table_ids
    FROM unnest(COALESCE(p_dealt_in_ids, ARRAY[]::uuid[])) AS x
   WHERE x <> p_loser_user_id AND x <> p_winner_user_id;
  v_n_table := COALESCE(array_length(v_table_ids, 1), 0);

  SELECT id INTO v_existing FROM bbj_payouts
   WHERE pool_id = p_pool_id AND table_id = p_table_id AND hand_number = p_hand_number LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT bp.total_amount, bp.loser_share, bp.winner_share, bp.table_share
      INTO v_total, v_loser, v_winner, v_table FROM bbj_payouts bp WHERE bp.id = v_existing;
    IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    IF bbj_credit_one_recipient(v_existing, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    FOREACH v_uid IN ARRAY v_table_ids LOOP
      IF bbj_credit_one_recipient(v_existing, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids)) THEN v_recovered := true; END IF;
    END LOOP;

    -- A replay is also the second chance to attach the hand: on the first pass
    -- the hand_history insert may have been the step that failed.
    UPDATE bbj_payouts bp
       SET hand_id = h.id
      FROM public.hand_history h
     WHERE bp.id = v_existing AND bp.hand_id IS NULL
       AND h.table_id = p_table_id AND h.hand_number = p_hand_number;

    RETURN QUERY SELECT false, true, v_recovered, v_existing, v_total, v_loser, v_winner, v_table, v_per, NULL::numeric;
    RETURN;
  END IF;

  SELECT main_balance, COALESCE(backup_balance,0) INTO v_main, v_backup FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
  IF v_main IS NULL OR v_main <= 0 THEN
    RETURN QUERY SELECT false, false, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, COALESCE(v_main,0);
    RETURN;
  END IF;

  v_pre_hit_balance := v_main;
  v_total  := ROUND(v_main * (p_payout_total_percent / 100.0), 2);
  -- CLAMP TO MAIN ONLY. The backup jackpot is a reserve and is never a payout
  -- source (Dan, 2026-08-18). This replaces the earlier LEAST(v_total,
  -- main+backup), which had authorised spending the reserve.
  v_total  := LEAST(v_total, v_main);
  v_loser  := ROUND(v_total * 0.50, 2);
  v_winner := ROUND(v_total * 0.25, 2);
  v_table  := ROUND(v_total - v_loser - v_winner, 2);
  IF v_n_table > 0 THEN v_per := ROUND(v_table / v_n_table, 2); ELSE v_per := 0; END IF;
  v_remainder := ROUND(v_table - (v_per * v_n_table), 2);
  v_loser := v_loser + v_remainder;
  v_table := v_per * v_n_table;

  -- THE HAND. Written before the payout by postHandTasks, so it is normally
  -- here. NULL when that step failed, which is exactly the case worth being
  -- able to see.
  SELECT h.id INTO v_hand_id FROM public.hand_history h
   WHERE h.table_id = p_table_id AND h.hand_number = p_hand_number
   ORDER BY h.created_at DESC LIMIT 1;

  INSERT INTO bbj_payouts (pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id,
    total_amount, winner_share, loser_share, table_share, table_player_count, metadata)
  VALUES (p_pool_id, v_hand_id, p_table_id, p_hand_number, p_loser_user_id, p_winner_user_id,
    v_total, v_winner, v_loser, v_table, v_n_table, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (pool_id, table_id, hand_number) DO NOTHING RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    RETURN QUERY SELECT false, true, false, NULL::uuid, 0::numeric,0::numeric,0::numeric,0::numeric,0::numeric, v_main;
    RETURN;
  END IF;

  /* THE PAYOUT IS DECLARED (chip standard Phase 4.3, 2026-09-04): the main
     jackpot pays the felt of the hitting table. Seated recipients hold their
     share on that felt; a departed recipient's share leaves the felt for the
     wallet in bbj_credit_one_recipient, declared there. Before today this
     debit fell to settlement_suspense. */
  PERFORM public.fn_ca_declare_ledger('bbj_payout', 'table_stack', p_table_id, NULL,
                                      'bbj_payout:' || v_payout_id::text, NULL);
  -- MAIN ONLY. backup_balance is deliberately absent from this statement: a
  -- jackpot payout must never touch the reserve.
  UPDATE bbj_pools
     SET main_balance   = GREATEST(0, main_balance - v_total),
         total_paid_out = COALESCE(total_paid_out, 0) + v_total,
         hit_count      = COALESCE(hit_count, 0) + 1,
         last_hit_at    = now(), last_hit_amount = v_total,
         last_winner_id = p_loser_user_id, last_loser_id = p_winner_user_id, updated_at = now()
   WHERE id = p_pool_id RETURNING main_balance, club_id INTO v_main, v_club_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  -- RESEED (Dan 2026-08-18): the back-up jackpot exists so that when a hit
  -- takes 100% of main, the jackpot does not restart at zero. If main is now
  -- empty, TRANSFER the reserve into it. A transfer, not a payout: no player
  -- is ever paid from the reserve, and chips are conserved. Recorded as a
  -- bank move; an empty reserve raises an incident (Phase 4.3).
  IF v_main <= 0 THEN
    v_main := GREATEST(v_main, fn_bbj_reseed_main_from_backup(p_pool_id));
  END IF;

  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_loser_user_id, v_loser, p_loser_user_id = ANY(p_seated_ids));
  PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, p_winner_user_id, v_winner, p_winner_user_id = ANY(p_seated_ids));
  FOREACH v_uid IN ARRAY v_table_ids LOOP
    PERFORM bbj_credit_one_recipient(v_payout_id, p_table_id, v_uid, v_per, v_uid = ANY(p_seated_ids));
  END LOOP;

  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_winner_name FROM profiles WHERE id = p_loser_user_id;
  SELECT public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name) INTO v_loser_name FROM profiles WHERE id = p_winner_user_id;

  INSERT INTO bbj_winners (pool_id, club_id, winner_id, loser_id, winner_display_name, loser_display_name,
    winner_hand, loser_hand, winner_payout, loser_payout, table_share_payout, total_payout,
    pool_amount_at_hit, table_id, hand_number, awarded_at)
  VALUES (p_pool_id, v_club_id, p_loser_user_id, p_winner_user_id, v_winner_name, v_loser_name,
    COALESCE(p_metadata->>'winner_hand_name', 'Unknown'), COALESCE(p_metadata->>'loser_hand_name', 'Unknown'),
    v_loser, v_winner, v_table, v_total, v_pre_hit_balance, p_table_id, p_hand_number, now())
  ON CONFLICT DO NOTHING;

  RETURN QUERY SELECT true, false, false, v_payout_id, v_total, v_loser, v_winner, v_table, v_per, v_main;
END;
$function$;
REVOKE ALL ON FUNCTION public.bbj_atomic_payout_v2(uuid, uuid, bigint, numeric, uuid, uuid, uuid[], uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bbj_atomic_payout_v2(uuid, uuid, bigint, numeric, uuid, uuid, uuid[], uuid[], jsonb) TO service_role;

-- ── 6. Union funding and the backup transfer declare themselves ───────────
CREATE OR REPLACE FUNCTION public.fn_union_fund_bbj_pool(p_union_id uuid, p_amount numeric, p_main_pct numeric DEFAULT 50, p_backup_pct numeric DEFAULT 25, p_promo_pct numeric DEFAULT 25, p_notes text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric;
  v_after numeric;
  v_pool_id uuid;
  v_main numeric;
  v_backup numeric;
  v_promo numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0, to two decimals');
  END IF;
  IF ROUND(COALESCE(p_main_pct,0) + COALESCE(p_backup_pct,0) + COALESCE(p_promo_pct,0)) <> 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'split percentages must total 100');
  END IF;

  SELECT id INTO v_pool_id FROM bbj_pools WHERE union_id = p_union_id AND status = 'active' FOR UPDATE;
  IF v_pool_id IS NULL THEN
    RAISE EXCEPTION 'no active BBJ pool for union %', p_union_id;
  END IF;

  SELECT chip_balance INTO v_balance FROM union_wallets
   WHERE union_id = p_union_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union wallet not found');
  END IF;
  IF v_balance < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient union chip balance',
                              'balance', v_balance, 'requested', p_amount);
  END IF;

  /* DECLARED (Phase 4.3): one move, union bank -> the pool's banks. The
     union-side write is autoskipped; the pool-side writes are journalled as
     union_wallet -> bbj_pool, one leg per bank, which is what the per-bank
     reconcile reads. */
  PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
  UPDATE union_wallets
     SET chip_balance = chip_balance - p_amount, updated_at = NOW()
   WHERE union_id = p_union_id
   RETURNING chip_balance INTO v_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  v_main   := ROUND(p_amount * p_main_pct / 100.0, 2);
  v_backup := ROUND(p_amount * p_backup_pct / 100.0, 2);
  v_promo  := ROUND(p_amount - v_main - v_backup, 2);
  PERFORM public.fn_ca_declare_ledger('transfer', 'union_wallet', p_union_id, NULL,
                                      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'bbj_fund:' || p_op_id::text END, NULL);
  UPDATE bbj_pools
     SET main_balance      = COALESCE(main_balance, 0) + v_main,
         backup_balance    = COALESCE(backup_balance, 0) + v_backup,
         promo_balance     = COALESCE(promo_balance, 0) + v_promo,
         total_contributed = COALESCE(total_contributed, 0) + p_amount,
         updated_at        = NOW()
   WHERE id = v_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by
  ) VALUES (
    p_union_id, 'chip_balance', 'debit', p_amount, v_after, 'bbj_fund',
    p_op_id, COALESCE(NULLIF(p_notes, ''), 'Union bank -> shared BBJ pool'), p_created_by
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount, 'pool_id', v_pool_id,
    'main', v_main, 'backup', v_backup, 'promo', v_promo,
    'union_balance_after', v_after
  );
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_fund_bbj_pool(uuid, numeric, numeric, numeric, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_fund_bbj_pool(uuid, numeric, numeric, numeric, numeric, text, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_union_bbj_backup_transfer(p_union_id uuid, p_amount numeric, p_destination text, p_op_id uuid, p_created_by uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_amt     numeric := round(COALESCE(p_amount, 0), 2);
  v_pool_id uuid;
  v_backup  numeric;
  v_main    numeric;
  v_promo_after numeric;
  v_res jsonb;
BEGIN
  IF v_amt <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_destination NOT IN ('main', 'promo') THEN
    RETURN jsonb_build_object('success', false, 'error', 'destination must be main or promo');
  END IF;
  IF p_op_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'op_id_required');
  END IF;

  SELECT id, COALESCE(backup_balance,0), COALESCE(main_balance,0)
    INTO v_pool_id, v_backup, v_main
    FROM bbj_pools
   WHERE union_id = p_union_id AND status = 'active'
   FOR UPDATE;

  IF v_pool_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active BBJ pool for this union');
  END IF;
  IF v_backup < v_amt THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient backup balance',
                              'available', v_backup, 'requested', v_amt);
  END IF;

  IF p_destination = 'main' THEN
    -- A bank move inside the pool: declared, recorded, idempotent on the op id.
    v_res := public.fn_bbj_move_between_banks(v_pool_id, 'backup', 'main', v_amt,
               COALESCE(NULLIF(p_notes, ''), 'union owner: BBJ backup -> main jackpot'),
               'union-backup-transfer:' || p_op_id::text);
    IF (v_res->>'ok')::boolean IS DISTINCT FROM true THEN
      RETURN jsonb_build_object('success', false, 'error', COALESCE(v_res->>'reason', 'move refused'));
    END IF;
    IF (v_res->>'replayed')::boolean THEN
      RETURN jsonb_build_object('success', false, 'duplicate', true, 'error', 'operation already processed');
    END IF;

    -- 'bbj_wallet', not 'bbj_pool': the CHECK constraint on this table lists
    -- six wallet names and bbj_pool is not one of them. The chips never left
    -- the BBJ system, they changed bank inside it.
    INSERT INTO union_wallet_transactions
      (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
    VALUES
      (p_union_id, 'bbj_wallet', 'debit', v_amt, v_main + v_amt, 'bbj_backup_to_main', p_op_id,
       COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> main jackpot'), p_created_by);

    RETURN jsonb_build_object('success', true, 'destination', 'main', 'amount', v_amt,
                              'pool_id', v_pool_id,
                              'backup_after', v_backup - v_amt,
                              'main_after', v_main + v_amt);
  END IF;

  /* DECLARED (Phase 4.3): the reserve leaves the pool for the union's promo
     wallet. The pool debit is journalled bbj_pool -> union_wallet; the wallet
     credit is autoskipped so the one move is one leg. */
  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
  UPDATE bbj_pools
     SET backup_balance = COALESCE(backup_balance,0) - v_amt, updated_at = now()
   WHERE id = v_pool_id;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);

  INSERT INTO union_wallets (union_id, promo_wallet)
  VALUES (p_union_id, v_amt)
  ON CONFLICT (union_id) DO UPDATE
    SET promo_wallet = COALESCE(union_wallets.promo_wallet, 0) + EXCLUDED.promo_wallet,
        updated_at = now()
  RETURNING promo_wallet INTO v_promo_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

  IF v_promo_after IS NULL THEN
    RAISE EXCEPTION 'promo wallet credit failed for union %', p_union_id;
  END IF;

  INSERT INTO union_wallet_transactions
    (union_id, wallet, direction, amount, balance_after, tx_type, period_id, notes, created_by)
  VALUES
    (p_union_id, 'promo_wallet', 'credit', v_amt, v_promo_after, 'bbj_backup_to_promo', p_op_id,
     COALESCE(NULLIF(p_notes, ''), 'BBJ backup -> promo wallet'), p_created_by);

  RETURN jsonb_build_object('success', true, 'destination', 'promo', 'amount', v_amt,
                            'pool_id', v_pool_id,
                            'backup_after', v_backup - v_amt,
                            'promo_after', v_promo_after);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'duplicate', true,
                            'error', 'operation already processed');
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_union_bbj_backup_transfer(uuid, numeric, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_bbj_backup_transfer(uuid, numeric, text, uuid, uuid, text) TO service_role;

-- ── 7. The retired stubs are closed ───────────────────────────────────────
DO $$
DECLARE r record; v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('add_bbj_contribution', 'award_bbj', 'bbj_atomic_payout', 'bbj_promo_payout',
                         'fn_bbj_payout', 'fn_union_bbj_pool_payout')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role', r.proname, r.args);
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'expected 8 retired BBJ overloads, found %', v_n;
  END IF;
END $$;
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT n, 'closed', 'closed 2026-09-04 (chip standard Phase 4.3): a retired BBJ stub that refused every call; 0 calls since the 2026-09-02 pg_stat_statements reset. DROP with the Phase 3.3 list.'
  FROM unnest(ARRAY['add_bbj_contribution', 'award_bbj', 'bbj_atomic_payout', 'bbj_promo_payout', 'fn_bbj_payout', 'fn_union_bbj_pool_payout']) n
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_bbj_allocate', 'approved', 'chip standard Phase 4.3 (2026-09-04): the one BBJ allocator, reads ca_bbj_policy; moves no chips itself'),
  ('fn_bbj_move_between_banks', 'approved', 'chip standard Phase 4.3 (2026-09-04): a declared, recorded, op-keyed move between a pool''s banks; service only'),
  ('fn_union_fund_bbj_pool', 'approved', 'union bank -> BBJ pool banks, declared (transfer, union_wallet) since Phase 4.3; service only'),
  ('fn_union_bbj_backup_transfer', 'approved', 'BBJ backup -> main (bank move) or -> union promo wallet (promo, union_wallet), declared since Phase 4.3; service only'),
  ('bbj_credit_one_recipient', 'approved', 'BBJ recipient credit: seat if seated, else keyed credit to the table club wallet declared table_stack -> player_wallet (Phase 4.3); service only'),
  ('fn_bbj_reseed_main_from_backup', 'approved', 'reseed after a 100% hit: a recorded bank move, incident when the reserve is empty (Phase 4.3)')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ── 8. The pivot correction, read and asserted ────────────────────────────
DO $$
DECLARE
  c_pool constant uuid := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';  -- Midway Union's pool
  v_cross timestamptz; v_n bigint; v_amt numeric; v_over numeric; v_dips bigint; v_res jsonb;
  v_main_before numeric; v_promo_before numeric; v_main_after numeric; v_promo_after numeric;
BEGIN
  SELECT min(created_at) INTO v_cross FROM public.chip_ledger
   WHERE to_label = 'bbj_pools.main_balance' AND to_entity_id = c_pool AND post_to_balance >= 100000;
  IF v_cross <> '2026-09-03 07:13:51.966829+00'::timestamptz THEN
    RAISE EXCEPTION 'the union pool crossed the pivot at %, not the moment this migration was written for', v_cross;
  END IF;
  SELECT count(*) INTO v_dips FROM public.chip_ledger l
   WHERE l.to_label = 'bbj_pools.main_balance' AND l.to_entity_id = c_pool AND l.created_at > v_cross AND l.post_to_balance < 100000;
  IF v_dips <> 0 THEN
    RAISE EXCEPTION 'main dipped below the pivot % time(s) after crossing; the correction needs a per-interval read', v_dips;
  END IF;
  SELECT count(*), round(sum(amount), 2), round(sum(main_portion) - sum(amount) * 0.25, 2)
    INTO v_n, v_amt, v_over
    FROM public.bbj_contributions WHERE pool_id = c_pool AND created_at > v_cross;
  IF v_n < 50279 OR v_over < 4222.97 OR v_over > 4222.97 + 2000 THEN
    RAISE EXCEPTION 'post-pivot rows % / over-allocation % are not the figures read at 20:55 UTC (50,279 / 4,222.97 plus at most one evening of drops)', v_n, v_over;
  END IF;
  SELECT main_balance, promo_balance INTO v_main_before, v_promo_before FROM public.bbj_pools WHERE id = c_pool;
  v_res := public.fn_bbj_move_between_banks(c_pool, 'main', 'promo', v_over,
             format('pivot correction: main crossed 100,000 at %s and bbj_record_contribution kept allocating 50%% instead of 25%% over %s drops / %s chips; the over-allocation moves to promo where the policy put it (chip standard Phase 4.3)', v_cross, v_n, v_amt),
             'pivot-correction:' || c_pool::text || ':2026-09-03');
  IF (v_res->>'ok')::boolean IS DISTINCT FROM true OR (v_res->>'replayed')::boolean THEN
    RAISE EXCEPTION 'pivot correction refused: %', v_res;
  END IF;
  SELECT main_balance, promo_balance INTO v_main_after, v_promo_after FROM public.bbj_pools WHERE id = c_pool;
  IF round(v_main_before - v_main_after, 2) <> v_over OR round(v_promo_after - v_promo_before, 2) <> v_over THEN
    RAISE EXCEPTION 'the correction did not move exactly % (main % -> %, promo % -> %)', v_over, v_main_before, v_main_after, v_promo_before, v_promo_after;
  END IF;
  RAISE NOTICE 'pivot correction: % moved main -> promo on % (crossed %, % drops / % chips since)', v_over, c_pool, v_cross, v_n, v_amt;
END $$;

-- ── Assertions ────────────────────────────────────────────────────────────
DO $$
DECLARE r record; v_n int;
BEGIN
  SELECT m.main_portion, m.backup_portion, m.promo_portion INTO r FROM public.fn_bbj_allocate(10.01, 99999.99) m;
  IF r.main_portion <> 5.01 OR r.backup_portion <> 2.50 OR r.promo_portion <> 2.50 THEN RAISE EXCEPTION 'standard split wrong: %', r; END IF;
  SELECT m.main_portion, m.backup_portion, m.promo_portion INTO r FROM public.fn_bbj_allocate(10.01, 100000) m;
  IF r.main_portion <> 2.50 OR r.backup_portion <> 2.50 OR r.promo_portion <> 5.01 THEN RAISE EXCEPTION 'pivot split wrong: %', r; END IF;
  IF (SELECT count(*) FROM public.ca_bbj_bucket_moves WHERE op_id LIKE 'pivot-correction:%') <> 1 THEN RAISE EXCEPTION 'pivot correction not recorded'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('bbj_credit_one_recipient', 'bbj_atomic_payout_v2', 'bbj_record_contribution', 'fn_union_fund_bbj_pool', 'fn_bbj_move_between_banks')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION '% BBJ money door(s) still reachable from a browser', v_n; END IF;
  -- Only this phase's doors are asserted: another agent's fn_cash_seat_move_execute
  -- (cash games slice 1, same afternoon) is unregistered and is theirs to register.
  IF EXISTS (SELECT 1 FROM public.fn_ca_money_rpc_drift() d
              WHERE d.proname IN ('fn_bbj_allocate', 'fn_bbj_move_between_banks', 'bbj_credit_one_recipient', 'bbj_atomic_payout_v2',
                                  'bbj_record_contribution', 'fn_bbj_repair_unbanked', 'fn_bbj_reseed_main_from_backup',
                                  'fn_union_fund_bbj_pool', 'fn_union_bbj_backup_transfer')) THEN
    RAISE EXCEPTION 'a Phase 4.3 door is not on the registry';
  END IF;
END $$;

-- ── 9. LAST, because it takes an ACCESS EXCLUSIVE lock on a table written every second ─
-- pool_amount is a dead counter (the engine never read it; fn_bbj_payout,
-- which drained it, was retired 08-18). It leaves the autoledger so a funded
-- amount is journalled once, in its banks.
DROP TRIGGER IF EXISTS trg_ca_autoledger ON public.bbj_pools;
CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF main_balance, backup_balance, promo_balance ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_autoledger('main_balance=bbj_pool', 'backup_balance=bbj_pool', 'promo_balance=bbj_pool');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.bbj_pools'::regclass AND t.tgname = 'trg_ca_autoledger' AND pg_get_triggerdef(t.oid) LIKE '%pool_amount%') THEN
    RAISE EXCEPTION 'pool_amount is still journalled';
  END IF;
END $$;
