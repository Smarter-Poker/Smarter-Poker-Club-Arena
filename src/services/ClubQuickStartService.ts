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

/** Read durable setup before a replay; the creation request owns the same setup key. */
export async function completeDefaultClubOpening(clubId: string, operationId: string) {
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
    operationId
  );
}
