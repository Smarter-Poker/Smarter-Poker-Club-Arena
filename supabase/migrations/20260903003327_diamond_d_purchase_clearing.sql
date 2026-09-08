-- ===========================================================================
-- LANE D - PURCHASE CLEARING: one record per purchase, a chargeback is a debt
-- Diamond Accounting Standard (docs/DIAMOND-ACCOUNTING-STANDARD.md 3.2
-- "Purchase", 3.3 DR1 / DR8 / DR9 / DR13, section 5 "Lane D")
-- ===========================================================================
--
-- WHAT THIS MIGRATION FIXES, from the audit
-- (docs/audits/2026-09-02-diamond-economy/lane2-ramps-bridge-and-standard.md
-- parts A and E, gaps G2, G4, G5):
--
--   G4  `diamond_purchases` has NO unique index on `stripe_checkout_session_id`
--       or `stripe_payment_intent_id`. The Stripe EVENT id is unique (PK on
--       `stripe_webhook_events`); the Stripe ORDER ids are not. `handleRefund`
--       correlates by payment intent with `.maybeSingle()`, which ERRORS if two
--       rows ever share one. Verified 2026-09-03 before writing this file:
--       3 purchase rows, 2 non-null session ids, 0 non-null payment intents,
--       0 duplicates of either. The indexes can be created cleanly.
--   G4  There is no CHECK on `status`. The four strings the live code writes
--       are `pending` (create-checkout-session.js:903/921/1059/1078),
--       `completed` (settle_diamond_card_purchase_atomic),
--       `refunded` (reconcile_diamond_purchase_refund) and
--       `failed` (webhooks/stripe.js:471 on checkout.session.expired, and
--       create-checkout-session.js:1163 on session-create failure). Present in
--       the table today: completed 2, pending 1. The CHECK is NOT VALID so it
--       can never refuse a row that is already there.
--   G4  `anon` and `authenticated` hold INSERT/UPDATE/DELETE on
--       `diamond_purchases`. RLS is on with a SELECT-only owner policy, so the
--       writes are blocked in practice, but the grant should not exist.
--   G5  `profiles.diamonds` has no `CHECK (>= 0)` and
--       `reconcile_diamond_purchase_refund` writes negatives BY DESIGN
--       (`chargeback_debt` flag). D13 / DR1: a chargeback larger than the
--       balance is a RECEIVABLE, not a negative integer on a player.
--   G1  Purchased value is not a sub-ledger, so no customer liability can be
--       computed and a refund cannot know what it is reversing (DR9).
--   G2  `charge.dispute.*` is neither subscribed nor handled (D10). Losing a
--       dispute by silence is a money defect.
--   G9  Diamond package prices are code constants in
--       `pages/api/store/create-checkout-session.js:44-52`, mirrored by hand in
--       club-arena `src/pages/marketplace/marketplaceShared.ts:279`. The
--       database does not know what a package costs (DR8/D16).
--
-- WHAT IS LOG-ONLY (Dan's risk rule 12: nothing here may refuse a paid event)
--
--   DR8  The package-price comparison inside the settle path RECORDS a warning
--        incident on a mismatch or an unknown package and settles anyway. A
--        constraint that refuses a settle refuses a charge Stripe has already
--        taken; the player would be out real money.
--   DR7  A `cs_test_` session settling in the live database RECORDS a warning
--        incident and settles anyway. One such purchase already exists
--        (fe35f19d, 100 diamonds, 2026-02-12). Whether it is reversed is
--        Dan's decision 6.11, not this migration's.
--
-- WHAT ACTUALLY REFUSES
--
--   The two UNIQUE indexes: a second purchase row claiming the same Stripe
--   order id is refused.
--
--   The `CHECK (diamonds >= 0)` on `profiles` is the OTHER half of this lane
--   and ships in the companion migration
--   `20260903003403_diamond_d_the_balance_cannot_go_negative.sql`, applied
--   immediately after this one. It is separate for a reason that was measured,
--   not guessed: the first attempt at this migration held its lock on
--   `diamond_purchases` and then asked for ACCESS EXCLUSIVE on `profiles`, and
--   Postgres killed it with `40P01: deadlock detected` against a live session
--   holding `profiles` and waiting on `auth.users`. Nothing was applied; the
--   whole transaction rolled back. `profiles` is the hottest table on the
--   platform (1,308 rows, every login, every signup trigger, every seat), and
--   the swarm brief already says a hot-table change gets its own migration.
--   The ORDER matters and is deliberate: the refund function below stops
--   writing negatives BEFORE the constraint that would refuse them exists, so
--   there is no window in which a live refund raises 23514.
--
--   That constraint is safe to validate because 0 of 1,308 profiles are
--   negative today and the ONLY unguarded negative writer on the platform is
--   the refund function this migration is fixing. Every other function that
--   subtracts from `profiles.diamonds` was read at `pg_proc` on 2026-09-03 and
--   is guarded:
--
--     transfer_diamonds_deduct        WHERE ... AND diamonds >= deduct_amount
--     send_stream_gift                WHERE ... AND diamonds >= p_amount
--     send_wallet_diamond_transfer    WHERE ... AND diamonds >= p_amount
--     deduct_diamonds                 SELECT ... FOR UPDATE then IF v_current
--                                     < p_amount THEN RETURN (row-locked, so
--                                     the pre-check cannot race)
--     fn_atomic_buyin                 SELECT ... FOR UPDATE then IF v_diamonds
--                                     < p_diamond_cost THEN RETURN
--     fn_purchase_time_banks          SELECT ... FOR UPDATE then IF v_diamonds
--                                     < v_total_cost THEN RETURN (this one is
--                                     broken for an unrelated reason: it
--                                     inserts into a `reason` column that does
--                                     not exist, so every call raises 42703 and
--                                     rolls back. Lane A owns the repair.)
--
--   So the CHECK cannot turn a currently-succeeding call into a 23514. It
--   closes the one door that was open.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT BUILD
--
--   FIFO consumption attribution. `diamond_purchase_lots.consumed` is created
--   and stays 0. Attributing a spend to a lot has to happen at the SINK, which
--   means inside `deduct_diamonds` - Lane C's function, being rewritten in
--   parallel. Two lanes editing one function body is how a rewrite loses half
--   of itself. Roadmap: consume lots FIFO inside the hardened `deduct_diamonds`
--   once Lane C lands, then `purchased_liability = SUM(issued - consumed -
--   refunded)` becomes computable (D1/D4).
--
--   Foreign keys on the three new tables. `diamond_purchases` itself carries
--   `user_id -> profiles ON DELETE CASCADE`, so deleting a paying customer
--   already erases their purchase record (G6, D15). A FK from the lot to the
--   purchase would therefore have to be one of:
--     ON DELETE CASCADE  - erases the lot of a paying customer inside the
--                          chargeback window. D15 forbids it.
--     NO ACTION/RESTRICT - makes account deletion RAISE the moment any lot
--                          exists. 77 profiles were deleted on 2026-09-02;
--                          this would have broken all 77. Dan's risk rule 12.
--   So these tables carry NO foreign key at all, by choice, and say so here.
--   When Lane C's `fn_ca_retire_profile` replaces the CASCADE with RESTRICT
--   and becomes the only deletion path, the FKs can be added as RESTRICT
--   safely. Until then the tables outlive the rows they name, which is the
--   correct bias for a tax-and-chargeback record.
--
--   Provider reconciliation (`fn_ca_purchase_reconcile` against the Stripe
--   balance report, D11/G3). It needs a Stripe API caller, which belongs in an
--   Open Claw cron in the World Hub, not in a migration. Roadmap.
--
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. PRE-FLIGHT. If any assumption stated above is false, abort before any DDL.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  v_dup_sessions integer;
  v_dup_intents  integer;
  v_neg_profiles integer;
  v_bad_status   text;
BEGIN
  SELECT count(*) INTO v_dup_sessions FROM (
    SELECT stripe_checkout_session_id
      FROM public.diamond_purchases
     WHERE stripe_checkout_session_id IS NOT NULL
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dup_sessions > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicate stripe_checkout_session_id groups exist; the UNIQUE index would fail.', v_dup_sessions;
  END IF;

  SELECT count(*) INTO v_dup_intents FROM (
    SELECT stripe_payment_intent_id
      FROM public.diamond_purchases
     WHERE stripe_payment_intent_id IS NOT NULL
     GROUP BY 1 HAVING count(*) > 1) d;
  IF v_dup_intents > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicate stripe_payment_intent_id groups exist.', v_dup_intents;
  END IF;

  SELECT count(*) INTO v_neg_profiles FROM public.profiles WHERE diamonds < 0;
  IF v_neg_profiles > 0 THEN
    RAISE EXCEPTION 'ABORT: % profiles hold a negative diamond balance; VALIDATE would fail. Those balances are money and are Dan''s to resolve, not a migration''s.', v_neg_profiles;
  END IF;

  SELECT string_agg(DISTINCT status, ', ') INTO v_bad_status
    FROM public.diamond_purchases
   WHERE status IS NULL
      OR status NOT IN ('pending', 'completed', 'refunded', 'failed');
  IF v_bad_status IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT: diamond_purchases holds unexpected status values (%). Add them to the CHECK before applying.', v_bad_status;
  END IF;

  RAISE NOTICE 'Pre-flight clean: 0 duplicate session ids, 0 duplicate payment intents, 0 negative diamond balances, statuses within the four known values.';
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. `diamond_packages` - the price oracle the database owns (DR8 / D16).
--    Seeded verbatim from VALID_DIAMOND_PACKAGES in the World Hub
--    `pages/api/store/create-checkout-session.js:44-52`, read 2026-09-03.
--    `display_name` carries the `name` field of that constant, because
--    `diamond_purchases.package_name` stores the display name ('Micro'), not
--    the key ('micro'), and the DR8 comparison has to be able to find the row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.diamond_packages (
  package_key     text PRIMARY KEY,
  display_name    text NOT NULL,
  diamonds        integer NOT NULL CHECK (diamonds > 0),
  bonus_diamonds  integer NOT NULL DEFAULT 0 CHECK (bonus_diamonds >= 0),
  price_usd       numeric(10,2) NOT NULL CHECK (price_usd > 0),
  active          boolean NOT NULL DEFAULT true,
  sort            integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.diamond_packages IS
  'DR8 / D16. The diamond store price oracle. Seeded from VALID_DIAMOND_PACKAGES in Smarter-Poker-World-Hub pages/api/store/create-checkout-session.js. The checkout route reads this table and falls back to the constant if it is unreachable; settle_diamond_card_purchase_atomic compares the purchase row to it and files a DR8 warning incident on a mismatch. It never refuses a settle.';

INSERT INTO public.diamond_packages (package_key, display_name, diamonds, bonus_diamonds, price_usd, active, sort) VALUES
  ('micro',    'Micro',       100,    0,   1.00, true, 1),
  ('small',    'Small',       500,    0,   5.00, true, 2),
  ('medium',   'Medium',     1000,    0,  10.00, true, 3),
  ('standard', 'Standard',   2500,    0,  25.00, true, 4),
  ('large',    'Large',      5000,    0,  50.00, true, 5),
  ('value',    'Value',     10000,  500, 100.00, true, 6),
  ('premium',  'Premium',   25000, 1250, 250.00, true, 7),
  ('whale',    'Whale',     50000, 2500, 500.00, true, 8)
ON CONFLICT (package_key) DO NOTHING;

ALTER TABLE public.diamond_packages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_packages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.diamond_packages TO authenticated;
GRANT ALL ON public.diamond_packages TO service_role;

DROP POLICY IF EXISTS diamond_packages_read_active ON public.diamond_packages;
CREATE POLICY diamond_packages_read_active ON public.diamond_packages
  FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 2. `diamond_purchase_lots` - the purchased sub-ledger (DR9 / D1).
--    No foreign key, deliberately; see the header.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.diamond_purchase_lots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  purchase_id  uuid NOT NULL UNIQUE,
  issued       integer NOT NULL CHECK (issued >= 0),
  consumed     integer NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  refunded     integer NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  frozen_at    timestamptz,
  settled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT diamond_purchase_lots_not_over_drawn CHECK (consumed + refunded <= issued)
);

CREATE INDEX IF NOT EXISTS idx_diamond_purchase_lots_user
  ON public.diamond_purchase_lots (user_id);
CREATE INDEX IF NOT EXISTS idx_diamond_purchase_lots_open
  ON public.diamond_purchase_lots (user_id, created_at)
  WHERE consumed + refunded < issued;

COMMENT ON TABLE public.diamond_purchase_lots IS
  'DR9 / D1. One lot per settled diamond purchase. issued = diamonds_amount + bonus_diamonds at settle. refunded is raised by reconcile_diamond_purchase_refund. consumed is RESERVED and stays 0 until FIFO attribution lands inside the hardened deduct_diamonds (Lane C). Carries no foreign key on purpose: diamond_purchases cascades on profile deletion, so a CASCADE here would erase a paying customer lot (D15) and a RESTRICT here would make account deletion raise.';

ALTER TABLE public.diamond_purchase_lots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_purchase_lots FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.diamond_purchase_lots TO service_role;

-- ---------------------------------------------------------------------------
-- 3. `diamond_debts` - the receivable that replaces a negative balance
--    (DR1 / DR13 / D13). No foreign key, same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.diamond_debts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  purchase_id  uuid,
  amount       integer NOT NULL CHECK (amount > 0),
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  settled_by   text
);

CREATE INDEX IF NOT EXISTS idx_diamond_debts_open
  ON public.diamond_debts (user_id, created_at)
  WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_diamond_debts_purchase
  ON public.diamond_debts (purchase_id)
  WHERE purchase_id IS NOT NULL;

COMMENT ON TABLE public.diamond_debts IS
  'DR1 / DR13 / D13. A chargeback or refund larger than the balance debits the balance to zero and books the remainder here. The balance is never negative. Nothing in this migration settles a debt: whether the next credit pays it down or it is written off to the house is Dan decision 6.2. Rows are append-only until a human sets settled_at / settled_by.';

ALTER TABLE public.diamond_debts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_debts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.diamond_debts TO service_role;

-- ---------------------------------------------------------------------------
-- 4. `diamond_purchase_disputes` - the idempotency key for Stripe disputes
--    (D7 / D10). PK (dispute_id, event) is the whole guard: a replayed
--    webhook claims the row and does nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.diamond_purchase_disputes (
  dispute_id    text NOT NULL,
  event         text NOT NULL,
  purchase_id   uuid NOT NULL,
  amount_cents  integer,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispute_id, event)
);

