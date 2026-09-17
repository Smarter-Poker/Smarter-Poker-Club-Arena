/**
 * FREEROLLS ARE FREE BUY (Dan 2026-09-02) - behaviour tests for the three
 * client/engine paths that build a freeroll. The law test
 * (tests/law/FreerollsAreFreeBuy.law.test.ts) pins the text; this one runs
 * the code.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    getAuthUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: { emit: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));
vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: vi.fn().mockResolvedValue('resolved-uuid'),
}));
vi.mock('../../src/services/WalletService', () => ({
  WalletService: { logTransaction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../server/src/services/supabase.js', () => {
  const buildChain = (): any => {
    const handler: ProxyHandler<any> = {
      get: (_target, prop) => {
        if (prop === 'maybeSingle' || prop === 'single')
          return () => Promise.resolve({ data: null, error: null });
        if (prop === 'then')
          return (resolve: (v: any) => void) => resolve({ data: null, error: null });
        return vi.fn().mockReturnValue(new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  };
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      channel: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(undefined),
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn(),
      }),
    },
  };
});

import {
  buildTournamentConfig,
  type TournamentFormInput,
} from '../../src/lib/tournamentFromTableConfig';
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
import { ScheduledTournamentService } from '../../server/src/services/ScheduledTournamentService';
import { formatBuyIn, formatBuyInShort } from '../../src/utils/buyIn';
import { tournamentMedallions } from '../../src/components/lobby/lobbyEntries';

const form: TournamentFormInput = {
  name: 'Sunday Freeroll',
  gameMode: 'mtt',
  buyIn: 0,
  startingChips: 5000,
  blindStructure: 'standard',
  blindsUpMinutes: 8,
  payoutStructure: 'payout1',
  sngPlayerCount: 9,
  isSpins: false,
  minPlayers: 4,
  maxPlayersRange: 200,
  lateRegistrationLevel: 4,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  koBounty: false,
  startTime: '',
};

describe('tournamentFromTableConfig: a 0 buy-in MTT is Free Buy whatever the sliders say', () => {
  it('rebuys and add-ons come out ON at 1 chip each with the sliders at zero', () => {
    const c = buildTournamentConfig(form, 'nlh');
    expect(c.buyIn).toBe(0);
    expect(c.rake).toBe(0);
    expect(c.isRebuy).toBe(true);
    expect(c.isReentry).toBe(true);
    expect(c.rebuyCost).toBe(1);
    expect(c.addOnAvailable).toBe(true);
    expect(c.addOnCost).toBe(1);
    expect(c.rebuyChips).toBe(5000);
    expect(c.addOnChips).toBe(5000);
    expect(c.addOnLevels).toBe(1);
    expect(c.rebuyLevels).toBe(4);
    // No cap: 0 rebuys on the slider must not become max_rebuys = 0.
    expect(c.maxRebuys).toBeUndefined();
  });

  it('a custom rebuy price on a freeroll is overridden to 1 chip', () => {
    const c = buildTournamentConfig(
      {
        ...form,
        numberOfRebuysReentries: 2,
        customRebuyReentryCost: true,
        rebuyReentryCost: 5,
        addOnMultiplier: 2,
        customAddOn: true,
        customAddOnCost: 7,
      },
      'nlh'
    );
    expect(c.rebuyCost).toBe(1);
    expect(c.addOnCost).toBe(1);
    expect(c.addOnChips).toBe(10000);
    expect(c.maxRebuys).toBe(2);
  });

  it('a paid MTT is untouched', () => {
    const c = buildTournamentConfig({ ...form, buyIn: 50 }, 'nlh');
    expect(c.isRebuy).toBe(false);
    expect(c.addOnAvailable).toBe(false);
    expect(c.rebuyCost).toBe(50);
  });

  it('a 0 buy-in SNG is not a freeroll', () => {
    const c = buildTournamentConfig({ ...form, gameMode: 'sng', sngPlayerCount: 6 }, 'nlh');
    expect(c.isRebuy).toBe(false);
    expect(c.addOnAvailable).toBe(false);
  });
});

describe('TournamentService.buildRpcConfig: the RPC payload carries the rule', () => {
  const base: TournamentConfig = {
    name: 'Freeroll',
    type: 'mtt',
    buyIn: 0,
    rake: 0,
    startingStack: 3000,
    maxPlayers: 100,
    minPlayers: 4,
    blindStructure: [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
    payoutStructure: [],
    lateRegistrationLevels: 4,
    isRebuy: false,
    addOnAvailable: false,
    guaranteedPrize: 100,
  } as unknown as TournamentConfig;

  it('forces rebuys and add-ons on at 1 chip for a freeroll', () => {
    const p = tournamentService.buildRpcConfig(base);
    expect(p.isRebuy).toBe(true);
    expect(p.isReentry).toBe(true);
    expect(p.rebuyCost).toBe(1);
    expect(p.addOnAvailable).toBe(true);
    expect(p.addOnCost).toBe(1);
    expect(p.rebuyChips).toBe(3000);
    expect(p.addOnChips).toBe(3000);
    expect(p.addOnLevels).toBe(1);
    expect(p).not.toHaveProperty('maxRebuys');
  });

  it('drops a 0 rebuy cap on a freeroll but keeps a real one', () => {
    expect(tournamentService.buildRpcConfig({ ...base, maxRebuys: 0 })).not.toHaveProperty(
      'maxRebuys'
    );
    expect(tournamentService.buildRpcConfig({ ...base, maxRebuys: 3 }).maxRebuys).toBe(3);
  });

  it('leaves a paid event alone', () => {
    const p = tournamentService.buildRpcConfig({ ...base, buyIn: 20, rake: 2, maxRebuys: 0 });
    expect(p.isRebuy).toBe(false);
    expect(p.addOnAvailable).toBe(false);
    expect(p.rebuyCost).toBe(0);
    expect(p.maxRebuys).toBe(0);
  });
});

describe('ScheduledTournamentService.buildInsertRow: the DSS freeroll schedules', () => {
  const schedule = {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff',
    union_id: null,
    club_id: 'club-1',
    name: 'DSS Sunday $100 Freeroll',
    active: true,
    days_of_week: [0],
    start_times_utc: ['15:00'],
    interval_minutes: null,
    config: {},
  };
  const start = new Date(Date.UTC(2026, 0, 4, 15, 0, 0));
  const build = (cfg: Record<string, unknown>) =>
    (new ScheduledTournamentService() as any).buildInsertRow(schedule, cfg, start) as Promise<
      Record<string, unknown>
    >;

  it('a schedule that spells addonCost the DB way gets a 1-chip add-on, not a free one', async () => {
    const row = await build({
      name: 'DSS Sunday $100 Freeroll',
      type: 'mtt',
      buyIn: 0,
      isRebuy: true,
      addOnAvailable: true,
      rebuyCost: 1,
      addonCost: 1,
      rebuyChips: 5000,
      addonChips: 10000,
      startingStack: 5000,
      maxPlayers: 200,
      minPlayers: 4,
      blindPreset: 'STANDARD',
      payoutPreset: 'NINE',
      guaranteedPrize: 100,
      lateRegistrationLevels: 4,
    });
    expect(row.buy_in_amount).toBe(0);
    expect(row.buy_in_fee).toBe(0);
    expect(row.is_rebuy).toBe(true);
    expect(row.add_on_available).toBe(true);
    expect(row.rebuy_cost).toBe(1);
    expect(row.addon_cost).toBe(1);
    expect(row.rebuy_chips).toBe(5000);
    expect(row.addon_chips).toBe(10000);
    expect(row.max_rebuys).toBeNull();
  });

  it('a freeroll schedule with no rebuy keys at all still spawns Free Buy', async () => {
    const row = await build({
      name: 'DSS Sunday $100 Turbo Freeroll',
      type: 'mtt',
      buyIn: 0,
      startingStack: 12000,
      maxPlayers: 200,
      minPlayers: 4,
      blindPreset: 'TURBO',
      payoutPreset: 'NINE',
      guaranteedPrize: 100,
      lateRegistrationLevels: 4,
    });
    expect(row.is_rebuy).toBe(true);
    expect(row.is_reentry).toBe(true);
    expect(row.add_on_available).toBe(true);
    expect(row.rebuy_cost).toBe(1);
    expect(row.addon_cost).toBe(1);
    expect(row.rebuy_chips).toBe(12000);
    expect(row.addon_chips).toBe(12000);
    expect(row.rebuy_levels).toBe(4);
    expect(row.addon_levels).toBe(1);
    expect(row.max_rebuys).toBeNull();
  });

  it('a paid schedule keeps its own rebuy settings', async () => {
    const row = await build({
      name: 'Sunday Major',
      type: 'mtt',
      buyIn: 50,
      isRebuy: true,
      addOnAvailable: true,
      startingStack: 10000,
      maxPlayers: 200,
      minPlayers: 4,
      blindPreset: 'STANDARD',
      payoutPreset: 'NINE',
      maxRebuys: 0,
    });
    expect(row.buy_in_amount).toBe(45);
    expect(row.rebuy_cost).toBe(50);
    expect(row.addon_cost).toBe(50);
    expect(row.max_rebuys).toBe(0);
  });
});

describe('the lobby says Free Buy', () => {
  it('buy-in cells', () => {
    expect(formatBuyIn(0, 0)).toBe('Free Buy');
    expect(formatBuyInShort(0, null)).toBe('Free Buy');
    expect(formatBuyIn(9, 1)).not.toBe('Free Buy');
  });

  it('the freeroll medallion', () => {
    const rules = tournamentMedallions({
      name: 'DSS Sunday $100 Freeroll',
      buy_in_amount: 0,
      buy_in_fee: 0,
    } as any);
    const freeroll = rules.find((r) => r.key === 'freeroll');
    expect(freeroll?.label).toBe('Free Buy');
    expect(freeroll?.tip).toBe('Freerolls Are Free To Enter. Rebuys And Add-Ons Cost 1 Chip.');
  });
});
