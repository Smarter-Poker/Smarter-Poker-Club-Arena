import { supabase } from '../lib/supabase';
import { clubOpeningSetupService, type ClubOpeningSetupInput } from './ClubOpeningSetupService';
import {
  clubWelcomePackageService,
  type ClubWelcomePackageState,
} from './ClubWelcomePackageService';

/** No new treasury allocation: retain only funding in the authoritative package receipt. */
export function defaultClubOpeningInput(
  clubId: string,
  tagline: string | null | undefined,
  welcome: ClubWelcomePackageState | null
): ClubOpeningSetupInput {
  const economics = welcome?.status === 'provisioned' ? welcome.economics : null;
  return {
    clubId,
    tagline: tagline?.trim() || 'Good Friends. Great Poker.',
    rakePercent: -1,
    rakeCapBB: -1,
    bbjEnabled: economics?.bbjEnabled === true,
    bbjSeed: economics?.bbjSeed ?? 0,
    spinsEnabled: economics?.spinsEnabled === true,
    spinSeed: economics?.spinSeed ?? 0,
    spinMaxStake: economics?.spinMaxStake ?? 1,
    promoEnabled: false,
    promoType: 'high_hand',
    promoName: '',
    promoDescription: '',
    promoBudget: 0,
    leaderboardRewardsEnabled: false,
    leaderboardMetric: 'profit',
    leaderboardPrizeBudget: 0,
    leaderboardOverlayEnabled: false,
  };
}

/** A client can publish before its database prerequisite. Fail closed before writes. */
export async function assertDefaultClubOpeningReady() {
  const { data, error } = await supabase.rpc('fn_club_opening_defaults_ready' as never);
  if (error || data !== true) throw new Error('Default Club Setup Is Not Available Yet');
}

/** Creation already publishes the welcome leaderboard with its own retry key. */
export async function defaultClubOpeningOperationId(clubId: string, creationRequestId: string) {
  if (!clubId || !creationRequestId) throw new Error('Club Opening Request Is Required');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'club-opening-defaults:v1',
        clubId.toLowerCase(),
        creationRequestId.toLowerCase(),
      ])
    )
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read durable setup before replay; a separate stable key owns the opening. */
export async function completeDefaultClubOpening(clubId: string, creationRequestId: string) {
  const existing = await clubOpeningSetupService.getState(clubId);
  if (existing?.completed_at) return;
  await assertDefaultClubOpeningReady();
  const [welcome, applied] = await Promise.all([
    clubWelcomePackageService.get(clubId),
    clubOpeningSetupService.getAppliedState(clubId),
  ]);
  if (!applied) throw new Error('Club Defaults Could Not Be Read');
  if (welcome.status === 'ready' || welcome.status === 'not_configured')
    throw new Error('Starter Games Have Not Been Confirmed');
  return clubOpeningSetupService.complete(
    defaultClubOpeningInput(clubId, applied.tagline, welcome),
    await defaultClubOpeningOperationId(clubId, creationRequestId)
  );
}
