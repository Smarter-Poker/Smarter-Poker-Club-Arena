import { manualTournamentBlindPreset } from '../config/blindStructures';
import {
  MTT_CREATION_PROFILES,
  mttCreationProfileValues,
  type MttCreationProfileId,
} from '../../server/src/tournament/mttCreationProfiles';

export function manualMttCreationProfile(id: MttCreationProfileId) {
  const profile = MTT_CREATION_PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error('Unknown MTT Structure Preset');
  const opening = manualTournamentBlindPreset(profile.blindRamp).find((row) => !row.isBreak);
  return mttCreationProfileValues(id, opening?.bigBlind ?? NaN);
}

export type ManualMttProfileValues = ReturnType<typeof manualMttCreationProfile>;

/** Custom/restored rules stay custom unless all three effective inputs match. */
export function selectedManualMttProfile(values: {
  blindStructure: string;
  blindsUpMinutes: number;
  startingChips: number;
}): MttCreationProfileId | 'custom' {
  return (
    MTT_CREATION_PROFILES.find(({ id }) => {
      const proposed = manualMttCreationProfile(id);
      return (
        proposed.blindStructure === values.blindStructure &&
        proposed.blindsUpMinutes === values.blindsUpMinutes &&
        proposed.startingChips === values.startingChips
      );
    })?.id ?? 'custom'
  );
}
