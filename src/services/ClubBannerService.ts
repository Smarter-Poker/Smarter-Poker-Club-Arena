import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

export const CLUB_BANNER_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function validateClubBanner(file: File): string {
  const extension = IMAGE_EXTENSIONS[file.type];
  if (!extension) throw new Error('Choose A JPEG, PNG, Or WebP Image');
  if (file.size === 0 || file.size > CLUB_BANNER_MAX_BYTES)
    throw new Error('Choose An Image Up To 2 MB');
  return extension;
}

export interface ClubBannerRecord {
  id: string;
  name: string;
  owner_id: string;
  banner_url: string | null;
  settings?: Record<string, unknown> | null;
}

export async function readClubBanner(clubId: string): Promise<ClubBannerRecord> {
  const { data, error } = await supabase
    .from('clubs')
    .select('id, name, owner_id, banner_url, settings')
    .eq('id', clubId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Club Not Found');
  return data as ClubBannerRecord;
}

/** Upload once; retaining the returned URL lets a failed save be retried without another upload. */
export async function uploadClubBannerImage(clubId: string, file: File): Promise<string> {
  const extension = validateClubBanner(file);
  // This is the existing permitted club presentation-image namespace. Immutable
  // names prevent replacing an image already served by another tab or club.
  const path = `club-cards/${clubId}-banner-${crypto.randomUUID()}.${extension}`;
  const { data, error } = await supabase.storage.from('club-assets').upload(path, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from('club-assets').getPublicUrl(data.path).data.publicUrl;
}

// Presentation saves refresh the lobby without restarting membership guards.
// CLUB_UPDATED is also an access-change signal and can unmount an in-flight editor.
export async function saveClubBanner(
  clubId: string,
  ownerId: string,
  expectedUrl: string | null,
  nextUrl: string | null
): Promise<ClubBannerRecord> {
  let query = supabase
    .from('clubs')
    .update({ banner_url: nextUrl })
    .eq('id', clubId)
    .eq('owner_id', ownerId);
  query = expectedUrl === null ? query.is('banner_url', null) : query.eq('banner_url', expectedUrl);
  const { data, error } = await query
    .select('id, name, owner_id, banner_url, settings')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    // A lost response may have committed this exact image already. Read the
    // durable outcome before offering another write; a different image is a conflict.
    const current = await readClubBanner(clubId);
    if (current.owner_id !== ownerId || current.banner_url !== nextUrl)
      throw new Error('Banner Changed Or Access Was Removed. Reload Before Saving.');
    masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
    return current;
  }
  masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
  return data as ClubBannerRecord;
}
