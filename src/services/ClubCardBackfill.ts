/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubCardBackfill — Lazy baked-card generation for clubs missing card_image_url
 * ═══════════════════════════════════════════════════════════════════════════════
 * When a club has logo_url but no card_image_url, this utility:
 *  1. Generates a baked card using ClubCardGenerator (canvas compositing)
 *  2. Uploads the result to Supabase Storage (club-assets bucket)
 *  3. Updates the club's card_image_url in the database
 *
 * Called lazily from the home page so existing clubs get auto-upgraded.
 * Uses a session-level Set to avoid re-processing the same club twice per visit.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// Track which clubs we've already attempted to backfill this session
const processedClubs = new Set<string>();

// Session-level kill switch — if the storage bucket doesn't exist, stop trying
let storageDisabled = false;

interface BackfillTarget {
  id: string;
  club_id: number;
  name: string;
  logo_url: string;
  entityType?: 'club' | 'union';
}

/**
 * Attempt to backfill baked card images for clubs that are missing them.
 * Safe to call repeatedly — deduplicates via session Set.
 */
export async function backfillClubCards(clubs: BackfillTarget[]): Promise<void> {
  // Filter to clubs that need backfill and haven't been attempted yet
  const targets = clubs.filter(
    (c) => c.logo_url && c.club_id && c.name && !processedClubs.has(c.id)
  );

  if (targets.length === 0 || storageDisabled) return;

  // Lazy-load the generator — saves ~260 lines from initial bundle
  const { ClubCardGenerator } = await import('./ClubCardGenerator');

  // Process sequentially to avoid canvas contention
  for (const club of targets) {
    processedClubs.add(club.id);

    try {
      console.log(`[ClubCardBackfill] Generating baked card for "${club.name}" (${club.club_id})`);

      // 1. Generate composite card using canvas (returns format metadata)
      const { dataUrl, format } = await ClubCardGenerator.generateCard({
        logoUrl: club.logo_url,
        clubId: club.club_id,
        clubName: club.name.toUpperCase(),
        entityType: club.entityType || 'club',
      });

      // 2. Convert data URL to blob
      const blob = await fetch(dataUrl).then((r) => r.blob());
      const ext = format === 'webp' ? 'webp' : 'png';
      const contentType = format === 'webp' ? 'image/webp' : 'image/png';
      // v2: the v1 filenames hold whole baked cards (id plate + name + stats),
      // which ClubCardPanel double-renders. Versioning the name means those are
      // ignored rather than served from cache while the new art uploads.
      const fileName = `club-cards/${club.club_id}-card-v2.${ext}`;

      // 3. Upload to Supabase Storage
      const { error: uploadError } = await supabase.storage
        .from('club-assets')
        .upload(fileName, blob, {
          contentType,
          upsert: true,
        });

      if (uploadError) {
        const msg = uploadError.message || '';
        // If the bucket doesn't exist, disable all future backfill attempts
        if (
          msg.includes('Bucket not found') ||
          msg.includes('The resource was not found') ||
          (uploadError as any).statusCode === 400 ||
          (uploadError as any).status === 400 ||
          (uploadError as any).statusCode === 404 ||
          (uploadError as any).status === 404
        ) {
          console.warn(
            `[ClubCardBackfill] Storage bucket unavailable - disabling backfill for this session`
          );
          storageDisabled = true;
          return;
        }
        reportError(uploadError, 'ClubCardBackfill.Upload_failed_for_clubname');
        continue;
      }

      // 4. Get public URL
      const { data: urlData } = supabase.storage.from('club-assets').getPublicUrl(fileName);
      const publicUrl = urlData?.publicUrl;

      if (!publicUrl) {
        reportError(
          new Error(`[ClubCardBackfill] No public URL for ${club.name}`),
          'ClubCardBackfill.No_public_URL_for_clubname'
        );
        continue;
      }

      // 5. Update club record
      const { error: updateError } = await supabase
        .from('clubs')
        .update({ card_image_url: publicUrl })
        .eq('id', club.id);

      if (updateError) {
        reportError(updateError, 'ClubCardBackfill.DB_update_failed_for_clubname');
        continue;
      }

      // 6. Emit CLUB_UPDATED so carousel auto-refreshes with the new baked card
      masterBus.emit('CLUB_UPDATED', { clubId: club.id, action: 'card_backfill' });

      console.log(`[ClubCardBackfill] Baked card saved for "${club.name}" (${ext}) → ${publicUrl}`);
    } catch (err) {
      reportError(err, 'ClubCardBackfill.Error_processing_clubname');
    }
  }
}
