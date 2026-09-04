-- ═══════════════════════════════════════════════════════════════════════════
-- THE MINT, HARDENED (chip standard, 2026-09-04, Dan: "do a full audit of
-- it, and improve, upgrade, build, enhance and optimize everything inside").
--
-- The audit (read from production 19:30-19:50 UTC; every figure below was
-- measured, not assumed):
--
--   1. The register could be edited or deleted. chip_ledger has had an
--      append-only trigger since the journal was built; ca_mint_ledger, the
--      register the journal now feeds, had none. A postgres or service_role
--      session could UPDATE an amount or DELETE a row and nothing would say
--      so. Now it is append-only on the same terms as the journal: the ONLY
--      permitted update is linking a row to its journal leg (chip_ledger_id
--      NULL -> a value, nothing else changed); anything else needs the
--      maintenance door and is logged to ca_ledger_mutation_log and raised as
--      an incident, exactly as the journal does.
--   2. One leg could be registered twice. The deferred trigger adopts an
--      unlinked row before writing one, but nothing STRUCTURAL stopped two
--      rows from linking to the same leg. A unique index on chip_ledger_id
--      does (0 duplicates today, asserted).
--   3. fn_ca_mint and fn_ca_burn found their own journal leg by SHAPE (same
--      target, same amount, latest) rather than by key: two mints of the same
--      amount to the same club in the same second could link the wrong leg,
--      and fn_ca_burn's shape did not match the autoledger's row at all, so
--      its register rows were only linked by the trigger's adoption path.
--      Both doors now declare the leg with an idempotency key ('mint:' or
--      'burn:' plus the op id) and link by that key.
--   4. There was no ceiling. The single-operation cap was 1,000,000,000
--      chips, five times the whole supply (193.1M); the only velocity control
--      was a watcher that files an incident five minutes AFTER the chips
--      exist. The ceiling is now a policy row (ca_mint_policy) enforced in
--      two places: fn_ca_mint refuses with a reason the operator can read,
--      and the deferred constraint trigger on chip_ledger refuses AT COMMIT
--      for every door, present or future, so nothing can issue over the
--      ceiling whatever path it takes. Defaults, from what the platform
--      actually does (largest single issuance ever 100,000; 1.44M in the
--      last seven days; 241,203.12 in the last 24h): 10,000,000 per
--      operation and 25,000,000 per rolling 24 hours for chips; 1,000,000 and
--      2,000,000 for diamonds (diamond supply ~1.03M). An epoch reset or a
--      mass club creation raises the row first, with a reason, through
--      fn_ca_mint_policy_set; the change is recorded in ca_mint_policy_changes.
--   5. mint_club_chips: a free mint into clubs.chip_pool with no journal
--      declaration and no register row, still executable by service_role.
--      Its only caller is an unreachable block in the World Hub's
--      mint-chips.js (the live path there is fn_mint_chips_from_diamonds).
--      0 calls in pg_stat_statements since the 2026-09-02 reset. Closed, with
--      mint_club_promo (a stub that refuses everything). The registry rows
--      say closed, so fn_ca_money_rpc_drift files an incident if either is
--      re-opened.
--   6. The overview lied by omission. fn_ca_mint_overview reported
--      "chips_issued" from a register that, since the 18:34 opening baseline,
--      EQUALS the supply meter - and the panel still said the two are not
--      supposed to match. The overview now carries the reconciliation
--      (register net, meter total, difference, unexplained drift since the
--      baseline, snapshot age), issuance since the baseline and in the last
--      24h, the policy with its headroom, and a per-origin breakdown, so the
--      panel can show whether every chip is accounted for rather than a
--      number with no partner.
--   7. Every register row now says where it came from. `origin` is a
--      generated column derived from the op id: operator (the Mint panel),
--      journal (registered from a leg at commit), baseline, diamond-mint,
--      opening-grant, restoration, seed, deletion. Filterable in the API.
--   8. Tidy: the trigger function was executable by anon and authenticated
--      (a trigger function cannot be called directly, but it should not read
--      as reachable). Revoked.
--
-- One transaction. Probed rolled-back first; every number asserted.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The register is append-only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  -- The one permitted update: linking a row to its journal leg.
  IF TG_OP = 'UPDATE'
     AND OLD.chip_ledger_id IS NULL AND NEW.chip_ledger_id IS NOT NULL
     AND NEW.op_id IS NOT DISTINCT FROM OLD.op_id
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.asset IS NOT DISTINCT FROM OLD.asset
     AND NEW.holder_type IS NOT DISTINCT FROM OLD.holder_type
     AND NEW.holder_id IS NOT DISTINCT FROM OLD.holder_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.balance_before IS NOT DISTINCT FROM OLD.balance_before
     AND NEW.balance_after IS NOT DISTINCT FROM OLD.balance_after
     AND NEW.supply_after IS NOT DISTINCT FROM OLD.supply_after
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.performed_by IS NOT DISTINCT FROM OLD.performed_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.diamond_tx_id IS NOT DISTINCT FROM OLD.diamond_tx_id THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END);
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_mint_register_append_only', 'unauthorized_adjustment', 'warning',
        'register-bypass:' || TG_OP || ':' || split_part(v_reason, ':', 1),
        0, NULL, NULL, 'ledger', 'ca_mint_ledger',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on the mint register: ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log. Confirm the maintenance was intended, then resolve.',
        true,
        jsonb_build_object('operation', TG_OP, 'reason', v_reason, 'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on ca_mint_ledger is forbidden: the mint register is append-only. A retirement offsets an issuance; neither is ever edited or removed. Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP USING ERRCODE = 'P0403';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_mint_register_append_only ON public.ca_mint_ledger;
CREATE TRIGGER trg_ca_mint_register_append_only
  BEFORE DELETE OR UPDATE ON public.ca_mint_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_mint_register_append_only();

-- ── 2. One register row per journal leg ───────────────────────────────────
DO $$
DECLARE v_dup int;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT chip_ledger_id FROM public.ca_mint_ledger WHERE chip_ledger_id IS NOT NULL
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dup <> 0 THEN
    RAISE EXCEPTION 'the register already links % leg(s) twice - resolve before adding the unique index', v_dup;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ca_mint_ledger_chip_ledger_id_key
  ON public.ca_mint_ledger (chip_ledger_id) WHERE chip_ledger_id IS NOT NULL;

-- ── 7. Every row says where it came from ──────────────────────────────────
ALTER TABLE public.ca_mint_ledger
  ADD COLUMN IF NOT EXISTS origin text GENERATED ALWAYS AS (
    CASE
      WHEN op_id LIKE 'ledger:%'                    THEN 'journal'
      WHEN op_id LIKE 'register-opening-baseline:%' THEN 'baseline'
      WHEN op_id LIKE 'baseline:%'                  THEN 'baseline'
      WHEN op_id LIKE 'diamond-mint:%'              THEN 'diamond-mint'
      WHEN op_id LIKE 'club-opening-grant:%'        THEN 'opening-grant'
      WHEN op_id LIKE 'seat_credit_erased:%'        THEN 'restoration'
      WHEN op_id LIKE 'seed:%'                      THEN 'seed'
      WHEN op_id LIKE 'deletion:%'                  THEN 'deletion'
      ELSE 'operator'
    END) STORED;
CREATE INDEX IF NOT EXISTS ca_mint_ledger_origin_idx ON public.ca_mint_ledger (origin, created_at DESC);
COMMENT ON COLUMN public.ca_mint_ledger.origin IS
  'Derived from op_id: operator (the Mint panel / fn_ca_mint), journal (registered from a chip_ledger leg at commit), baseline (opening baseline, not issuance), diamond-mint, opening-grant, restoration, seed, deletion.';

-- ── 4. The issuance policy ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_mint_policy (
  id                         int PRIMARY KEY CHECK (id = 1),
  per_operation_cap_chips    numeric NOT NULL CHECK (per_operation_cap_chips > 0),
  rolling_24h_cap_chips      numeric NOT NULL CHECK (rolling_24h_cap_chips > 0),
  per_operation_cap_diamonds numeric NOT NULL CHECK (per_operation_cap_diamonds > 0),
  rolling_24h_cap_diamonds   numeric NOT NULL CHECK (rolling_24h_cap_diamonds > 0),
  note                       text,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid
);
INSERT INTO public.ca_mint_policy
  (id, per_operation_cap_chips, rolling_24h_cap_chips, per_operation_cap_diamonds, rolling_24h_cap_diamonds, note)
VALUES (1, 10000000, 25000000, 1000000, 2000000,
        'defaults set 2026-09-04 from measured issuance (largest single 100,000; 1.44M in 7 days); raise through fn_ca_mint_policy_set with a reason before a deliberate batch')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.ca_mint_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ca_mint_policy_admin_read ON public.ca_mint_policy;
CREATE POLICY ca_mint_policy_admin_read ON public.ca_mint_policy FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'god', 'superadmin')));
REVOKE ALL ON public.ca_mint_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_mint_policy TO authenticated;
GRANT SELECT ON public.ca_mint_policy TO service_role;

