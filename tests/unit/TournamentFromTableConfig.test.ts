/**
 * THE SNG / MTT TABS MUST PRODUCE A TOURNAMENT (2026-08-19).
 *
 * Those tabs used to insert a row into `tables` exactly like the Regular tab,
 * producing an ordinary cash game with the configured blinds. Every tournament
 * control on them — buy-in, blind structure, payouts, starting chips, late
 * registration, rebuys, add-ons, bounty — wrote a `tables` column that nothing
 * in server/src reads, and the page reported "Table created and started!".
 *
 * This file pins the mapping into a real TournamentConfig. The assertions are
 * chosen around the things the tournament engine will refuse or mis-run:
 *
 *   - max_players must be POSITIVE. fn_register_for_tournament refuses entry
 *     when current_players >= max_players, so 0 means nobody can ever register.
 *   - an SNG only starts when FULL, so min must equal max or it sits in
 *     REGISTERING until the stale-SNG sweeper cancels and refunds it.
 *   - payouts must total 100 and must pay fewer places than the field size.
 *   - blinds must never decrease across playing levels.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTournamentConfig,
  canRunAsTournament,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';

const base: TournamentFormInput = {
  name: 'Friday Major',
  gameMode: 'mtt',
  buyIn: 50,
  startingChips: 10000,
  blindStructure: 'standard',
  blindsUpMinutes: 8,
  payoutStructure: 'payout1',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 10,
  maxPlayersRange: 100,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

describe('field size', () => {
  it('an MTT uses the configured range', () => {
    const c = buildTournamentConfig(base, 'nlh');
    expect(c.maxPlayers).toBe(100);
    expect(c.minPlayers).toBe(10);
  });

  it('an SNG has min equal to max, or it can never start', () => {
    const c = buildTournamentConfig({ ...base, gameMode: 'sng', sngPlayerCount: 18 }, 'nlh');
    expect(c.maxPlayers).toBe(18);
    expect(c.minPlayers).toBe(18);
  });

  it('never produces a zero or negative field', () => {
    const c = buildTournamentConfig({ ...base, maxPlayersRange: 0, minPlayers: 0 }, 'nlh');
    expect(c.maxPlayers).toBeGreaterThan(0);
    expect(c.minPlayers).toBeGreaterThanOrEqual(2);
  });
});

describe('payouts', () => {
  it('always total 100', () => {
    for (const field of [9, 18, 27, 100, 300]) {
      const c = buildTournamentConfig({ ...base, maxPlayersRange: field }, 'nlh');
      const total = c.payoutStructure.reduce((s, p) => s + p.percentage, 0);
      expect(Math.abs(total - 100)).toBeLessThanOrEqual(0.01);
    }
  });

  it('pay fewer places than the field, so the bubble can exist', () => {
    for (const field of [9, 18, 27, 100, 300]) {
      const c = buildTournamentConfig({ ...base, maxPlayersRange: field }, 'nlh');
      expect(c.payoutStructure.length).toBeLessThan(c.maxPlayers);
    }
  });

  it('winner-take-all is exactly one place at 100%', () => {
    const c = buildTournamentConfig({ ...base, payoutStructure: 'winner_take_all' }, 'nlh');
    expect(c.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
  });

  it('always includes place 1 — without it the winner takes the whole pool', () => {
    const c = buildTournamentConfig(base, 'nlh');
    expect(c.payoutStructure.some((p) => p.place === 1)).toBe(true);
  });
});

describe('blind structure', () => {
  it('applies the level length to playing levels and leaves breaks alone', () => {
    const c = buildTournamentConfig({ ...base, blindsUpMinutes: 12 }, 'nlh');
    const playing = c.blindStructure.filter((l) => !l.isBreak);
    expect(playing.length).toBeGreaterThan(0);
    for (const lvl of playing) expect(lvl.durationMinutes).toBe(12);
  });

  it('never lets blinds decrease — the service rejects that', () => {
    const c = buildTournamentConfig(base, 'nlh');
    const playing = c.blindStructure.filter((l) => !l.isBreak);
    for (let i = 1; i < playing.length; i++) {
      expect(playing[i].bigBlind).toBeGreaterThanOrEqual(playing[i - 1].bigBlind);
    }
  });

  it('every level has a positive duration', () => {
    const c = buildTournamentConfig({ ...base, blindsUpMinutes: 0 }, 'nlh');
    for (const lvl of c.blindStructure) expect(lvl.durationMinutes).toBeGreaterThan(0);
  });

  it('a spin uses the spin ramp and is winner-take-all', () => {
    const c = buildTournamentConfig(
      { ...base, gameMode: 'sng', isSpins: true, sngPlayerCount: 3 },
      'nlh'
    );
    expect(c.type).toBe('spin');
    expect(c.maxPlayers).toBe(3);
    expect(c.payoutStructure).toEqual([{ place: 1, percentage: 100 }]);
  });
});

describe('money', () => {
  it('the fee shown is 10% of the buy-in', () => {
    expect(buildTournamentConfig({ ...base, buyIn: 50 }, 'nlh').rake).toBe(5);
    expect(buildTournamentConfig({ ...base, buyIn: 33 }, 'nlh').rake).toBe(3.3);
  });

  it('a bounty tournament leaves something for the prize pool', () => {
    const c = buildTournamentConfig({ ...base, koBounty: true, buyIn: 50 }, 'nlh');
    expect(c.type).toBe('bounty');
    const bounty = c.bountyConfig!.baseBounty;
    expect(bounty).toBeGreaterThan(0);
    // buy-in minus the 10% fee minus the bounty must stay positive, or
    // fn_tournament_entry_split refuses every registration.
    expect(c.buyIn - c.rake - bounty).toBeGreaterThan(0);
  });
});

describe('start time', () => {
  it('is passed through for an MTT when it is in the future', () => {
    const future = new Date(Date.now() + 3_600_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    const c = buildTournamentConfig({ ...base, startTime: local }, 'nlh');
    expect(c.startTime).toBeInstanceOf(Date);
  });

  it('is dropped when it is in the past — that trips the auto-cancel', () => {
    const c = buildTournamentConfig({ ...base, startTime: '2020-01-01T12:00' }, 'nlh');
    expect(c.startTime).toBeUndefined();
  });

  it('is ignored for an SNG, which starts when it fills', () => {
    const c = buildTournamentConfig(
      { ...base, gameMode: 'sng', startTime: '2999-01-01T12:00' },
      'nlh'
    );
    expect(c.startTime).toBeUndefined();
  });
});

describe('game variant', () => {
  it('only offers tournaments for variants the engine can deal', () => {
    expect(canRunAsTournament('nlh')).toBe(true);
    expect(canRunAsTournament('plo')).toBe(true);
    expect(canRunAsTournament('shortdeck')).toBe(true);
    // HandController maps an unknown variant to 2 cards and a full deck, so
    // these would silently run Hold'em.
    for (const v of ['flh', 'flo', 'mixed', 'ofc']) expect(canRunAsTournament(v)).toBe(false);
  });

  it('maps to the engine vocabulary', () => {
    expect(buildTournamentConfig(base, 'plo').gameVariant).toBe('PLO4');
    expect(buildTournamentConfig(base, 'shortdeck').gameVariant).toBe('SHORT_DECK');
    expect(buildTournamentConfig(base, undefined).gameVariant).toBe('NLH');
  });
});
