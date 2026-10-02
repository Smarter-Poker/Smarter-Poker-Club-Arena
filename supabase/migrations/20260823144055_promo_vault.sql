-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823144055 as "promo_vault"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ============================================================================
-- 20260823_05_promo_vault
-- Promo Vault: a shelf a club can buy onto with diamonds and grant from later.
-- Full prose rationale in supabase/migrations/20260823_05_promo_vault.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.promo_vault_catalog (
  item_key      text PRIMARY KEY,
  category      text NOT NULL CHECK (category IN ('feature', 'vip_card')),
  label         text NOT NULL,
  description   text,
  duration_days int,
  pack_size     int,
  tier          text,
  diamond_cost  int NOT NULL CHECK (diamond_cost > 0),
  icon_key      text,
  sort_order    int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.promo_vault_catalog IS
  'Everything a club or union can buy into its Promo Vault: features and VIP cards, priced in diamonds.';

CREATE TABLE IF NOT EXISTS public.promo_vault_inventory (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  item_key   text NOT NULL REFERENCES public.promo_vault_catalog(item_key) ON DELETE RESTRICT,
  quantity   int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_vault_inventory_club_item_key UNIQUE (club_id, item_key)
);

COMMENT ON TABLE public.promo_vault_inventory IS
  'Items a club or union owns and has not yet granted. One row per club per item, holding a count.';

CREATE TABLE IF NOT EXISTS public.promo_vault_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  item_key          text NOT NULL REFERENCES public.promo_vault_catalog(item_key) ON DELETE RESTRICT,
  action            text NOT NULL CHECK (action IN ('purchase', 'grant', 'revoke')),
  quantity          int NOT NULL,
  diamonds_spent    int NOT NULL DEFAULT 0,
  actor_user_id     uuid,
  recipient_user_id uuid,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.promo_vault_records IS
  'Append-only Promo Vault ledger: purchases, grants and revokes, newest first on the Records tab.';

CREATE INDEX IF NOT EXISTS promo_vault_records_club_created_idx
  ON public.promo_vault_records (club_id, created_at DESC);

INSERT INTO public.promo_vault_catalog
  (item_key, category, label, description, duration_days, pack_size, tier, diamond_cost, icon_key, sort_order)
VALUES
  ('time_bank_50',        'feature',  'Time Bank',      'Fifty extra time bank charges for one player.',                 NULL, 50,  NULL,      500,  'time-bank',    10),
  ('rabbit_hunt_100',     'feature',  'Rabbit Hunt',    'One hundred rabbit hunts, revealing the cards that never came.', NULL, 100, NULL,     800,  'rabbit-hunt',  20),
  ('mystery_card_30d',    'feature',  'Mystery Card',   'Mystery Card unlocked for thirty days.',                        30,   NULL, NULL,     1200, 'mystery-card', 30),
  ('multiplier_1500_30d', 'feature',  'Multiplier',     'Up to a fifteen hundred times multiplier for thirty days.',     30,   1500, NULL,     1500, 'multiplier',   40),
  ('vip_card_bronze_30d',   'vip_card', 'Bronze VIP Card',   'Bronze tier benefits for thirty days.',   30,  NULL, 'bronze',   600,   'vip-bronze',   110),
  ('vip_card_bronze_90d',   'vip_card', 'Bronze VIP Card',   'Bronze tier benefits for ninety days.',   90,  NULL, 'bronze',   1600,  'vip-bronze',   120),
  ('vip_card_bronze_365d',  'vip_card', 'Bronze VIP Card',   'Bronze tier benefits for a full year.',   365, NULL, 'bronze',   5500,  'vip-bronze',   130),
  ('vip_card_sapphire_30d', 'vip_card', 'Sapphire VIP Card', 'Sapphire tier benefits for thirty days.', 30,  NULL, 'sapphire', 1200,  'vip-sapphire', 210),
  ('vip_card_sapphire_90d', 'vip_card', 'Sapphire VIP Card', 'Sapphire tier benefits for ninety days.', 90,  NULL, 'sapphire', 3200,  'vip-sapphire', 220),
  ('vip_card_sapphire_365d','vip_card', 'Sapphire VIP Card', 'Sapphire tier benefits for a full year.', 365, NULL, 'sapphire', 11000, 'vip-sapphire', 230),
  ('vip_card_gold_30d',     'vip_card', 'Gold VIP Card',     'Gold tier benefits for thirty days.',     30,  NULL, 'gold',     2400,  'vip-gold',     310),
  ('vip_card_gold_90d',     'vip_card', 'Gold VIP Card',     'Gold tier benefits for ninety days.',     90,  NULL, 'gold',     6400,  'vip-gold',     320),
  ('vip_card_gold_365d',    'vip_card', 'Gold VIP Card',     'Gold tier benefits for a full year.',     365, NULL, 'gold',     22000, 'vip-gold',     330)
ON CONFLICT (item_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_promo_vault_visible(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $vis$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_members cm
    WHERE cm.user_id = auth.uid()
      AND (
        cm.club_id = p_club_id
        OR p_club_id = ANY(public.fn_club_scope_ids(cm.club_id))
      )
  )
  OR EXISTS (
    SELECT 1 FROM public.clubs c
    WHERE c.owner_id = auth.uid()
      AND (c.id = p_club_id OR p_club_id = ANY(public.fn_club_scope_ids(c.id)))
  );
$vis$;

COMMENT ON FUNCTION public.fn_promo_vault_visible(uuid) IS
  'True when the calling user belongs to the club whose vault this is, or to the union above it.';

REVOKE ALL ON FUNCTION public.fn_promo_vault_visible(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_promo_vault_visible(uuid) TO authenticated, service_role;

ALTER TABLE public.promo_vault_catalog   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_vault_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_vault_records   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS promo_vault_catalog_read   ON public.promo_vault_catalog;
DROP POLICY IF EXISTS promo_vault_inventory_read ON public.promo_vault_inventory;
DROP POLICY IF EXISTS promo_vault_records_read   ON public.promo_vault_records;

CREATE POLICY promo_vault_catalog_read
  ON public.promo_vault_catalog
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY promo_vault_inventory_read
  ON public.promo_vault_inventory
  FOR SELECT TO authenticated
  USING (public.fn_promo_vault_visible(club_id));

CREATE POLICY promo_vault_records_read
  ON public.promo_vault_records
  FOR SELECT TO authenticated
  USING (public.fn_promo_vault_visible(club_id));

GRANT SELECT ON public.promo_vault_catalog   TO authenticated;
GRANT SELECT ON public.promo_vault_inventory TO authenticated;
GRANT SELECT ON public.promo_vault_records   TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_promo_vault_can_manage(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $mgr$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.role IN ('owner', 'co_owner', 'admin')
      AND cm.club_id = ANY(public.fn_club_scope_ids(p_club_id))
  )
  OR EXISTS (
    SELECT 1 FROM public.clubs c
    WHERE c.owner_id = auth.uid()
      AND c.id = ANY(public.fn_club_scope_ids(p_club_id))
  );
$mgr$;

COMMENT ON FUNCTION public.fn_promo_vault_can_manage(uuid) IS
  'True when the calling user is owner, co-owner or admin of this club or of any club in its scope.';

REVOKE ALL ON FUNCTION public.fn_promo_vault_can_manage(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_promo_vault_can_manage(uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.ca_promo_vault_catalog(uuid);

CREATE OR REPLACE FUNCTION public.ca_promo_vault_catalog(p_club_id uuid)
RETURNS TABLE (
  item_key      text,
  category      text,
  label         text,
  description   text,
  duration_days int,
  pack_size     int,
  tier          text,
  diamond_cost  int,
  icon_key      text,
  sort_order    int,
  quantity      int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $cat$
  SELECT
    c.item_key,
    c.category,
    c.label,
    c.description,
    c.duration_days,
    c.pack_size,
    c.tier,
    c.diamond_cost,
    c.icon_key,
    c.sort_order,
    coalesce(i.quantity, 0) AS quantity
  FROM public.promo_vault_catalog c
  LEFT JOIN public.promo_vault_inventory i
    ON i.item_key = c.item_key AND i.club_id = p_club_id
  WHERE c.is_active
  ORDER BY c.sort_order, c.label;
$cat$;

COMMENT ON FUNCTION public.ca_promo_vault_catalog(uuid) IS
  'Active Promo Vault catalog with the quantity this club currently holds of each item.';

REVOKE ALL ON FUNCTION public.ca_promo_vault_catalog(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_catalog(uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.ca_promo_vault_buy(uuid, text, int);

CREATE OR REPLACE FUNCTION public.ca_promo_vault_buy(
  p_club_id  uuid,
  p_item_key text,
  p_quantity int
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $buy$
DECLARE
  v_item    public.promo_vault_catalog%ROWTYPE;
  v_balance numeric;
  v_cost    bigint;
  v_qty     int;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Must Be Signed In To Buy Items.');
  END IF;

  IF NOT public.fn_promo_vault_can_manage(p_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only An Owner, Co-Owner Or Admin Can Buy For This Vault.'
    );
  END IF;

  v_qty := coalesce(p_quantity, 0);
  IF v_qty <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Choose At Least One Item.');
  END IF;
  IF v_qty > 999 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Can Buy At Most 999 At A Time.');
  END IF;

  SELECT * INTO v_item
  FROM public.promo_vault_catalog
  WHERE item_key = p_item_key AND is_active;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That Item Is No Longer Available.');
  END IF;

  v_cost := v_item.diamond_cost::bigint * v_qty;

  SELECT balance INTO v_balance
  FROM public.club_diamond_wallets
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'This Club Has No Diamond Wallet Yet.'
    );
  END IF;

  IF v_balance < v_cost THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Not Enough Diamonds. This Costs %s And The Club Holds %s.',
        to_char(v_cost, 'FM999G999G999'),
        to_char(floor(v_balance), 'FM999G999G999')
      ),
      'diamond_balance', v_balance
    );
  END IF;

  UPDATE public.club_diamond_wallets
  SET balance              = balance - v_cost,
      total_withdrawn      = coalesce(total_withdrawn, 0) + v_cost,
      last_transaction_at  = now(),
      updated_at           = now()
  WHERE club_id = p_club_id
  RETURNING balance INTO v_balance;

  INSERT INTO public.promo_vault_inventory (club_id, item_key, quantity)
  VALUES (p_club_id, p_item_key, v_qty)
  ON CONFLICT (club_id, item_key)
  DO UPDATE SET quantity   = public.promo_vault_inventory.quantity + EXCLUDED.quantity,
                updated_at = now()
  RETURNING quantity INTO v_qty;

  INSERT INTO public.promo_vault_records
    (club_id, item_key, action, quantity, diamonds_spent, actor_user_id)
  VALUES
    (p_club_id, p_item_key, 'purchase', p_quantity, v_cost, auth.uid());

  RETURN jsonb_build_object(
    'success', true,
    'error', NULL,
    'quantity', v_qty,
    'diamonds_spent', v_cost,
    'diamond_balance', v_balance
  );
END;
$buy$;

COMMENT ON FUNCTION public.ca_promo_vault_buy(uuid, text, int) IS
  'Buy Promo Vault items with the club diamond wallet: locks the wallet, debits it, adds to inventory and writes a purchase record, atomically.';

REVOKE ALL ON FUNCTION public.ca_promo_vault_buy(uuid, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_buy(uuid, text, int) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.ca_promo_vault_grant(uuid, text, uuid, int, text);

CREATE OR REPLACE FUNCTION public.ca_promo_vault_grant(
  p_club_id           uuid,
  p_item_key          text,
  p_recipient_user_id uuid,
  p_quantity          int,
  p_note              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $grt$
DECLARE
  v_scope     uuid[];
  v_held      int;
  v_qty       int;
  v_remaining int;
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

  INSERT INTO public.promo_vault_records
    (club_id, item_key, action, quantity, diamonds_spent, actor_user_id, recipient_user_id, note)
  VALUES
    (p_club_id, p_item_key, 'grant', v_qty, 0, auth.uid(), p_recipient_user_id, nullif(btrim(p_note), ''));

  RETURN jsonb_build_object('success', true, 'error', NULL, 'remaining', v_remaining);
END;
$grt$;

COMMENT ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, int, text) IS
  'Send Promo Vault items to a player in the club or union: locks the inventory row, decrements it and writes a grant record.';

REVOKE ALL ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, int, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_grant(uuid, text, uuid, int, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.ca_promo_vault_records(uuid, int);

CREATE OR REPLACE FUNCTION public.ca_promo_vault_records(
  p_club_id uuid,
  p_limit   int DEFAULT 100
)
RETURNS TABLE (
  id                       uuid,
  created_at               timestamptz,
  action                   text,
  item_key                 text,
  item_label               text,
  item_category            text,
  item_duration_days       int,
  quantity                 int,
  diamonds_spent           int,
  actor_user_id            uuid,
  actor_name               text,
  recipient_user_id        uuid,
  recipient_name           text,
  recipient_player_number  text,
  note                     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $rec$
  SELECT
    r.id,
    r.created_at,
    r.action,
    r.item_key,
    coalesce(c.label, r.item_key)::text,
    coalesce(c.category, 'feature')::text,
    c.duration_days,
    r.quantity,
    r.diamonds_spent,
    r.actor_user_id,
    coalesce(nullif(btrim(ap.alias), ''), nullif(btrim(ap.display_name), ''), ap.username)::text,
    r.recipient_user_id,
    coalesce(nullif(btrim(rp.alias), ''), nullif(btrim(rp.display_name), ''), rp.username)::text,
    rp.player_number::text,
    r.note
  FROM public.promo_vault_records r
  LEFT JOIN public.promo_vault_catalog c ON c.item_key = r.item_key
  LEFT JOIN public.profiles ap ON ap.id = r.actor_user_id
  LEFT JOIN public.profiles rp ON rp.id = r.recipient_user_id
  WHERE r.club_id = p_club_id
  ORDER BY r.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$rec$;

COMMENT ON FUNCTION public.ca_promo_vault_records(uuid, int) IS
  'Promo Vault ledger for a club, newest first, with the item label and the recipient alias and player number resolved.';

REVOKE ALL ON FUNCTION public.ca_promo_vault_records(uuid, int) FROM public;
GRANT EXECUTE ON FUNCTION public.ca_promo_vault_records(uuid, int) TO authenticated, service_role;

DO $assert$
DECLARE
  v_tables int;
  v_items  int;
  v_fns    int;
BEGIN
  SELECT count(*) INTO v_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('promo_vault_catalog', 'promo_vault_inventory', 'promo_vault_records');

  IF v_tables <> 3 THEN
    RAISE EXCEPTION 'Promo Vault: expected 3 tables, found %', v_tables;
  END IF;

  SELECT count(*) INTO v_items FROM public.promo_vault_catalog WHERE is_active;
  IF v_items <> 13 THEN
    RAISE EXCEPTION 'Promo Vault: expected 13 active catalog items (4 features + 9 VIP cards), found %', v_items;
  END IF;

  IF (SELECT count(*) FROM public.promo_vault_catalog WHERE category = 'feature') <> 4 THEN
    RAISE EXCEPTION 'Promo Vault: expected 4 feature items';
  END IF;

  IF (SELECT count(*) FROM public.promo_vault_catalog WHERE category = 'vip_card') <> 9 THEN
    RAISE EXCEPTION 'Promo Vault: expected 9 VIP card items (3 tiers x 30/90/365 days)';
  END IF;

  SELECT count(*) INTO v_fns
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('ca_promo_vault_catalog', 'ca_promo_vault_buy',
                      'ca_promo_vault_grant', 'ca_promo_vault_records');
  IF v_fns <> 4 THEN
    RAISE EXCEPTION 'Promo Vault: expected 4 RPCs, found %', v_fns;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('promo_vault_catalog', 'promo_vault_inventory', 'promo_vault_records')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Promo Vault: a non-SELECT RLS policy exists; writes must go through the RPCs only';
  END IF;
END;
$assert$;