CREATE TABLE IF NOT EXISTS public.ca_mint_policy_changes (
  id          bigserial PRIMARY KEY,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid,
  db_role     text NOT NULL DEFAULT current_user,
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 10),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL
);
ALTER TABLE public.ca_mint_policy_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ca_mint_policy_changes_admin_read ON public.ca_mint_policy_changes;
CREATE POLICY ca_mint_policy_changes_admin_read ON public.ca_mint_policy_changes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin', 'god', 'superadmin')));
REVOKE ALL ON public.ca_mint_policy_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_mint_policy_changes TO authenticated;
GRANT SELECT ON public.ca_mint_policy_changes TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_policy_set(
  p_per_operation_cap_chips numeric DEFAULT NULL,
  p_rolling_24h_cap_chips numeric DEFAULT NULL,
  p_per_operation_cap_diamonds numeric DEFAULT NULL,
  p_rolling_24h_cap_diamonds numeric DEFAULT NULL,
  p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_before jsonb; v_after jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_policy_change_needs_a_real_reason');
  END IF;
  IF p_per_operation_cap_chips IS NULL AND p_rolling_24h_cap_chips IS NULL
     AND p_per_operation_cap_diamonds IS NULL AND p_rolling_24h_cap_diamonds IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_to_change');
  END IF;
  SELECT to_jsonb(p) INTO v_before FROM public.ca_mint_policy p WHERE p.id = 1 FOR UPDATE;
  UPDATE public.ca_mint_policy
     SET per_operation_cap_chips    = COALESCE(p_per_operation_cap_chips, per_operation_cap_chips),
         rolling_24h_cap_chips      = COALESCE(p_rolling_24h_cap_chips, rolling_24h_cap_chips),
         per_operation_cap_diamonds = COALESCE(p_per_operation_cap_diamonds, per_operation_cap_diamonds),
         rolling_24h_cap_diamonds   = COALESCE(p_rolling_24h_cap_diamonds, rolling_24h_cap_diamonds),
         note = btrim(p_reason), updated_at = now(), updated_by = v_actor
   WHERE id = 1;
  SELECT to_jsonb(p) INTO v_after FROM public.ca_mint_policy p WHERE p.id = 1;
  INSERT INTO public.ca_mint_policy_changes (changed_by, reason, before, after)
  VALUES (v_actor, btrim(p_reason), v_before, v_after);
  RETURN jsonb_build_object('ok', true, 'before', v_before, 'after', v_after);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_policy_set(numeric, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_policy_set(numeric, numeric, numeric, numeric, text) TO service_role;

/* Chips issued in the trailing 24 hours, from the register (small, indexed),
   baseline rows excluded. p_except is the leg being judged, so a row the
   door already wrote for it is not counted twice. */
CREATE OR REPLACE FUNCTION public.fn_ca_mint_issued_24h(p_asset text, p_except_leg uuid DEFAULT NULL)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(m.amount), 0)
    FROM public.ca_mint_ledger m
   WHERE m.asset = p_asset AND m.action = 'mint'
     AND m.origin <> 'baseline'
     AND m.created_at > now() - interval '24 hours'
     AND (p_except_leg IS NULL OR m.chip_ledger_id IS DISTINCT FROM p_except_leg);
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_issued_24h(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_issued_24h(text, uuid) TO service_role;

/* The ceiling for every door: the deferred constraint trigger on chip_ledger
   (created in 20260904183408) now judges a mint leg before registering it. */
CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_issuance_leg_is_registered() FROM PUBLIC, anon, authenticated;

-- ── 3 + 4. The doors link by key and honour the policy ────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_mint(p_asset text, p_destination text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text DEFAULT 'admin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_dest  text := lower(btrim(COALESCE(p_destination, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
  v_pol public.ca_mint_policy%ROWTYPE;
  v_cap numeric; v_roll numeric; v_24h numeric;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_dest NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_issued_to_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_dest NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_issued_to_a_player_or_to_the_house_only');
  END IF;
  -- The foundation's issuance_class list (diamond_transactions_issuance_class_chk).
  -- Recorded on the diamond journal row; carried but unused for chips, which have
  -- their own ledger.
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_dest = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  -- THE POLICY (ca_mint_policy): a per-operation cap and a rolling 24-hour
  -- ceiling, both refused here with a reason the operator can read, and
  -- refused again at commit by the constraint trigger for chips whatever the
  -- door. 24h issuance is read from the register with the advisory lock held
  -- below, so two operators cannot both fit under the ceiling at once.
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  v_cap  := CASE WHEN v_asset = 'chips' THEN v_pol.per_operation_cap_chips ELSE v_pol.per_operation_cap_diamonds END;
  v_roll := CASE WHEN v_asset = 'chips' THEN v_pol.rolling_24h_cap_chips ELSE v_pol.rolling_24h_cap_diamonds END;
  IF p_amount > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_over_the_single_mint_cap',
                              'cap', v_cap, 'requested', p_amount);
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'issuance_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_mint', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  v_24h := public.fn_ca_mint_issued_24h(v_asset) + p_amount;
  IF v_24h > v_roll THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'over_the_rolling_24h_issuance_ceiling',
                              'ceiling', v_roll, 'issued_24h', v_24h - p_amount, 'requested', p_amount);
  END IF;

  IF v_asset = 'diamonds' THEN
    IF v_dest = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
      -- No diamond_transactions row: that journal is keyed by a user (two FKs to
      -- auth.users and profiles) and the house is not one. ca_mint_ledger is the
      -- record of a house-side issuance.
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) + p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    -- The leg is declared WITH A KEY and found by that key: never by shape.
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'mint:' || p_op_id, NULL);
    IF v_dest = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_mint',
              'The Mint: ' || v_reason, v_after);
    ELSE
      SELECT name INTO v_label FROM public.unions WHERE id = p_target_id;
      IF v_label IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');
      END IF;
      INSERT INTO public.union_wallets (union_id, created_at, updated_at)
      VALUES (p_target_id, now(), now()) ON CONFLICT (union_id) DO NOTHING;
      SELECT COALESCE(chip_balance, 0) INTO v_before
        FROM public.union_wallets WHERE union_id = p_target_id FOR UPDATE;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger WHERE idempotency_key = 'mint:' || p_op_id;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF v_chip_id IS NULL THEN
      RAISE EXCEPTION 'fn_ca_mint: the balance moved but no journal leg was written for key mint:% - refusing to register an issuance the journal does not carry', p_op_id;
    END IF;
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'mint', v_asset, v_dest, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'mint',
    'asset', v_asset, 'destination', v_dest, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'ledger_id', v_chip_id, 'issued_24h_after', v_24h, 'rolling_24h_cap', v_roll,
    'minted_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text, text, uuid, numeric, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_burn(p_asset text, p_source text, p_target_id uuid, p_amount numeric, p_reason text, p_op_id text, p_class text DEFAULT 'admin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_house constant uuid := '00000000-0000-0000-0000-00000000d1a0';
  v_actor uuid := auth.uid();
  v_admin boolean := false;
  v_asset text := lower(btrim(COALESCE(p_asset, '')));
  v_src   text := lower(btrim(COALESCE(p_source, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_class text := lower(btrim(COALESCE(p_class, 'admin')));
  v_holder uuid;
  v_prior jsonb; v_before numeric; v_after numeric; v_label text;
  v_supply numeric; v_chip_id uuid; v_dia_id uuid; v_actorlb text; v_result jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  IF v_asset NOT IN ('chips', 'diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_asset = 'chips' AND v_src NOT IN ('club', 'union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chips_are_retired_from_a_club_or_union_wallet_only');
  END IF;
  IF v_asset = 'diamonds' AND v_src NOT IN ('player', 'house') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_retired_from_a_player_or_from_the_house_only');
  END IF;
  IF v_class NOT IN ('purchased', 'promotional', 'earned', 'transferred', 'seeded',
                     'refund', 'spend', 'bridge', 'deletion', 'admin', 'arena',
                     'house', 'unknown') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_issuance_class', 'class', v_class);
  END IF;
  IF v_asset = 'diamonds' AND v_src = 'house' THEN
    IF p_target_id IS NOT NULL AND p_target_id <> c_house THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_house_target_is_the_house_sentinel_or_null');
    END IF;
  ELSIF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF v_asset = 'diamonds' AND p_amount <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_are_whole_numbers');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'retirement_needs_a_real_reason');
  END IF;
  IF COALESCE(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_burn', v_actor);

  PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:' || v_asset));

  IF v_asset = 'diamonds' THEN
    IF v_src = 'house' THEN
      INSERT INTO public.ca_diamond_house (id, balance)
      VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      SELECT COALESCE(balance, 0) INTO v_before
        FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_house_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.ca_diamond_house
         SET balance = COALESCE(balance, 0) - p_amount, updated_at = now()
       WHERE id = 1 RETURNING balance INTO v_after;
      v_label  := 'the house';
      v_holder := c_house;
    ELSE
      SELECT COALESCE(diamonds, 0), COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
        INTO v_before, v_label FROM public.profiles WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_balance_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.profiles SET diamonds = COALESCE(diamonds, 0) - p_amount
       WHERE id = p_target_id RETURNING diamonds INTO v_after;
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'spend', 'burn', -p_amount, v_after,
              'The Mint (retired): ' || v_reason, 'the_mint',
              jsonb_build_object('burned_by', v_actor, 'op_id', p_op_id),
              'retired', v_class)
      RETURNING id INTO v_dia_id;
      v_holder := p_target_id;
    END IF;
  ELSE
    -- The leg is declared WITH A KEY and found by that key: never by shape.
    PERFORM public.fn_ca_declare_ledger('burn', 'chip_retirement', NULL, NULL, 'burn:' || p_op_id, NULL);
    IF v_src = 'club' THEN
      SELECT COALESCE(chip_treasury, 0), name INTO v_before, v_label
        FROM public.clubs WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_treasury_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
       WHERE id = p_target_id RETURNING chip_treasury INTO v_after;
      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_burn',
              'The Mint (retired): ' || v_reason, v_after);
    ELSE
      SELECT COALESCE(w.chip_balance, 0), u.name INTO v_before, v_label
        FROM public.union_wallets w JOIN public.unions u ON u.id = w.union_id
       WHERE w.union_id = p_target_id FOR UPDATE OF w;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found');
      END IF;
      IF v_before < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_union_bank_below_zero',
                                  'balance', v_before, 'requested', p_amount);
      END IF;
      UPDATE public.union_wallets
         SET chip_balance = COALESCE(chip_balance, 0) - p_amount, updated_at = now()
       WHERE union_id = p_target_id RETURNING chip_balance INTO v_after;
    END IF;
    SELECT id INTO v_chip_id FROM public.chip_ledger WHERE idempotency_key = 'burn:' || p_op_id;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF v_chip_id IS NULL THEN
      RAISE EXCEPTION 'fn_ca_burn: the balance moved but no journal leg was written for key burn:% - refusing to register a retirement the journal does not carry', p_op_id;
    END IF;
    v_holder := p_target_id;
  END IF;

  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) - p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = v_asset;
  SELECT COALESCE(NULLIF(btrim(username), ''), full_name, id::text)
    INTO v_actorlb FROM public.profiles WHERE id = v_actor;

  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason,
     performed_by, performed_by_label, chip_ledger_id, diamond_tx_id)
  VALUES
    (p_op_id, 'burn', v_asset, v_src, v_holder, v_label, p_amount,
     v_before, v_after, v_supply, v_reason, v_actor, v_actorlb, v_chip_id, v_dia_id);

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false, 'action', 'burn',
    'asset', v_asset, 'source', v_src, 'issuance_class', v_class,
    'target_id', v_holder, 'target_label', v_label, 'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after, 'supply_after', v_supply,
    'ledger_id', v_chip_id,
    'burned_by', v_actor, 'reason', v_reason, 'op_id', p_op_id);

  UPDATE public.ca_op_claims SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_burn';

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_burn(text, text, uuid, numeric, text, text, text) TO service_role;

