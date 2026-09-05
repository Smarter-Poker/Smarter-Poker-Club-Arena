-- ═══════════════════════════════════════════════════════════════════════════
--  A GRANTED ITEM REACHES THE PLAYER, OR IT IS NOT SPENT
--  Club Operations upgrade, phase 8 of 8. Club control.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ca_promo_vault_grant` decrements `promo_vault_inventory`, writes a
-- `promo_vault_records` row, and returns `success: true`. **The recipient
-- receives nothing.** There is no entitlement written, no trigger on the
-- records table, and no follow-up job. The owner spends stock bought with
-- diamonds, the shelf goes down, the player gets nothing, and the toast says
-- it was sent.
--
-- The original migration says so itself
-- (`20260823_05_promo_vault.sql`, lines 425-431): "Deliberately does NOT try to
-- activate the benefit on the recipient's account ... The record is the
-- contract; wiring each item type to its subsystem is follow-up work." This is
-- that follow-up work, and the honest half of it is refusing the items whose
-- subsystem does not exist.
--
-- **NOTHING HAS BEEN LOST YET.** `promo_vault_records` holds zero rows across
-- the platform: no grant has ever been made. There is nothing to reconcile and
-- nobody to repay, which is the whole reason this can be fixed forward
-- cleanly (CLAUDE.md 10.9, test 1: the outcome is READ, not assumed).
--
-- ─── WHAT CAN BE DELIVERED, AND WHAT CANNOT ────────────────────────────────
--
-- Each catalogue item was traced to the code that would have to read it.
--
--   time_bank_50      DELIVERABLE. `feature_purchases (feature =
--                     'time_bank_seconds', uses_remaining)` is read by
--                     `fn_time_bank_allowance` and decremented by
--                     `fn_consume_time_bank`; the engine calls both
--                     (ServerTableEngineBase, seat-in and mid-session).
--                     `sp_grant_shop_item` already writes exactly this row for
--                     the club shop, so the shape is proven, not invented.
--
--   rabbit_hunt_100   DELIVERABLE. Same table, `feature = 'rabbit_hunt'`, read
--                     by `fn_consume_rabbit_hunt`, which the engine calls from
--                     `revealRabbitHunt`. That function's own comment says its
--                     purchased-pack branch exists "to make promo_vault
--                     'rabbit_hunt_100' pack mean something". Nothing has ever
--                     written such a pack. This does.
--
--   vip_card_*        NOT DELIVERABLE BY ME, AND THIS IS DAN'S CALL.
--                     `profiles.is_vip / vip_tier / vip_expires_at` exist and
--                     are read everywhere, but the catalogue's tiers are
--                     bronze / sapphire / gold and THE LIVE VOCABULARY IS
--                     'monthly' | 'lifetime' (`src/utils/vipStatus.ts`, which
--                     records Dan's ruling that there is no tier ladder). The
--                     string 'sapphire' appears in exactly one place in the
--                     entire estate: the vault seed itself. Deciding what a
--                     Gold VIP Card gives a player is deciding what a player is
--                     owed, which CLAUDE.md 10.9 reserves to Dan. So the grant
--                     REFUSES rather than inventing a meaning.
--
--   mystery_card_30d  NOT DELIVERABLE. There is no such feature. The string
--   multiplier_*      `mystery_card` appears only in the catalogue seed and an
--                     icon glyph. For the multiplier, the nearest column is
--                     `profiles.diamond_multiplier` - a guarded numeric(4,2)
--                     that cannot even hold 1500, and wiring a "1500x
--                     multiplier" to a diamond EARN RATE would mint diamonds at
--                     1500x and break the mint invariants. A product name with
--                     no product behind it is refused, not guessed at.
--
-- A REFUSAL COSTS THE CLUB NOTHING: it returns before the inventory is
-- touched, so the stock stays on the shelf. That is the entire point. An
-- operator who cannot send a Gold VIP Card today still has the card tomorrow,
-- when somebody decides what it means.
--
-- ─── AND THE GRANT BECOMES RETRYABLE ───────────────────────────────────────
--
-- The old grant had no idempotency key at all, so a response lost on the wire
-- left the operator to guess: press again and maybe send twice, or leave it
-- and maybe send nothing. It takes `p_op_id` now. A repeat under the same key
-- returns the original record with `replayed: true` and touches neither the
-- inventory nor the player's entitlements. This is the same shape phase 7 gave
-- `fn_respond_chip_request`, for the same reason.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- ───────────────────────────────────────────────────────────────────────────
--  1. The key that makes a grant retryable
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.promo_vault_records
  ADD COLUMN IF NOT EXISTS op_id uuid,
  ADD COLUMN IF NOT EXISTS delivered_ref uuid;

COMMENT ON COLUMN public.promo_vault_records.op_id IS
  'The caller''s retry key. A repeat under the same key replays the original record instead of sending again.';
COMMENT ON COLUMN public.promo_vault_records.delivered_ref IS
  'The feature_purchases row this grant created, so a record can be traced to the entitlement it actually delivered. NULL for buy and adjust rows.';

CREATE UNIQUE INDEX IF NOT EXISTS promo_vault_records_op_key
  ON public.promo_vault_records (club_id, op_id)
  WHERE op_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
--  2. What a catalogue item actually delivers
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_promo_vault_delivery_for(p_item_key text)
RETURNS TABLE(feature text, uses_per_unit integer, duration_days integer, why_not text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cat record;
BEGIN
  SELECT c.item_key, c.category, c.pack_size, c.duration_days, c.label
    INTO v_cat
    FROM public.promo_vault_catalog c
   WHERE c.item_key = p_item_key;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
      'That Item Is Not In The Catalogue.'::text;
    RETURN;
  END IF;

  -- The two the platform can honour today. Both land in `feature_purchases`,
  -- which is the table the engine already consumes from.
  IF v_cat.item_key LIKE 'time_bank%' THEN
    RETURN QUERY SELECT 'time_bank_seconds'::text,
                        COALESCE(v_cat.pack_size, 1)::int,
                        v_cat.duration_days::int, NULL::text;
    RETURN;
  END IF;

  IF v_cat.item_key LIKE 'rabbit_hunt%' THEN
    RETURN QUERY SELECT 'rabbit_hunt'::text,
                        COALESCE(v_cat.pack_size, 1)::int,
                        v_cat.duration_days::int, NULL::text;
    RETURN;
  END IF;

  -- Everything else is named honestly rather than delivered vaguely.
  IF v_cat.category = 'vip_card' THEN
    RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
      ('A ' || v_cat.label || ' Cannot Be Sent Yet. This Platform Has No Tier Ladder To Put A Player On, So Nothing Would Reach Them. Your Stock Has Not Been Touched.')::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::text, NULL::int, NULL::int,
    (v_cat.label || ' Cannot Be Sent Yet. Nothing On The Platform Reads It, So The Player Would Receive Nothing. Your Stock Has Not Been Touched.')::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_promo_vault_delivery_for(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_promo_vault_delivery_for(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_promo_vault_delivery_for(text) IS
  'What a vault item delivers, or the sentence explaining why it cannot be delivered. The vault UI asks this so an operator sees the refusal before they choose a recipient, not after.';

-- ───────────────────────────────────────────────────────────────────────────
--  3. The grant
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ca_promo_vault_grant(
  p_club_id uuid, p_item_key text, p_recipient_user_id uuid,
  p_quantity integer, p_note text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_scope     uuid[];
  v_held      int;
  v_qty       int;
  v_remaining int;
  v_del       record;
  v_prior     record;
  v_purchase  uuid;
  v_expires   timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Must Be Signed In To Send Items.');
  END IF;

  IF NOT public.fn_promo_vault_can_manage(p_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only An Owner, Co-Owner Or Admin Can Send From This Vault.'
    );
  END IF;

  -- A REPEAT UNDER THE SAME KEY REPLAYS. Checked before anything is read for
  -- update, so a retry costs nothing and cannot send twice.
  IF p_op_id IS NOT NULL THEN
    SELECT r.id, r.item_key, r.quantity, r.recipient_user_id, r.delivered_ref
      INTO v_prior
      FROM public.promo_vault_records r
     WHERE r.club_id = p_club_id AND r.op_id = p_op_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true, 'error', NULL, 'replayed', true,
        'record_id', v_prior.id, 'item_key', v_prior.item_key,
        'quantity', v_prior.quantity, 'delivered_ref', v_prior.delivered_ref,
        'remaining', (SELECT quantity FROM public.promo_vault_inventory
                       WHERE club_id = p_club_id AND item_key = v_prior.item_key));
    END IF;
  END IF;

  v_qty := coalesce(p_quantity, 0);
  IF v_qty <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose At Least One Item To Send.');
  END IF;
  IF v_qty > 999 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Can Send At Most 999 At A Time.');
  END IF;

  IF p_recipient_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose A Player To Send This To.');
  END IF;

  -- CAN THIS ITEM REACH A PLAYER AT ALL? Asked BEFORE the stock is touched, so
  -- a refusal leaves the shelf exactly as it was.
  SELECT * INTO v_del FROM public.fn_promo_vault_delivery_for(p_item_key);
  IF v_del.why_not IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_del.why_not, 'undeliverable', true);
  END IF;

  v_scope := public.fn_club_scope_ids(p_club_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.club_members cm
    WHERE cm.user_id = p_recipient_user_id
      AND cm.club_id = ANY(v_scope)
      AND coalesce(cm.status, 'approved') NOT IN ('banned', 'rejected', 'left')
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'That Player Is Not A Member Of This Club Or Union.'
    );
  END IF;

  SELECT quantity INTO v_held
  FROM public.promo_vault_inventory
  WHERE club_id = p_club_id AND item_key = p_item_key
  FOR UPDATE;

  IF NOT FOUND OR coalesce(v_held, 0) < v_qty THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Not Enough In The Vault. You Hold %s Of This Item.',
        coalesce(v_held, 0)::text
      ),
      'remaining', coalesce(v_held, 0)
    );
  END IF;

  UPDATE public.promo_vault_inventory
  SET quantity = quantity - v_qty,
      updated_at = now()
  WHERE club_id = p_club_id AND item_key = p_item_key
  RETURNING quantity INTO v_remaining;

  -- THE DELIVERY. One row per grant, carrying the whole pack, in the same
  -- transaction as the decrement - so the stock and the entitlement move
  -- together or neither moves.
  IF v_del.duration_days IS NOT NULL THEN
    v_expires := now() + make_interval(days => v_del.duration_days);
  END IF;

  INSERT INTO public.feature_purchases
    (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES
    (p_recipient_user_id, v_del.feature, 0, 'per_use',
     v_del.uses_per_unit * v_qty, v_expires)
  RETURNING id INTO v_purchase;

  INSERT INTO public.promo_vault_records
    (club_id, item_key, action, quantity, diamonds_spent, actor_user_id,
     recipient_user_id, note, op_id, delivered_ref)
  VALUES
    (p_club_id, p_item_key, 'grant', v_qty, 0, auth.uid(),
     p_recipient_user_id, nullif(btrim(p_note), ''), p_op_id, v_purchase);

  RETURN jsonb_build_object(
    'success', true, 'error', NULL, 'replayed', false,
    'remaining', v_remaining,
    'delivered_ref', v_purchase,
    'delivered_feature', v_del.feature,
    'delivered_uses', v_del.uses_per_unit * v_qty,
    'expires_at', v_expires);
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text, uuid) IS
  'Sends a vault item to a player and WRITES THE ENTITLEMENT, in the same transaction as the stock decrement. Refuses, without touching the stock, any item the platform has nothing to deliver into. Retryable on p_op_id.';

-- THE OLD FIVE-ARGUMENT FORM IS KEPT, AS A WRAPPER, AND THAT IS DELIBERATE.
-- The bundle serving players right now calls it with five arguments; dropping
-- it would make the vault's Send button fail for everyone between this
-- migration and the next publish. It forwards with no retry key, so the old
-- client behaves exactly as it does today - except that what it sends now
-- actually reaches the player, which is the point of this migration.
CREATE OR REPLACE FUNCTION public.ca_promo_vault_grant(
  p_club_id uuid, p_item_key text, p_recipient_user_id uuid,
  p_quantity integer, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.ca_promo_vault_grant(p_club_id, p_item_key, p_recipient_user_id,
                                     p_quantity, p_note, NULL::uuid);
$function$;

REVOKE ALL ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, integer, text) IS
  'Compatibility wrapper for the bundle that predates the retry key. Forwards to the six-argument form with no key, so it delivers correctly but cannot be retried safely. New callers pass p_op_id.';

-- ───────────────────────────────────────────────────────────────────────────
--  4. Assertions
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
  v_n   int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ca_promo_vault_grant';
  -- Two: the six-argument form and the wrapper the live bundle still calls.
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected the grant and its compatibility wrapper, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ca_promo_vault_grant'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_club_id uuid, p_item_key text, p_recipient_user_id uuid, p_quantity integer, p_note text, p_op_id uuid'
  ) THEN
    RAISE EXCEPTION 'the retryable six-argument grant is missing';
  END IF;

  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'ca_promo_vault_grant'
                AND p.pronargs = 6), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%INSERT INTO public.feature_purchases%' THEN
    RAISE EXCEPTION 'the grant still delivers nothing to the recipient';
  END IF;
  IF v_src NOT LIKE '%fn_promo_vault_delivery_for(p_item_key)%' THEN
    RAISE EXCEPTION 'the grant does not ask whether the item can be delivered';
  END IF;

  -- The refusal must come BEFORE the stock is spent. Position, not presence:
  -- a check that runs after the decrement is not a check.
  IF position('fn_promo_vault_delivery_for' in v_src)
     > position('UPDATE public.promo_vault_inventory' in v_src) THEN
    RAISE EXCEPTION 'the deliverability check runs after the stock is decremented';
  END IF;

  -- And the three that cannot be delivered must actually refuse.
  IF (SELECT why_not FROM public.fn_promo_vault_delivery_for('vip_card_gold_30d')) IS NULL THEN
    RAISE EXCEPTION 'a VIP card reports as deliverable, and nothing would reach the player';
  END IF;
  IF (SELECT why_not FROM public.fn_promo_vault_delivery_for('mystery_card_30d')) IS NULL THEN
    RAISE EXCEPTION 'the mystery card reports as deliverable';
  END IF;
  IF (SELECT why_not FROM public.fn_promo_vault_delivery_for('multiplier_1500_30d')) IS NULL THEN
    RAISE EXCEPTION 'the multiplier reports as deliverable';
  END IF;

  -- And the two that can, must.
  IF (SELECT feature FROM public.fn_promo_vault_delivery_for('time_bank_50')) IS DISTINCT FROM 'time_bank_seconds' THEN
    RAISE EXCEPTION 'the time bank pack does not resolve to the feature the engine consumes';
  END IF;
  IF (SELECT uses_per_unit FROM public.fn_promo_vault_delivery_for('time_bank_50')) <> 50 THEN
    RAISE EXCEPTION 'the time bank pack does not carry its pack size';
  END IF;
  IF (SELECT feature FROM public.fn_promo_vault_delivery_for('rabbit_hunt_100')) IS DISTINCT FROM 'rabbit_hunt' THEN
    RAISE EXCEPTION 'the rabbit hunt pack does not resolve to the feature the engine consumes';
  END IF;
END $$;

COMMIT;
