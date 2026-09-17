/** Suggested new-draft structures, not universal industry requirements.
 * The operating clock and opening depth are separate, explicit choices.
 * Never apply these to an existing event or infer them from an event name. */
export const MTT_CREATION_PROFILES = [
  { id: 'regular', label: 'Regular', blindRamp: 'standard', minutes: 10, depthBB: 150 },
  { id: 'deep', label: 'Deep Stack', blindRamp: 'slow', minutes: 15, depthBB: 300 },
  { id: 'turbo', label: 'Turbo', blindRamp: 'turbo', minutes: 5, depthBB: 100 },
  { id: 'hyper', label: 'Hyper Turbo', blindRamp: 'hyper_turbo', minutes: 2, depthBB: 50 },
] as const;

export type MttCreationProfileId = (typeof MTT_CREATION_PROFILES)[number]['id'];

/** Bind the suggested depth to the actual ramp's opening big blind. */
export function mttCreationProfileValues(id: MttCreationProfileId, openingBigBlind: number) {
  const profile = MTT_CREATION_PROFILES.find((entry) => entry.id === id);
  if (!profile) throw new Error('Unknown MTT Structure Preset');
  const startingChips = openingBigBlind * profile.depthBB;
  if (
    !Number.isSafeInteger(openingBigBlind) ||
    openingBigBlind <= 0 ||
    !Number.isSafeInteger(startingChips)
  ) {
    throw new Error('MTT Structure Preset Needs A Positive Whole Opening Big Blind');
  }
  return {
    blindStructure: profile.blindRamp,
    blindsUpMinutes: profile.minutes,
    startingChips,
  };
}