-- ── 6. The overview reconciles ────────────────────────────────────────────
/* The comparison is made AS OF the meter's snapshot: register rows written
   after the meter was read are not yet in the meter's total, so comparing
   the live register to an hourly meter reads as a difference between
   snapshots for anything issued since. As of the snapshot, the difference is
   the meter's own unexplained drift and nothing else, at every moment. */
DROP FUNCTION IF EXISTS public.fn_ca_mint_register_vs_supply();
CREATE FUNCTION public.fn_ca_mint_register_vs_supply()
 RETURNS TABLE(register_net numeric, register_net_at_meter numeric, meter_total numeric, meter_taken_at timestamp with time zone, difference numeric, unexplained_since_baseline numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (SELECT total, taken_at FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1),
       r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net FROM public.ca_mint_ledger WHERE asset = 'chips'),
       ra AS (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) AS net
                FROM public.ca_mint_ledger m, s WHERE m.asset = 'chips' AND m.created_at <= s.taken_at),
       b AS (SELECT min(created_at) AS at FROM public.ca_mint_ledger WHERE op_id LIKE 'register-opening-baseline:%'),
       u AS (SELECT COALESCE(sum(unexplained), 0) AS drift FROM public.ca_supply_snapshots, b WHERE taken_at > b.at)
  SELECT round(r.net, 2), round(ra.net, 2), round(s.total, 2), s.taken_at, round(s.total - ra.net, 2), round(u.drift, 2) FROM r, ra, s, u;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_vs_supply() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_register_vs_supply() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_rec record; v_pol public.ca_mint_policy%ROWTYPE; v_base timestamptz;
  v_issued_24h numeric; v_retired_24h numeric; v_issued_base numeric; v_retired_base numeric;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.id = v_actor AND p.role IN ('admin', 'god')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
  END IF;
  SELECT * INTO v_rec FROM public.fn_ca_mint_register_vs_supply();
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  SELECT min(created_at) INTO v_base FROM public.ca_mint_ledger WHERE op_id LIKE 'register-opening-baseline:%';
  SELECT COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > now() - interval '24 hours'), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'mint' AND created_at > v_base), 0),
         COALESCE(sum(amount) FILTER (WHERE action = 'burn' AND created_at > v_base), 0)
    INTO v_issued_24h, v_retired_24h, v_issued_base, v_retired_base
    FROM public.ca_mint_ledger WHERE asset = 'chips' AND origin <> 'baseline';
  RETURN jsonb_build_object(
    'ok', true,
    -- as before (add, never rename)
    'chips_issued',      public.fn_ca_mint_supply('chips'),
    'diamonds_issued',   public.fn_ca_mint_supply('diamonds'),
    'mint_operations',   (SELECT count(*) FROM public.ca_mint_ledger),
    'club_treasuries',   (SELECT COALESCE(SUM(COALESCE(chip_treasury, 0)), 0) FROM public.clubs),
    'union_banks',       (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.union_wallets),
    'member_wallets',    (SELECT COALESCE(SUM(COALESCE(chip_balance, 0)), 0) FROM public.club_members),
    'chips_on_the_felt', (SELECT COALESCE(SUM(COALESCE(stack, 0)), 0) FROM public.table_seats WHERE left_at IS NULL),
    'diamonds_held',     (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0) FROM public.profiles),
    'diamond_holders',   (SELECT count(*) FROM public.profiles WHERE COALESCE(diamonds, 0) > 0),
    -- the reconciliation: the register against the supply meter
    'reconciliation', jsonb_build_object(
      'register_net',               v_rec.register_net,
      'register_net_at_meter',      v_rec.register_net_at_meter,
      'meter_total',                v_rec.meter_total,
      'meter_taken_at',             v_rec.meter_taken_at,
      'meter_age_seconds',          extract(epoch FROM (now() - v_rec.meter_taken_at))::int,
      'difference',                 v_rec.difference,
      'unexplained_since_baseline', v_rec.unexplained_since_baseline,
      'baseline_at',                v_base,
      'balanced',                   (v_rec.difference = v_rec.unexplained_since_baseline)),
    'issuance', jsonb_build_object(
      'issued_since_baseline',  v_issued_base,
      'retired_since_baseline', v_retired_base,
      'issued_24h',             v_issued_24h,
      'retired_24h',            v_retired_24h),
    'policy', jsonb_build_object(
      'per_operation_cap_chips',    v_pol.per_operation_cap_chips,
      'rolling_24h_cap_chips',      v_pol.rolling_24h_cap_chips,
      'per_operation_cap_diamonds', v_pol.per_operation_cap_diamonds,
      'rolling_24h_cap_diamonds',   v_pol.rolling_24h_cap_diamonds,
      'headroom_24h_chips',         v_pol.rolling_24h_cap_chips - v_issued_24h,
      'note',                       v_pol.note,
      'updated_at',                 v_pol.updated_at),
    'by_origin', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'origin', o.origin, 'asset', o.asset, 'action', o.action,
                     'operations', o.n, 'amount', o.total) ORDER BY o.asset, o.origin, o.action), '[]'::jsonb)
                    FROM (SELECT origin, asset, action, count(*) n, sum(amount) total
                            FROM public.ca_mint_ledger GROUP BY 1, 2, 3) o)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_mint_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_overview() TO authenticated, service_role;

