import type { PremiumSFX } from '../services/PremiumSFX';

type PremiumSfxCue = keyof typeof PremiumSFX;

/** Load the UI synthesizer only after the first sound-producing interaction. */
export function playPremiumSfx(cue: PremiumSfxCue): void {
  void import('../services/PremiumSFX').then(({ default: sfx }) => {
    const play = sfx[cue];
    if (typeof play === 'function') play.call(sfx);
  });
}
