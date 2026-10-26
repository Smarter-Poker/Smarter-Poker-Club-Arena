import { expect, it } from 'vitest';
import { horseObserverReadContextFromRequest } from './HorseObserverReadContext.js';
import { decisionRequest } from '../testing/horseRegression/plan/fixture.js';
it.each(['mtt', 'sng', 'spin', 'hu_sng'] as const)(
  'requires known original %s context instead of a guessed transport fallback',
  (format) => {
    const r = decisionRequest();
    r.gameState.gameMode = 'tournament';
    r.gameState.format = format;
    for (const status of [undefined, 'incomplete', 'unknown', 'stale']) {
      r.gameState.tournament = { contextStatus: status } as never;
      expect(horseObserverReadContextFromRequest(r)).toBeNull();
    }
    r.gameState.tournament = { contextStatus: 'complete' } as never;
    expect(horseObserverReadContextFromRequest(r)).toMatchObject({ format });
  }
);