-- ── 5. Two legacy doors closed ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.mint_club_chips(uuid, numeric, uuid, numeric, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mint_club_promo(uuid, numeric, text) FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('mint_club_chips', 'closed', 'closed 2026-09-04 (the Mint hardened): a free mint into clubs.chip_pool with no journal declaration and no register row; only caller an unreachable block in World Hub mint-chips.js; 0 calls since the 2026-09-02 pg_stat_statements reset. DROP after seven days of silence.'),
  ('mint_club_promo', 'closed', 'closed 2026-09-04 (the Mint hardened): a stub that refuses every call; 0 calls. DROP with mint_club_chips.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ── Assertions ────────────────────────────────────────────────────────────
DO $$
DECLARE v_n int; v_pol public.ca_mint_policy%ROWTYPE; r record;
BEGIN
  IF (SELECT count(*) FROM public.ca_mint_ledger WHERE origin IS NULL) <> 0 THEN
    RAISE EXCEPTION 'origin did not derive for every row';
  END IF;
  SELECT count(*) INTO v_n FROM public.ca_mint_ledger WHERE origin = 'baseline' AND asset = 'chips';
  IF v_n <> 5 THEN RAISE EXCEPTION 'expected 5 chip baseline rows, found %', v_n; END IF;
  SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
  IF v_pol.per_operation_cap_chips <> 10000000 OR v_pol.rolling_24h_cap_chips <> 25000000 THEN
    RAISE EXCEPTION 'policy defaults did not land';
  END IF;
  IF public.fn_ca_mint_issued_24h('chips') > v_pol.rolling_24h_cap_chips THEN
    RAISE EXCEPTION 'the last 24h already exceed the rolling ceiling (%): raise the policy first', public.fn_ca_mint_issued_24h('chips');
  END IF;
  FOR r IN SELECT proname FROM unnest(ARRAY['mint_club_chips', 'mint_club_promo']) proname LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = r.proname
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                       OR has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
      RAISE EXCEPTION 'a closed door is still executable by a client role: %', r.proname;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.fn_ca_issuance_leg_is_registered()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_issuance_leg_is_registered()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the trigger function is still executable by a browser role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ca_mint_register_append_only') THEN
    RAISE EXCEPTION 'the register append-only trigger did not land';
  END IF;
  SELECT * INTO r FROM public.fn_ca_mint_register_vs_supply();
  IF r.difference <> r.unexplained_since_baseline THEN
    RAISE EXCEPTION 'register vs meter: difference % is not the meter''s own drift %', r.difference, r.unexplained_since_baseline;
  END IF;
END $$;
