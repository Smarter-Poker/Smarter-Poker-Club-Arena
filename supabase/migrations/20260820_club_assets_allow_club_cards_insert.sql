-- Applied to production via Supabase MCP on 2026-08-20. Mirrored here EXACTLY
-- as applied (house rule: migrations in this repo are a record, not the source
-- of truth — see CLAUDE.md).
--
-- WHY
-- The club-assets bucket granted authenticated INSERT only under 'club-logos/%'.
-- Baked club CARDS are written to 'club-cards/<club_id>-card.<ext>' by
-- ClubCardBackfill and by CreateClubModal, so every one of those uploads was
-- refused by RLS with a 400 -- the club-card feature had never worked.
--
-- It was not failing quietly either: HomePage re-runs the backfill on EVERY
-- load for any club still missing card_image_url. So each page view generated
-- the card on canvas, failed to store it, disabled itself for that session,
-- and did the whole thing again on the next load. That is the 400 that showed
-- up on club-cards/77777-card.webp in the console.
--
-- Same trust level as the logo policy that already existed (any authenticated
-- user), extended to the sibling prefix the code actually writes to. UPDATE is
-- included because the client uploads with upsert:true, which rewrites an
-- existing object rather than inserting.

DROP POLICY IF EXISTS "club cards authenticated insert" ON storage.objects;
CREATE POLICY "club cards authenticated insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'club-assets' AND name LIKE 'club-cards/%');

DROP POLICY IF EXISTS "club cards owner update" ON storage.objects;
CREATE POLICY "club cards owner update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'club-assets' AND name LIKE 'club-cards/%')
  WITH CHECK (bucket_id = 'club-assets' AND name LIKE 'club-cards/%');
