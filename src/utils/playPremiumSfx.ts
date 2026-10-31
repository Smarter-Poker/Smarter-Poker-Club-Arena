import type { PremiumSFX } from '../services/PremiumSFX';
import { reportError } from './errorReporter';
import { importWithRetry } from './lazyWithRetry';

type PremiumSfxCue = keyof typeof PremiumSFX;

/** Load the UI synthesizer only after the first sound-producing interaction. */
export function playPremiumSfx(cue: PremiumSfxCue): void {
  // Retry only loading: putting playback inside the retry would duplicate a
  // cue that started before throwing. Do not retain a rejected load promise.
  void importWithRetry(() => import('../services/PremiumSFX'))
    .then(({ default: sfx }) => {
      const play = sfx[cue];
      if (typeof play === 'function') play.call(sfx);
    })
    .catch((error) => reportError(error, 'PremiumSFX.load'));
}