CREATE INDEX IF NOT EXISTS idx_diamond_purchase_disputes_purchase
  ON public.diamond_purchase_disputes (purchase_id, occurred_at DESC);

COMMENT ON TABLE public.diamond_purchase_disputes IS
  'D7 / D10. One row per (Stripe dispute id, event). fn_diamond_purchase_dispute claims the PK before any side effect, so a redelivered charge.dispute.* webhook freezes nothing twice and reverses nothing twice.';

ALTER TABLE public.diamond_purchase_disputes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diamond_purchase_disputes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.diamond_purchase_disputes TO service_role;

-- ---------------------------------------------------------------------------
-- 5. `diamond_purchases` - the provider order ids become unique (D7 / G4),
--    the status set becomes a CHECK, and the write grants go away.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_diamond_purchases_stripe_session
  ON public.diamond_purchases (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_diamond_purchases_stripe_payment_intent
  ON public.diamond_purchases (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE public.diamond_purchases
  DROP CONSTRAINT IF EXISTS diamond_purchases_status_known;
ALTER TABLE public.diamond_purchases
  ADD CONSTRAINT diamond_purchases_status_known
  CHECK (status IN ('pending', 'completed', 'refunded', 'failed')) NOT VALID;

REVOKE INSERT, UPDATE, DELETE ON public.diamond_purchases FROM anon, authenticated;

COMMENT ON CONSTRAINT diamond_purchases_status_known ON public.diamond_purchases IS
  'The four statuses the live code writes: pending (create-checkout-session), completed (settle_diamond_card_purchase_atomic), refunded (reconcile_diamond_purchase_refund), failed (checkout.session.expired and session-create failure). NOT VALID so it can never refuse a row that predates it.';

-- ---------------------------------------------------------------------------
-- 6. `settle_diamond_card_purchase_atomic` - the live 4,710-char body,
--    unchanged in every branch, plus three ADDITIONS on the settle path only:
--      DR7 log-only: a cs_test_ session settling in the live database.
--      DR8 log-only: the purchase row disagreeing with diamond_packages.
--      DR9: the purchase lot, and the counterparty/class on the journal row.
--    Nothing here can refuse a settle. Every added block swallows its own
--    errors: a paid charge must never fail because a warning could not be
--    written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_diamond_card_purchase_atomic(
  p_purchase_id uuid, p_session_id text, p_payment_intent_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_credit jsonb; v_redemption jsonb;
  v_intent jsonb; v_total integer; v_new_balance integer; v_kind text;
  v_pkg public.diamond_packages%ROWTYPE; v_pkg_found boolean := false;
BEGIN
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;

  IF v_purchase.status = 'completed' THEN
    IF v_purchase.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'purchase_id', v_purchase.id,
      'redemption_status', v_purchase.metadata ->> 'redemption_status');
  END IF;

  -- A charge fully refunded before checkout.completed never credited this
  -- package. Acknowledge the later event as terminal success, bind its Stripe
  -- identities, and never call the wallet credit path.
  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    IF v_purchase.stripe_checkout_session_id IS NOT NULL
       AND v_purchase.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    IF v_purchase.stripe_payment_intent_id IS NOT NULL
       AND v_purchase.stripe_payment_intent_id IS DISTINCT FROM p_payment_intent_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'settlement_conflict');
    END IF;
    UPDATE public.diamond_purchases
       SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, p_session_id),
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, p_payment_intent_id),
           metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('terminal_settlement_acknowledged_at', now()),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'terminal_refund', true,
      'purchase_id', v_purchase.id, 'redemption_status', 'not_requested');
  END IF;
  IF v_purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_pending');
  END IF;

  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);

  -- === DR7, LOG-ONLY ======================================================
  -- A Stripe TEST-mode session settling into live balances. One such purchase
  -- already exists (fe35f19d, 2026-02-12, 100 diamonds). Whether it is
  -- reversed is Dan decision 6.11. This records it; it does not refuse it,
  -- because refusing a settle strands a charge Stripe has already taken.
  BEGIN
    IF p_session_id IS NOT NULL AND left(p_session_id, 8) = 'cs_test_' THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR7:test_mode_session_settled', 'warning', v_purchase.user_id, v_total,
        'settle_diamond_card_purchase_atomic',
        jsonb_build_object('purchase_id', v_purchase.id, 'session_id', p_session_id,
          'package_name', v_purchase.package_name, 'price_usd', v_purchase.price_usd,
          'note', 'Stripe test-mode session credited real diamonds. Log-only by Dan risk rule 12.'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a warning that cannot be written must never fail a paid settle
  END;

  -- === DR8, LOG-ONLY ======================================================
  -- The purchase row is the price oracle at settle time; diamond_packages is
  -- the oracle at checkout time. They must agree. They are compared, never
  -- enforced: a package renamed or repriced between checkout and settle is a
  -- reason to look, not a reason to refuse a paid charge.
  BEGIN
    SELECT * INTO v_pkg FROM public.diamond_packages
     WHERE package_key = lower(COALESCE(v_purchase.package_name, ''))
        OR lower(display_name) = lower(COALESCE(v_purchase.package_name, ''))
     ORDER BY sort LIMIT 1;
    v_pkg_found := FOUND;

    IF NOT v_pkg_found THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR8:purchase_price_disagrees_with_package', 'warning', v_purchase.user_id, v_total,
        'settle_diamond_card_purchase_atomic',
        jsonb_build_object('purchase_id', v_purchase.id, 'reason', 'unknown_package',
          'package_name', v_purchase.package_name,
          'row', jsonb_build_object('diamonds', v_purchase.diamonds_amount,
            'bonus', v_purchase.bonus_diamonds, 'price_usd', v_purchase.price_usd)));
    ELSIF COALESCE(v_purchase.diamonds_amount, -1) <> v_pkg.diamonds
       OR COALESCE(v_purchase.bonus_diamonds, -1) <> v_pkg.bonus_diamonds
       OR COALESCE(v_purchase.price_usd, -1) <> v_pkg.price_usd THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR8:purchase_price_disagrees_with_package', 'warning', v_purchase.user_id, v_total,
        'settle_diamond_card_purchase_atomic',
        jsonb_build_object('purchase_id', v_purchase.id, 'reason', 'value_mismatch',
          'package_key', v_pkg.package_key,
          'row', jsonb_build_object('diamonds', v_purchase.diamonds_amount,
            'bonus', v_purchase.bonus_diamonds, 'price_usd', v_purchase.price_usd),
          'package', jsonb_build_object('diamonds', v_pkg.diamonds,
            'bonus', v_pkg.bonus_diamonds, 'price_usd', v_pkg.price_usd)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- same bias: never fail a paid settle over a comparison
  END;

  v_credit := public.add_diamonds_to_balance(v_purchase.user_id, v_total, 'purchase',
    'Purchased ' || COALESCE(v_purchase.package_name, 'Diamond package') || ' (' || v_total || ' diamonds)',
    v_purchase.id::text);
  IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE
     AND COALESCE((v_credit ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'diamond_credit_failed:%', COALESCE(v_credit ->> 'error', 'unknown');
  END IF;

  -- === DR9: the purchase lot, and DR3 on the journal row it produced ======
  -- The lot is the sub-ledger that makes a refund able to know what it is
  -- reversing. ON CONFLICT DO NOTHING makes a replay a no-op. A failure here
  -- files a critical incident rather than rolling back a settled purchase:
  -- the player keeps their diamonds and a human is told the sub-ledger is
  -- short a row.
  BEGIN
    INSERT INTO public.diamond_purchase_lots (user_id, purchase_id, issued, settled_at)
    VALUES (v_purchase.user_id, v_purchase.id, v_total, now())
    ON CONFLICT (purchase_id) DO NOTHING;

    UPDATE public.diamond_transactions
       SET counterparty = 'purchase_clearing', issuance_class = 'purchased'
     WHERE reference_id = v_purchase.id::text
       AND user_id = v_purchase.user_id
       AND counterparty IS NULL;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR9:purchase_lot_write_failed', 'critical', v_purchase.user_id, v_total,
        'settle_diamond_card_purchase_atomic',
        jsonb_build_object('purchase_id', v_purchase.id, 'sqlstate', SQLSTATE, 'message', SQLERRM));
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END;

  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_kind := v_intent ->> 'kind';
  IF v_kind = 'club_shop' THEN
    v_redemption := public.fn_purchase_club_shop_item_diamonds(
      (v_intent ->> 'club_id')::uuid, v_purchase.user_id, (v_intent ->> 'item_id')::uuid,
      'card-redemption:' || v_purchase.id::text);
  ELSIF v_kind = 'vip_daily' THEN
    v_redemption := public.purchase_vip_with_diamonds_atomic_v2(
      v_purchase.user_id, 150, 1, 'daily', 'card-redemption:' || v_purchase.id::text,
      'VIP Daily Pass (Card Funded)');
  ELSE
    v_redemption := jsonb_build_object('success', true, 'skipped', true);
  END IF;

  SELECT COALESCE(diamonds, 0) INTO v_new_balance FROM public.profiles WHERE id = v_purchase.user_id;
  UPDATE public.diamond_purchases
     SET status = 'completed', stripe_checkout_session_id = p_session_id,
         stripe_payment_intent_id = p_payment_intent_id, completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'redemption_status', CASE WHEN v_kind IS NULL THEN 'not_requested'
             WHEN COALESCE((v_redemption ->> 'success')::boolean, false) THEN 'completed'
             ELSE 'needs_review' END,
           'redemption_error', CASE WHEN COALESCE((v_redemption ->> 'success')::boolean, false)
             THEN NULL ELSE v_redemption ->> 'error' END,
           'redemption_result', v_redemption, 'settled_at', now())
   WHERE id = v_purchase.id;
  RETURN jsonb_build_object('success', true, 'duplicate', false, 'purchase_id', v_purchase.id,
    'new_balance', v_new_balance,
    'redemption_status', CASE WHEN v_kind IS NULL THEN 'not_requested'
      WHEN COALESCE((v_redemption ->> 'success')::boolean, false) THEN 'completed'
      ELSE 'needs_review' END,
    'redemption', v_redemption);
END;
$fn$;

REVOKE ALL ON FUNCTION public.settle_diamond_card_purchase_atomic(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_diamond_card_purchase_atomic(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. `reconcile_diamond_purchase_refund` - the live 6,639-char body with the
--    cumulative model, the pro-rata target, the redemption unwind and every
--    reference shape KEPT VERBATIM. Exactly one thing changes: the clawback.
--
--    WAS:  UPDATE profiles SET diamonds = COALESCE(diamonds, diamond_balance, 0) minus v_delta
--          ... jsonb_build_object('chargeback_debt', v_balance < 0)
--          A refund larger than the balance left the player at a negative
--          integer, which D13 / DR1 forbid and which no report could read.
--
--    NOW:  debit LEAST(delta, current balance), book the remainder in
--          diamond_debts as 'chargeback_exceeds_balance', keep the
--          `chargeback_debt` flag in the result (it now means "a debt was
--          booked" rather than "the balance went negative" - the same thing
--          every caller actually cared about), and stamp the journal row with
--          issuance_class 'refund' and counterparty 'purchase_clearing'.
--          The lot `refunded` is raised to the pro-rata target.
--
--    The journal row records the amount actually applied, not the amount owed,
--    so the journal net and the balance movement agree at the trial balance
--    (DR11/DR12). The part of the reversal that did not move a balance is the
--    debt row, and the metadata names it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_diamond_purchase_refund(
  p_purchase_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_total integer; v_cumulative integer; v_target integer; v_delta integer; v_full boolean;
  v_intent jsonb; v_redemption jsonb; v_unwind jsonb; v_wallet jsonb;
  v_unwind_state text := 'not_requested'; v_balance integer; v_daily_cost integer := 150;
  v_available integer; v_applied integer := 0; v_shortfall integer := 0;
BEGIN
  IF p_charge_amount_cents IS NULL OR p_charge_amount_cents <= 0
     OR p_refunded_amount_cents IS NULL OR p_refunded_amount_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_refund_amount');
  END IF;
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  v_cumulative := GREATEST(COALESCE(v_purchase.refunded_amount_cents, 0),
    LEAST(p_charge_amount_cents, p_refunded_amount_cents));
  v_full := v_cumulative >= p_charge_amount_cents;

  -- This package never credited a wallet. Every refund replay is a successful
  -- zero-delta terminal event, even if events arrive out of order.
  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    UPDATE public.diamond_purchases SET refunded_amount_cents = v_cumulative, updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'fully_refunded', true,
      'terminal_refund', true, 'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0)
                        FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status = 'pending' THEN
    IF NOT v_full THEN RETURN jsonb_build_object('success', false, 'error', 'settlement_pending'); END IF;
    UPDATE public.diamond_purchases
       SET status = 'refunded', refunded_amount_cents = v_cumulative, refunded_diamonds = 0,
           refunded_at = COALESCE(refunded_at, now()),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refund_before_settlement', true),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'fully_refunded', true, 'terminal_refund', true,
      'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0)
                        FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status NOT IN ('completed', 'refunded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_settled');
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'profile_not_found'); END IF;
  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);
  v_target := GREATEST(COALESCE(v_purchase.refunded_diamonds, 0),
    LEAST(v_total, round(v_total::numeric * v_cumulative / p_charge_amount_cents)::integer));
  v_delta := GREATEST(0, v_target - COALESCE(v_purchase.refunded_diamonds, 0));
  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_redemption := COALESCE(v_purchase.metadata -> 'redemption_result', '{}'::jsonb);
  IF v_full AND COALESCE(v_purchase.metadata ->> 'redemption_status', '') = 'completed'
     AND COALESCE(v_purchase.metadata ->> 'redemption_refund_status', '') NOT IN ('revoked', 'debt_recorded') THEN
    IF v_intent ->> 'kind' = 'club_shop' AND v_redemption ? 'purchase_id' THEN
      v_unwind := public.fn_refund_shop_purchase((v_intent ->> 'club_id')::uuid,
        (v_redemption ->> 'purchase_id')::uuid, v_purchase.user_id,
        'Card-funded Club Shop purchase reversed by Stripe refund');
      v_unwind_state := CASE WHEN COALESCE((v_unwind ->> 'success')::boolean, false)
        THEN 'revoked' ELSE 'debt_recorded' END;
    ELSIF v_intent ->> 'kind' = 'vip_daily' THEN
      IF v_profile.vip_tier = 'daily' AND v_profile.vip_expires_at IS NOT NULL
         AND v_redemption ? 'expires_at'
         AND abs(extract(epoch FROM (v_profile.vip_expires_at - (v_redemption ->> 'expires_at')::timestamptz))) < 2 THEN
        UPDATE public.profiles SET vip_expires_at = GREATEST(now(), vip_expires_at - interval '1 day'),
          is_vip = (vip_expires_at - interval '1 day') > now(), updated_at = now()
         WHERE id = v_purchase.user_id;
        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',
          'Reversed card-funded VIP Daily Pass', 'card-redemption-refund:' || v_purchase.id::text);
        IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE
           AND COALESCE((v_wallet ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'daily_redemption_refund_failed:%', COALESCE(v_wallet ->> 'error', 'unknown');
        END IF;
        v_unwind_state := 'revoked';
      ELSE v_unwind_state := 'debt_recorded'; END IF;
    END IF;
  END IF;

  IF v_delta > 0 THEN
    -- DR1 / D13. Clamp the clawback at the balance. The remainder is a
    -- receivable, never a negative integer on a player.
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_available
      FROM public.profiles WHERE id = v_purchase.user_id;
    v_available := GREATEST(COALESCE(v_available, 0), 0);
    v_applied := LEAST(v_delta, v_available);
    v_shortfall := v_delta - v_applied;

    IF v_applied > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_applied,
             diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_applied, updated_at = now()
       WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    ELSE
      v_balance := v_available;
    END IF;

    IF v_shortfall > 0 THEN
      -- Not swallowed: if the receivable cannot be written the whole refund
      -- rolls back and Stripe redelivers. Losing the debt silently is worse
      -- than processing the refund a minute later.
      INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason)
      VALUES (v_purchase.user_id, v_purchase.id, v_shortfall, 'chargeback_exceeds_balance');
      BEGIN
        PERFORM public.fn_ca_diamond_incident(
          'DR1:chargeback_exceeds_balance', 'critical', v_purchase.user_id, v_shortfall,
          'reconcile_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'reversal_owed', v_delta,
            'balance_applied', v_applied, 'debt_booked', v_shortfall,
            'balance_after', v_balance));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;

    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata,counterparty,issuance_class)
    VALUES (v_purchase.user_id,'refund',-v_applied,v_balance,'Stripe refund reconciliation',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_shortfall > 0,
        'reversal_owed',v_delta,'balance_applied',v_applied,'debt_booked',v_shortfall),
      'purchase_clearing','refund');

    -- DR9: the lot carries what was reversed of what it issued.
    BEGIN
      UPDATE public.diamond_purchase_lots
         SET refunded = LEAST(issued - consumed, GREATEST(refunded, v_target))
       WHERE purchase_id = v_purchase.id;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  ELSE
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_balance
      FROM public.profiles WHERE id = v_purchase.user_id;
  END IF;
  UPDATE public.diamond_purchases
     SET refunded_amount_cents = v_cumulative, refunded_diamonds = v_target,
         refunded_at = CASE WHEN v_full THEN COALESCE(refunded_at,now()) ELSE refunded_at END,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'redemption_refund_status',v_unwind_state,'refund_balance_after',v_balance,
           'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,
           'refunded_diamonds',v_target), updated_at=now()
   WHERE id=v_purchase.id;
  RETURN jsonb_build_object('success',true,'fully_refunded',v_full,'refunded_diamonds',v_target,
    'new_balance',v_balance,'redemption_refund_status',v_unwind_state,
    'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,
    'balance_applied',v_applied);
