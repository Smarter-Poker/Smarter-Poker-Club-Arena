-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828010000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Neural Steel Collection 02: ten new wearable designs plus sunglasses and
-- non-wearable poker/lifestyle products.
--
-- Safety contract:
--   * Products are visible so the finished collection can be reviewed.
--   * Printful-capable products are marked mapping_required.
--   * Products that need a different supplier are provider_pending.
--   * No provider ids are guessed. Existing checkout gates therefore keep
--     every unmapped product locked and cannot charge a customer.

BEGIN
INSERT INTO public.merchandise_items (
    id, name, description, category, image_url, price_usd, price_diamonds,
    is_active, sort_order, stock, has_variants, metadata
)
VALUES
    ('ice-orbit-snapback', 'Ice Orbit Snapback', 'Structured Matte-Black Snapback With An Ice-Chrome Neural Spade Crest', 'headwear', '/images/merch/neural-steel/collection-02/ice-orbit-snapback.webp', 34.99, 3499, TRUE, 100, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Snapback Hat"}'::jsonb),
    ('river-signal-trucker-hat', 'River Signal Trucker Hat', 'Technical Black Trucker Hat With A Circuit-Wave Suit Signal', 'headwear', '/images/merch/neural-steel/collection-02/river-signal-trucker-hat.webp', 32.99, 3299, TRUE, 110, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Trucker Hat"}'::jsonb),
    ('midnight-circuit-beanie', 'Midnight Circuit Beanie', 'Ribbed Black Cuff Beanie With A Chrome Poker-Core Circuit Emblem', 'headwear', '/images/merch/neural-steel/collection-02/midnight-circuit-beanie.webp', 29.99, 2999, TRUE, 120, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Cuff Beanie"}'::jsonb),
    ('dead-money-detector-tee', 'Dead Money Detector Tee', 'Heavyweight Black Tee With A Chrome Poker Radar Instrument Graphic', 'apparel', '/images/merch/neural-steel/collection-02/dead-money-detector-tee.webp', 31.99, 3199, TRUE, 130, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"T-Shirt"}'::jsonb),
    ('range-architect-tee', 'Range Architect Tee', 'Heavyweight Black Tee With A Precision-Built Chrome Spade Blueprint', 'apparel', '/images/merch/neural-steel/collection-02/range-architect-tee.webp', 31.99, 3199, TRUE, 140, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"T-Shirt"}'::jsonb),
    ('all-in-after-dark-tee', 'All In After Dark Tee', 'Heavyweight Black Tee With Chrome Tournament Chips Entering A Cyan Diamond Aperture', 'apparel', '/images/merch/neural-steel/collection-02/all-in-after-dark-tee.webp', 31.99, 3199, TRUE, 150, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"T-Shirt"}'::jsonb),
    ('no-free-cards-tee', 'No Free Cards Tee', 'Heavyweight Black Tee With A Locked Chrome Card-Vault Circuit Graphic', 'apparel', '/images/merch/neural-steel/collection-02/no-free-cards-tee.webp', 31.99, 3199, TRUE, 160, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"T-Shirt"}'::jsonb),
    ('cold-four-bet-hoodie', 'Cold Four-Bet Hoodie', 'Heavyweight Black Hoodie With Four Chrome Betting Discs Under Diamond Pressure', 'apparel', '/images/merch/neural-steel/collection-02/cold-four-bet-hoodie.webp', 64.99, 6499, TRUE, 170, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Pullover Hoodie"}'::jsonb),
    ('final-table-voltage-hoodie', 'Final Table Voltage Hoodie', 'Heavyweight Black Hoodie With Seven Final-Table Seats Orbiting A Live Circuit Core', 'apparel', '/images/merch/neural-steel/collection-02/final-table-voltage-hoodie.webp', 66.99, 6699, TRUE, 180, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Pullover Hoodie"}'::jsonb),
    ('stack-pressure-zip-hoodie', 'Stack Pressure Zip Hoodie', 'Premium Black Zip Hoodie With Mirrored Chrome Stacks And Cyan Pressure Lines', 'apparel', '/images/merch/neural-steel/collection-02/stack-pressure-zip-hoodie.webp', 69.99, 6999, TRUE, 190, NULL, TRUE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Zip Hoodie"}'::jsonb),
    ('river-read-polarized-sunglasses', 'River Read Polarized Sunglasses', 'Angular Matte-Black Performance Frames With Cyan Mirror Polarized Lenses', 'eyewear', '/images/merch/neural-steel/collection-02/river-read-sunglasses.webp', 44.99, 4499, TRUE, 200, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"provider_pending","fulfillment_status":"provider_required","design_collection":"Neural Steel Collection 02","product_type":"Polarized Sunglasses"}'::jsonb),
    ('final-table-mirror-sunglasses', 'Final Table Mirror Sunglasses', 'Sharp Square Black Frames With Ice-Chrome To Cyan Mirror Lenses', 'eyewear', '/images/merch/neural-steel/collection-02/final-table-mirror-sunglasses.webp', 49.99, 4999, TRUE, 210, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"provider_pending","fulfillment_status":"provider_required","design_collection":"Neural Steel Collection 02","product_type":"Mirror Sunglasses"}'::jsonb),
    ('tournament-wire-tumbler', 'Tournament Wire Insulated Tumbler', 'Matte-Black Stainless Tumbler With An Etched Neural Suit Circuit', 'lifestyle', '/images/merch/neural-steel/collection-02/tournament-wire-tumbler.webp', 29.99, 2999, TRUE, 220, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Insulated Tumbler"}'::jsonb),
    ('neural-steel-card-protector', 'Neural Steel Card Protector', 'Weighted Blackened-Steel Card Guard With A Machined Spade-Diamond Crest', 'tabletop', '/images/merch/neural-steel/collection-02/neural-steel-card-protector.webp', 27.99, 2799, TRUE, 230, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"provider_pending","fulfillment_status":"provider_required","design_collection":"Neural Steel Collection 02","product_type":"Card Protector"}'::jsonb),
    ('circuit-breaker-playing-cards', 'Circuit Breaker Playing Cards', 'Premium Matte-Black Poker Deck With A Symmetrical Chrome Circuit Back', 'tabletop', '/images/merch/neural-steel/collection-02/circuit-breaker-deck.webp', 18.99, 1899, TRUE, 240, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"provider_pending","fulfillment_status":"provider_required","design_collection":"Neural Steel Collection 02","product_type":"Playing Card Deck"}'::jsonb),
    ('range-grid-desk-mat', 'Range Grid Desk Mat', 'Wide Black Desk Mat With A Graphite Poker Range Grid And Cyan Nodes', 'accessories', '/images/merch/neural-steel/collection-02/range-grid-desk-mat.webp', 39.99, 3999, TRUE, 250, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"provider_pending","fulfillment_status":"provider_required","design_collection":"Neural Steel Collection 02","product_type":"Desk Mat"}'::jsonb),
    ('vault-cut-poker-towel', 'Vault Cut Poker Towel', 'Premium Black Microfiber Towel With Chrome Borders And Circuit Corners', 'accessories', '/images/merch/neural-steel/collection-02/vault-cut-poker-towel.webp', 24.99, 2499, TRUE, 260, NULL, FALSE,
        '{"made_to_order":true,"fulfillment_provider":"printful","fulfillment_status":"mapping_required","design_collection":"Neural Steel Collection 02","product_type":"Microfiber Towel"}'::jsonb)
ON CONFLICT (id) DO NOTHING
-- One-size headwear still receives a variant because Printful requires an
-- exact sync_variant_id for the chosen physical blank.
INSERT INTO public.merchandise_item_variants (
    item_id, sku, size, color, stock, is_active, sort_order, metadata
)
VALUES
    ('ice-orbit-snapback', 'NS02-ICE-ORBIT-BLK-OS', 'One Size', 'Black', 75, TRUE, 10, '{"fulfillment_provider":"printful","fulfillment_status":"mapping_required"}'::jsonb),
    ('river-signal-trucker-hat', 'NS02-RIVER-SIGNAL-BLK-OS', 'One Size', 'Black', 75, TRUE, 10, '{"fulfillment_provider":"printful","fulfillment_status":"mapping_required"}'::jsonb),
    ('midnight-circuit-beanie', 'NS02-MIDNIGHT-CIRCUIT-BLK-OS', 'One Size', 'Black', 75, TRUE, 10, '{"fulfillment_provider":"printful","fulfillment_status":"mapping_required"}'::jsonb)
ON CONFLICT (sku) DO NOTHING
-- All shirts and hoodies ship in a deliberately conservative first size run.
-- Stock remains editable in the new admin console and checkout remains locked
-- until each row receives its actual Printful mapping.
WITH wearable(item_id, sku_prefix) AS (
    VALUES
        ('dead-money-detector-tee', 'NS02-DEAD-MONEY'),
        ('range-architect-tee', 'NS02-RANGE-ARCH'),
        ('all-in-after-dark-tee', 'NS02-AIAD'),
        ('no-free-cards-tee', 'NS02-NO-FREE'),
        ('cold-four-bet-hoodie', 'NS02-COLD-4BET'),
        ('final-table-voltage-hoodie', 'NS02-FT-VOLT'),
        ('stack-pressure-zip-hoodie', 'NS02-STACK-PRESS')
), sizes(size, stock, sort_order) AS (
    VALUES ('S', 40, 10), ('M', 60, 20), ('L', 60, 30), ('XL', 40, 40), ('2XL', 20, 50)
)
INSERT INTO public.merchandise_item_variants (
    item_id, sku, size, color, stock, is_active, sort_order, metadata
)
SELECT
    wearable.item_id,
    wearable.sku_prefix || '-BLK-' || sizes.size,
    sizes.size,
    'Black',
    sizes.stock,
    TRUE,
    sizes.sort_order,
    '{"fulfillment_provider":"printful","fulfillment_status":"mapping_required"}'::jsonb
FROM wearable
CROSS JOIN sizes
ON CONFLICT (sku) DO NOTHING
COMMIT
