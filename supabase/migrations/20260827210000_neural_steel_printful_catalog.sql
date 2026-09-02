-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827210000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Neural Steel print-on-demand catalog preparation.
--
-- Provider variant ids are intentionally NOT guessed here. Checkout remains
-- locked until every active size/color row is mapped in metadata and the
-- Printful production environment is explicitly enabled.

BEGIN
UPDATE public.merchandise_items
SET
    name = CASE id
        WHEN 'hoodie-neural' THEN 'Diamond Altitude Hoodie'
        WHEN 'tshirt-gto' THEN 'Royal Circuit Tee'
        WHEN 'hat-diamond' THEN 'Neural Steel Diamond Hat'
        ELSE name
    END,
    description = CASE id
        WHEN 'hoodie-neural' THEN 'Heavyweight Black Hoodie With The Diamond Altitude Circuit Graphic'
        WHEN 'tshirt-gto' THEN 'Premium Black Tee With The Royal Circuit Poker Graphic'
        WHEN 'hat-diamond' THEN 'Structured Black Hat With The Brain-Spade Crest Embroidered On The Crown'
        ELSE description
    END,
    image_url = CASE id
        WHEN 'hoodie-neural' THEN '/images/merch/neural-steel/mockups/diamond-altitude-hoodie.webp'
        WHEN 'tshirt-gto' THEN '/images/merch/neural-steel/mockups/royal-circuit-tee.webp'
        WHEN 'hat-diamond' THEN '/images/merch/neural-steel/mockups/diamond-dad-hat.webp'
        ELSE image_url
    END,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'made_to_order', true,
        'fulfillment_provider', 'printful',
        'fulfillment_status', COALESCE(metadata ->> 'fulfillment_status', 'mapping_required'),
        'design_collection', 'Neural Steel'
    )
WHERE id IN ('hoodie-neural', 'tshirt-gto', 'hat-diamond')
UPDATE public.merchandise_item_variants
SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'fulfillment_provider', 'printful',
    'fulfillment_status', COALESCE(metadata ->> 'fulfillment_status', 'mapping_required')
)
WHERE item_id IN ('hoodie-neural', 'tshirt-gto', 'hat-diamond')
COMMIT
