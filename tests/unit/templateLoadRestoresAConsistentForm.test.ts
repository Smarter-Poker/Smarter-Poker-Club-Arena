/**
 * TEMPLATE LOAD RESTORES A FORM THAT AGREES WITH ITSELF.
 *
 * Every pin here is a defect that shipped. `loadTemplate` was one line:
 *   setConfig({ ...DEFAULT_CONFIG, ...template.config, name: '' })
 * and the owner was left looking at a form that did not describe the table
 * they were about to create. See src/lib/tableTemplateRestore.ts for the
 * four-way breakdown.
 */
import { describe, it, expect } from 'vitest';
import {
  restoreTemplateConfig,
  templateFitsGame,
  defaultTableName,
  type RestorableTableConfig,
} from '../../src/lib/tableTemplateRestore';
import {
  BLINDS_PRESETS,
  DEFAULT_BLINDS_INDEX,
  blindsIndexFor,
  nearestBlindsIndex,
} from '../../src/config/blindsPresets';

const DEFAULTS: RestorableTableConfig = {
  name: '',
  gameMode: 'regular',
  smallBlind: 0.05,
  bigBlind: 0.1,
  maxPlayers: 9,
  tableSize: 9,
};

const restore = (over: Partial<Parameters<typeof restoreTemplateConfig>[0]> = {}) =>
  restoreTemplateConfig<RestorableTableConfig>({
    defaults: DEFAULTS,
    templateConfig: {},
    templateGameType: 'NLH',
    routeGameType: 'nlh',
    gameLabel: 'NLH',
    seatCap: 9,
    sngSeatCap: 9,
    canRunAsTournament: true,
    ...(over as object),
  } as Parameters<typeof restoreTemplateConfig>[0]);

describe('4a — the loaded form has a name the owner can save with', () => {
  it('names the table instead of clearing the field', () => {
    const r = restore({ templateConfig: { smallBlind: 1, bigBlind: 2 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The old code set name to '' and nothing regenerated it, so handleSave
    // and handleStart both bailed on !config.name.trim().
    expect(r.config.name.trim()).not.toBe('');
    expect(r.config.name).toBe('NLH 1/2');
  });

  it('names a fixed-limit table by BET size, not blind size', () => {
    const r = restore({
      templateGameType: 'FLH',
      routeGameType: 'flh',
      gameLabel: 'FLH',
      templateConfig: { smallBlind: 1, bigBlind: 2 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.name).toBe('FLH 2/4');
  });
});

describe('4b — a template knows which game it was saved for', () => {
  it('refuses a template from another variant', () => {
    const r = restore({ templateGameType: 'PLO6', routeGameType: 'flh', gameLabel: 'FLH' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('PLO6');
  });

  it('accepts a legacy template saved before game_type existed', () => {
    expect(templateFitsGame(null, 'flh')).toBe(true);
    expect(templateFitsGame('', 'flh')).toBe(true);
    expect(templateFitsGame('FLH', 'flh')).toBe(true);
    expect(templateFitsGame('plo6', 'flh')).toBe(false);
  });

  it('drops a tournament mode onto a variant that cannot be a tournament', () => {
    // buildTournamentConfig used to fall back to 'NLH' here: the owner clicked
    // Pineapple and got an NLH tournament.
    const r = restore({
      templateConfig: { gameMode: 'mtt' },
      routeGameType: 'pineapple',
      templateGameType: 'PINEAPPLE',
      gameLabel: 'PINEAPPLE',
      canRunAsTournament: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.gameMode).toBe('regular');
    expect(r.notices.join(' ')).toContain('Cash Game');
  });

  it('keeps a tournament mode the variant CAN run', () => {
    const r = restore({ templateConfig: { gameMode: 'mtt' }, canRunAsTournament: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.gameMode).toBe('mtt');
  });
});

describe('4c — the blinds slider points at the blinds', () => {
  it('returns the exact slider index for a preset pair', () => {
    const r = restore({ templateConfig: { smallBlind: 5, bigBlind: 10 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(BLINDS_PRESETS[r.blindsIndex].label).toBe('5/10');
    expect(r.blindsIndex).not.toBe(DEFAULT_BLINDS_INDEX);
  });

  it('snaps blinds that are no longer offered onto the ladder, and says so', () => {
    const r = restore({ templateConfig: { smallBlind: 3, bigBlind: 6 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const preset = BLINDS_PRESETS[r.blindsIndex];
    expect(r.config.smallBlind).toBe(preset.sb);
    expect(r.config.bigBlind).toBe(preset.bb);
    expect(r.notices.join(' ')).toContain('Snapped To');
  });

  it('never leaves the index and the blinds describing different presets', () => {
    for (const preset of BLINDS_PRESETS) {
      const r = restore({ templateConfig: { smallBlind: preset.sb, bigBlind: preset.bb } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(BLINDS_PRESETS[r.blindsIndex].sb).toBe(r.config.smallBlind);
      expect(BLINDS_PRESETS[r.blindsIndex].bb).toBe(r.config.bigBlind);
    }
  });

  it('blindsIndexFor is exact and nearestBlindsIndex prefers the cheaper tie', () => {
    expect(blindsIndexFor(0.05, 0.1)).toBe(DEFAULT_BLINDS_INDEX);
    expect(blindsIndexFor(3, 6)).toBeNull();
    expect(BLINDS_PRESETS[nearestBlindsIndex(10)].label).toBe('5/10');
    expect(BLINDS_PRESETS[nearestBlindsIndex(0.02)].label).toBe('0.01/0.02');
    expect(BLINDS_PRESETS[nearestBlindsIndex(1000)].label).toBe('50/100');
  });
});

describe('4d — the seat count shown is the seat count written', () => {
  it('clamps an over-cap template on load rather than silently at write time', () => {
    // The header printed "Table Size: 9 max" on a plo6 page while
    // clampSeatsForVariant quietly wrote 6.
    const r = restore({
      templateConfig: { maxPlayers: 9, tableSize: 9 },
      routeGameType: 'plo6',
      templateGameType: 'PLO6',
      gameLabel: 'PLO6',
      seatCap: 6,
      sngSeatCap: 6,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.maxPlayers).toBe(6);
    expect(r.config.tableSize).toBe(6);
    expect(r.notices.join(' ')).toContain('6 Players At Most');
  });

  it('leaves a within-cap template alone and says nothing', () => {
    const r = restore({ templateConfig: { maxPlayers: 6, tableSize: 6 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.maxPlayers).toBe(6);
    expect(r.notices).toHaveLength(0);
  });
});

describe('house rules for what the owner is told', () => {
  it('every notice is Title Case and carries no em dash', () => {
    const r = restore({
      templateConfig: { smallBlind: 3, bigBlind: 6, maxPlayers: 9, gameMode: 'mtt' },
      canRunAsTournament: false,
      seatCap: 6,
      sngSeatCap: 6,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notices.length).toBeGreaterThan(0);
    for (const notice of r.notices) {
      expect(notice).not.toContain('—');
      for (const word of notice.split(/\s+/)) {
        if (!/^[a-zA-Z]/.test(word)) continue;
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });

  it('defaultTableName is the single naming decision', () => {
    expect(defaultTableName('NLH', 0.05, 0.1, 'nlh')).toBe('NLH 0.05/0.10');
    expect(defaultTableName('FLO8', 0.5, 1, 'flo8')).toBe('FLO8 1/2');
  });
});
