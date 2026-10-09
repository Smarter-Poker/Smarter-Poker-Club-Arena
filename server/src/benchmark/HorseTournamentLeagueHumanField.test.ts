import { describe, expect, it } from 'vitest';
import { runTournamentLeague } from './HorseTournamentLeague.js';
import { HUMAN_CALIBRATED_POPULATION_ID } from './HumanCalibratedPopulation.js';

// Condition (b) monitoring for tournament packs (winning contract, Amendment
// Of October 9, 2026): the Phase 8 league can seat a human-calibrated field.
describe('the tournament league can seat a human-calibrated field', () => {
  it('plays every non-hero entrant from the human-calibrated profile and tallies its responses', async () => {
    const human = await runTournamentLeague({
      objective: 'spin',
      pairs: 2,
      seed: 18_900_101,
      opponentPopulation: HUMAN_CALIBRATED_POPULATION_ID,
    });
    expect(human.opponentPopulation).toBe(HUMAN_CALIBRATED_POPULATION_ID);
    expect(human.complete).toBe(true);
    expect(human.illegalActions).toBe(0);
    expect(human.conservationErrors).toBe(0);
    const responses = Object.values(human.humanResponses ?? {}).flatMap((n) => Object.values(n));
    expect(responses.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('leaves the Phase 8 field unchanged when no population is named', async () => {
    const horses = await runTournamentLeague({ objective: 'spin', pairs: 1, seed: 18_900_101 });
    expect('opponentPopulation' in horses).toBe(false);
    expect('humanResponses' in horses).toBe(false);
  });
});
