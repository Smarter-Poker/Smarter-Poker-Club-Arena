-- ═══════════════════════════════════════════════════════════════════════════
-- RETIRE THE VIP VOCABULARY NO ACCOUNT HOLDS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- @unapplied: dead-config retirement. Reversible, but it changes what an
-- operator sees in two pricing tables, so it is Dan's to apply -- and the
-- feature_pricing half carries a product question (below) that should be
-- answered first. See the pull request that adds this file.
--
-- WHAT IS DEAD, measured against production 2026-09-01.
--
-- 1. public.vip_pricing -- 9 rows, every one is_active = true, priced in
--    diamonds, for tiers 'bronze' / 'silver' / 'gold'.
--
--    Nothing reads it. Its only ever reader, fn_purchase_vip_card, no longer
--    exists in the database; no function in the public schema mentions the
--    table (checked against pg_proc.prosrc), and nothing in this repo queries
--    it outside the migration that created it.
--
--    Worse than unread: it is unmatchable. The live VIP vocabulary on
--    profiles.vip_tier is 'lifetime' (746), 'monthly' (30) and NULL (254).
--    There is no bronze, silver or gold account and there never has been. A
--    table of nine live-looking prices, keyed on a vocabulary no account can
--    hold, is exactly the shape of config that gets read as authoritative by
--    the next person who needs a VIP price.
--
--    RETIRED, NOT DROPPED. is_active = false plus a COMMENT. The prices are
--    the only surviving record of what a VIP card was once meant to cost, and
--    a DROP would destroy that. Every row stays readable; nothing that
--    respects is_active can price from it.
--
-- 2. public.feature_pricing.vip_tiers_included -- three rows promise a feature
--    free to a VIP tier: rabbit_hunt and show_stack_bb to {bronze,silver,gold},
--    offline_protection to {gold}.
--
--    The live fn_purchase_feature never reads the column (no function in the
--    public schema mentions it), and no account could match the values anyway.
--    feature_purchases holds zero rows for any of the three features.
--
--    DELIBERATELY NOT CLEARED, and deliberately not dropped. Both destroy the
--    only record of an intended entitlement, and the column is not what makes
--    this dangerous -- being SILENT is. So this states the situation in the
--    schema itself, where the next implementer will read it.
--
--    FOR DAN, the product question this cannot answer: should a VIP member get
--    rabbit hunt, show-stack-in-BB and offline protection free? If yes, the
--    values must be rewritten in the LIVE vocabulary ('lifetime', 'monthly')
--    and fn_purchase_feature must be taught to read them -- restoring the
--    branch as it stands would grant nothing to nobody. If no, the column can
--    be dropped in a later migration. Do not guess: one answer costs revenue,
--    the other costs a promise.
--
-- WHAT CHANGES OBSERVABLY. Nothing. No code path and no database function
-- reads either object today; this migration writes 9 is_active flags and four
-- comments.
--
-- IDEMPOTENT: the UPDATE is a no-op on a second run; COMMENTs are absolute.
--
-- ROLLBACK (Tier 1 -- fully reversible, no information is lost):
--   UPDATE public.vip_pricing SET is_active = true;
--   COMMENT ON TABLE public.vip_pricing IS NULL;
--   COMMENT ON COLUMN public.feature_pricing.vip_tiers_included IS NULL;

BEGIN;

SET LOCAL lock_timeout = '4s';

UPDATE public.vip_pricing SET is_active = false WHERE is_active;

COMMENT ON TABLE public.vip_pricing IS
  'RETIRED 2026-09-01. Prices VIP cards in diamonds for tiers bronze/silver/gold - a vocabulary no account has ever held (live profiles.vip_tier is lifetime/monthly/NULL). Its only reader, fn_purchase_vip_card, no longer exists. Every row is is_active = false; the rows are kept because they are the only record of what a VIP card was meant to cost. Do NOT price a purchase from this table without asking Dan what the live tiers should cost.';

COMMENT ON COLUMN public.vip_pricing.is_active IS
  'All false since 2026-09-01. See the table comment: this table is retired, not live pricing.';

COMMENT ON COLUMN public.feature_pricing.vip_tiers_included IS
  'READ BY NOTHING as of 2026-09-01. fn_purchase_feature does not consult it, and the three rows that are non-empty (rabbit_hunt, show_stack_bb -> bronze/silver/gold; offline_protection -> gold) name a VIP vocabulary no account holds - live profiles.vip_tier is lifetime/monthly/NULL. The values are kept as the record of an intended entitlement. If VIP members should get these free, rewrite the values in the LIVE vocabulary AND teach fn_purchase_feature to read the column; restoring it as written would grant nothing to nobody.';

COMMENT ON TABLE public.feature_pricing IS
  'Diamond prices for purchasable features. diamond_cost and usage_type are live and are read by fn_purchase_feature. vip_tiers_included is NOT - see its column comment.';

-- Post-apply assertions.
DO $$
DECLARE
  v_live int;
BEGIN
  SELECT count(*) INTO v_live FROM public.vip_pricing WHERE is_active;
  IF v_live <> 0 THEN
    RAISE EXCEPTION 'vip_pricing still has % active row(s)', v_live;
  END IF;

  IF (SELECT count(*) FROM public.vip_pricing) <> 9 THEN
    RAISE EXCEPTION 'vip_pricing lost rows - retirement must not delete the prices';
  END IF;

  IF obj_description('public.vip_pricing'::regclass) IS NULL THEN
    RAISE EXCEPTION 'vip_pricing has no comment - a retired table that does not say so is worse than a live one';
  END IF;

  -- The entitlement rows must survive unchanged: this migration documents
  -- them, it does not decide the product question.
  IF (SELECT count(*) FROM public.feature_pricing
       WHERE coalesce(array_length(vip_tiers_included, 1), 0) > 0) <> 3 THEN
    RAISE EXCEPTION 'the three vip_tiers_included rows were altered - they are Dan''s decision, not this migration''s';
  END IF;
END $$;

COMMIT;