END;
$fn$;

REVOKE ALL ON FUNCTION public.reconcile_diamond_purchase_refund(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_diamond_purchase_refund(uuid, integer, integer) TO service_role;


-- ---------------------------------------------------------------------------
-- 9. `fn_diamond_purchase_dispute` - what the World Hub webhook calls for
--    charge.dispute.created / funds_withdrawn / closed (D10).
--
--    Idempotent by the PK on diamond_purchase_disputes, claimed BEFORE any
--    side effect (D7). `closed` arrives as 'charge.dispute.closed:won' or
--    ':lost' so the outcome is part of the key and both are recorded.
--
--    funds_withdrawn is the one branch that moves money, and it moves it by
--    calling the SAME pro-rata reversal a refund gets. The charge amount is
--    read from the purchase row (round(price_usd * 100)), never from the
--    caller: the server-side price is the only trustworthy figure.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_purchase_dispute(
  p_purchase_id uuid, p_dispute_id text, p_event text, p_amount_cents integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE;
  v_charge_cents integer;
  v_claimed integer;
  v_reversal jsonb;
  v_frozen integer := 0;
BEGIN
  IF p_purchase_id IS NULL OR COALESCE(p_dispute_id, '') = '' OR COALESCE(p_event, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_arguments');
  END IF;
  IF p_event NOT IN ('charge.dispute.created', 'charge.dispute.funds_withdrawn',
                     'charge.dispute.closed:won', 'charge.dispute.closed:lost') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_event', 'event', p_event);
  END IF;

  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;

  -- D7: claim the (dispute, event) pair under the PK before anything happens.
  INSERT INTO public.diamond_purchase_disputes (dispute_id, event, purchase_id, amount_cents)
  VALUES (p_dispute_id, p_event, p_purchase_id, p_amount_cents)
  ON CONFLICT (dispute_id, event) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'event', p_event,
      'purchase_id', p_purchase_id, 'dispute_id', p_dispute_id);
  END IF;

  IF p_event = 'charge.dispute.created' THEN
    UPDATE public.diamond_purchase_lots
       SET frozen_at = COALESCE(frozen_at, now())
     WHERE purchase_id = p_purchase_id;
    GET DIAGNOSTICS v_frozen = ROW_COUNT;
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR10:dispute_opened', 'critical', v_purchase.user_id,
        COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0),
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
          'amount_cents', p_amount_cents, 'lots_frozen', v_frozen,
          'evidence_deadline', 'UNKNOWN',
          'note', 'Stripe allows 7 to 21 days to submit evidence depending on the reason code and the card network. The exact deadline for this account is UNVERIFIED and is carried in the dispute object Stripe sent. A dispute lost by silence is a money defect (D10).'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'lots_frozen', v_frozen, 'evidence_deadline', 'unknown');

  ELSIF p_event = 'charge.dispute.funds_withdrawn' THEN
    v_charge_cents := round(COALESCE(v_purchase.price_usd, 0) * 100)::integer;
    IF v_charge_cents <= 0 THEN
      BEGIN
        PERFORM public.fn_ca_diamond_incident(
          'DR10:dispute_charge_amount_unknown', 'critical', v_purchase.user_id, NULL,
          'fn_diamond_purchase_dispute',
          jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
            'price_usd', v_purchase.price_usd,
            'note', 'The purchase row carries no usable price, so the pro-rata reversal cannot be computed. Reversed nothing.'));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      RETURN jsonb_build_object('success', false, 'error', 'charge_amount_unknown',
        'purchase_id', p_purchase_id);
    END IF;
    v_reversal := public.reconcile_diamond_purchase_refund(
      p_purchase_id, v_charge_cents, LEAST(COALESCE(p_amount_cents, v_charge_cents), v_charge_cents));
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR10:dispute_funds_withdrawn', 'critical', v_purchase.user_id,
        COALESCE((v_reversal ->> 'refunded_diamonds')::integer, 0),
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
          'charge_cents', v_charge_cents, 'withdrawn_cents', p_amount_cents,
          'reversal', v_reversal));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'reversal', v_reversal);

  ELSIF p_event = 'charge.dispute.closed:won' THEN
    UPDATE public.diamond_purchase_lots SET frozen_at = NULL WHERE purchase_id = p_purchase_id;
    GET DIAGNOSTICS v_frozen = ROW_COUNT;
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR10:dispute_closed_won', 'info', v_purchase.user_id, NULL,
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
          'lots_unfrozen', v_frozen,
          'note', 'Dispute won. The lot is spendable again. If funds_withdrawn already reversed the grant, Stripe returns the funds and the re-credit is a HUMAN decision, not an automatic one: this function never credits.'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'lots_unfrozen', v_frozen);

  ELSE -- charge.dispute.closed:lost
    BEGIN
      PERFORM public.fn_ca_diamond_incident(
        'DR10:dispute_closed_lost', 'info', v_purchase.user_id, NULL,
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
          'note', 'Dispute lost. Any reversal booked by funds_withdrawn stands and the lot stays frozen.'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'reversal_stands', true);
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_diamond_purchase_dispute(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_purchase_dispute(uuid, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.fn_diamond_purchase_dispute(uuid, text, text, integer) IS
  'D10. The Stripe dispute handler. Called by pages/api/store/webhooks/stripe.js for charge.dispute.created, charge.dispute.funds_withdrawn and charge.dispute.closed (passed as charge.dispute.closed:won / :lost). Idempotent on (dispute_id, event) by primary key. created freezes the purchase lot; funds_withdrawn calls reconcile_diamond_purchase_refund with the server-side charge amount; closed:won unfreezes; closed:lost records. It never credits a balance.';

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_diamond_purchase_dispute', 'approved',
  'Diamond Accounting Standard Lane D. Stripe dispute handler, service_role only. Moves a balance only on charge.dispute.funds_withdrawn, and only by delegating to reconcile_diamond_purchase_refund with the server-side charge amount from diamond_purchases.price_usd. Idempotent on (dispute_id, event).')
ON CONFLICT (proname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 10. POST-APPLY ASSERTIONS. Anything false here rolls the whole thing back.
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_n integer;
  v_src text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'diamond_purchases'
     AND indexname IN ('ux_diamond_purchases_stripe_session',
                       'ux_diamond_purchases_stripe_payment_intent');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected 2 unique Stripe-id indexes on diamond_purchases, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.diamond_purchases'::regclass
     AND conname = 'diamond_purchases_status_known';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERT FAILED: diamond_purchases_status_known is missing';
  END IF;

  SELECT count(*) INTO v_n FROM public.diamond_packages;
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'ASSERT FAILED: diamond_packages holds % rows, expected the 8 store packages', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.diamond_packages
   WHERE (package_key = 'micro'  AND diamonds = 100   AND bonus_diamonds = 0    AND price_usd = 1.00)
      OR (package_key = 'whale'  AND diamonds = 50000 AND bonus_diamonds = 2500 AND price_usd = 500.00);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the micro and whale packages do not match the World Hub constant';
  END IF;

  -- The exact expression this migration replaced. Its absence is the proof
  -- that no unguarded negative write survives in the refund path.
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'reconcile_diamond_purchase_refund' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: reconcile_diamond_purchase_refund is missing';
  END IF;
  IF position('- v_delta' IN v_src) > 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: the unguarded clawback is still in reconcile_diamond_purchase_refund';
  END IF;
  IF position('diamond_debts' IN v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: reconcile_diamond_purchase_refund does not book a diamond_debts row';
  END IF;
  IF position('LEAST(v_delta, v_available)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: reconcile_diamond_purchase_refund does not clamp the clawback at the balance';
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'diamond_purchases'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: anon/authenticated still hold % write grants on diamond_purchases', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc
   WHERE proname = 'fn_diamond_purchase_dispute' AND pronamespace = 'public'::regnamespace
     AND prosecdef;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERT FAILED: fn_diamond_purchase_dispute is missing or not SECURITY DEFINER';
  END IF;

  SELECT count(*) INTO v_n FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('diamond_packages', 'diamond_purchase_lots', 'diamond_debts',
                       'diamond_purchase_disputes');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'ASSERT FAILED: expected 4 new Lane D tables, found %', v_n;
  END IF;

  RAISE NOTICE 'Lane D post-apply assertions all pass.';
END;
$assert$;

COMMIT;
