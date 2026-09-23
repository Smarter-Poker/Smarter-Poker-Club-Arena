/**
 * ENTRY RULES AND PRIZE STYLE ARE INDEPENDENT (owner requirement, 2026-09-20).
 *
 * The create-table MTT form had one rebuy count that switched rebuys AND
 * re-entries on together, and one KO Bounty boolean. They are two axes: how a
 * player may come back after busting, and how the prize money is shaped. This
 * pins the whole 3 x 4 matrix through the real mapper and the real serializer,
 * and pins that moving along one axis never moves the other.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTournamentConfig,
  entryRulesForDraft,
  prizeStyleForDraft,
  MTT_ENTRY_RULES,
  MTT_PRIZE_STYLES,
  type MttEntryRules,
  type MttPrizeStyle,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { tournamentService } from '../../src/services/TournamentService';

const base: TournamentFormInput = {
  name: 'Matrix Event',
  gameMode: 'mtt',
  buyIn: 100,
  startingChips: 10000,
  blindStructure: 'standard',
  blindsUpMinutes: 8,
  payoutStructure: 'payout3',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 10,
  lateRegistrationLevel: 6,
  numberOfRebuysReentries: 3,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

const EXPECTED_TYPE: Record<MttPrizeStyle, string> = {
  regular: 'mtt',
  bounty: 'bounty',
  progressive_bounty: 'progressive_bounty',
  mystery_bounty: 'mystery_bounty',
};
const EXPECTED_BOUNTY_TYPE: Record<MttPrizeStyle, string | undefined> = {
  regular: undefined,
  bounty: 'fixed',
  progressive_bounty: 'progressive',
  mystery_bounty: 'mystery',
};

const matrix = MTT_ENTRY_RULES.flatMap((rule) =>
  MTT_PRIZE_STYLES.map((style) => [rule.value, style.value] as [MttEntryRules, MttPrizeStyle])
);

describe('the 3 x 4 matrix', () => {
  it('is the full matrix', () => {
    expect(matrix).toHaveLength(12);
  });

  it.each(matrix)('%s + %s maps each axis on its own', (entryRules, prizeStyle) => {
    const c = buildTournamentConfig({ ...base, entryRules, prizeStyle }, 'nlh');

    expect(c.type).toBe(EXPECTED_TYPE[prizeStyle]);
    expect(c.bountyConfig?.bountyType).toBe(EXPECTED_BOUNTY_TYPE[prizeStyle]);
    expect(c.isRebuy).toBe(entryRules === 'rebuy');
    expect(c.isReentry).toBe(entryRules === 'reentry');
    expect(c.maxRebuys).toBe(entryRules === 'rebuy' ? 3 : undefined);
    expect(c.maxReentries).toBe(entryRules === 'reentry' ? 3 : undefined);

    if (prizeStyle === 'regular') {
      expect(c.bountyConfig).toBeUndefined();
    } else {
      // A whole number, and something is left for the prize pool after the fee.
      const bounty = c.bountyConfig!.baseBounty;
      expect(Number.isInteger(bounty)).toBe(true);
      expect(bounty).toBeGreaterThan(0);
      expect(c.buyIn - c.rake - bounty).toBeGreaterThan(0);
    }

    // The real serializer accepts every cell and carries the same keys on.
    const payload = tournamentService.buildRpcConfig(c);
    expect(payload.type).toBe(EXPECTED_TYPE[prizeStyle]);
    expect(payload.isRebuy).toBe(entryRules === 'rebuy');
    expect(payload.isReentry).toBe(entryRules === 'reentry');
    expect(payload.maxPlayers).toBeNull();
    if (prizeStyle === 'mystery_bounty') {
      expect(payload.mysteryBountyProfile).toBe('classic');
      expect(payload.mysteryBountyActivation).toBe('at_the_money');
    }
  });

  it.each(MTT_PRIZE_STYLES.map((s) => s.value))(
    'changing Entry Rules never changes the %s prize axis',
    (prizeStyle) => {
      const seen = MTT_ENTRY_RULES.map((rule) => {
        const c = buildTournamentConfig({ ...base, prizeStyle, entryRules: rule.value }, 'nlh');
        return JSON.stringify([c.type, c.bountyConfig ?? null]);
      });
      expect(new Set(seen).size).toBe(1);
    }
  );

  it.each(MTT_ENTRY_RULES.map((r) => r.value))(
    'changing Prize Style never changes the %s lifecycle axis',
    (entryRules) => {
      const seen = MTT_PRIZE_STYLES.map((style) => {
        const c = buildTournamentConfig({ ...base, entryRules, prizeStyle: style.value }, 'nlh');
        return JSON.stringify([
          c.isRebuy,
          c.isReentry,
          c.maxRebuys ?? null,
          c.maxReentries ?? null,
        ]);
      });
      expect(new Set(seen).size).toBe(1);
    }
  );
});

describe('edges of each axis', () => {
  it('a chosen Rebuy or Re-Entry event allows at least one', () => {
    const rebuy = buildTournamentConfig(
      { ...base, entryRules: 'rebuy', numberOfRebuysReentries: 0 },
      'nlh'
    );
    expect(rebuy.isRebuy).toBe(true);
    expect(rebuy.maxRebuys).toBe(1);
    const reentry = buildTournamentConfig(
      { ...base, entryRules: 'reentry', numberOfRebuysReentries: 0 },
      'nlh'
    );
    expect(reentry.maxReentries).toBe(1);
  });

  it('a Freezeout ignores a rebuy count left on the slider', () => {
    const c = buildTournamentConfig(
      { ...base, entryRules: 'freezeout', numberOfRebuysReentries: 5 },
      'nlh'
    );
    expect(c.isRebuy).toBe(false);
    expect(c.isReentry).toBe(false);
    expect(c.maxRebuys).toBeUndefined();
    expect(c.maxReentries).toBeUndefined();
  });

  it('a draft saved before the controls existed maps exactly as it used to', () => {
    const legacy = buildTournamentConfig({ ...base, koBounty: true }, 'nlh');
    expect(legacy.isRebuy).toBe(true);
    expect(legacy.isReentry).toBe(true);
    expect(legacy.maxRebuys).toBe(3);
    expect(legacy.maxReentries).toBe(3);
    expect(legacy.type).toBe('bounty');
    expect(legacy.bountyConfig?.bountyType).toBe('fixed');
  });

  it('an explicit Prize Style outranks a stale KO Bounty switch', () => {
    const c = buildTournamentConfig({ ...base, koBounty: true, prizeStyle: 'regular' }, 'nlh');
    expect(c.type).toBe('mtt');
    expect(c.bountyConfig).toBeUndefined();
  });

  it('a satellite and a Free Buy run as Regular, and the serializer accepts both', () => {
    const satellite = buildTournamentConfig(
      {
        ...base,
        prizeStyle: 'mystery_bounty',
        nextStepSatellite: true,
        satelliteTargetId: 'd3000000-0000-4000-8000-000000000001',
      },
      'nlh'
    );
    expect(satellite.type).toBe('satellite');
    expect(satellite.bountyConfig).toBeUndefined();
    expect(() => tournamentService.buildRpcConfig(satellite)).not.toThrow();

    const freeBuy = buildTournamentConfig(
      { ...base, buyIn: 0, prizeStyle: 'bounty', entryRules: 'freezeout' },
      'nlh'
    );
    expect(freeBuy.type).toBe('mtt');
    expect(freeBuy.bountyConfig).toBeUndefined();
    // The Free Buy rule still switches both flags on, whatever Entry Rules held.
    expect(freeBuy.isRebuy).toBe(true);
    expect(freeBuy.isReentry).toBe(true);
    expect(freeBuy.maxRebuys).toBe(3);
  });

  it('a Sit And Go has no prize axis and no lifecycle axis', () => {
    const c = buildTournamentConfig(
      { ...base, gameMode: 'sng', entryRules: 'rebuy', prizeStyle: 'bounty' },
      'nlh'
    );
    expect(c.type).toBe('sng');
    expect(c.bountyConfig).toBeUndefined();
    expect(c.isRebuy).toBe(false);
    expect(c.isReentry).toBe(false);
  });
});

describe('what the controls show for an older template', () => {
  it('reads Entry Rules from the saved rebuy count', () => {
    expect(entryRulesForDraft({ numberOfRebuysReentries: 3 })).toBe('rebuy');
    expect(entryRulesForDraft({ numberOfRebuysReentries: 0 })).toBe('freezeout');
    expect(entryRulesForDraft({ entryRules: 'reentry', numberOfRebuysReentries: 0 })).toBe(
      'reentry'
    );
    expect(entryRulesForDraft({ entryRules: 'nonsense', numberOfRebuysReentries: 2 })).toBe(
      'rebuy'
    );
  });

  it('reads Prize Style from the saved KO Bounty switch', () => {
    expect(prizeStyleForDraft({ koBounty: true })).toBe('bounty');
    expect(prizeStyleForDraft({ koBounty: false })).toBe('regular');
    expect(prizeStyleForDraft({ prizeStyle: 'mystery_bounty', koBounty: false })).toBe(
      'mystery_bounty'
    );
  });
});
