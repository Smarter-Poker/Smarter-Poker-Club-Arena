import { describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  asset: 'diamonds' as string | undefined,
  tableSelect: '',
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const rawHand = {
        id: 'hand-1',
        table_id: 'table-1',
        hand_number: 1000001,
        game_variant: 'nlh',
        small_blind: 1,
        big_blind: 2,
        pot_size: 10,
        created_at: '2026-09-10T00:00:00Z',
        players: [],
        actions: [],
        winners: [],
      };
      const data =
        table === 'tables'
          ? [
              {
                id: 'table-1',
                name: 'Diamond NLH',
                max_players: 6,
                arena: { asset: fixture.asset },
              },
            ]
          : [];
      const chain: any = {
        select: (selection: string) => {
          if (table === 'tables') fixture.tableSelect = selection;
          return chain;
        },
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: table === 'hand_history' ? rawHand : null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data, error: null }),
      };
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  },
}));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => null }));
import { handHistoryService } from '../../src/services/HandHistoryService';
import { adaptServiceHandToPanel } from '../../src/lib/handHistoryAdapter';

describe('canonical hand history denomination', () => {
  it('carries authoritative Diamond metadata through the real service and panel adapter', async () => {
    fixture.asset = 'diamonds';
    const hand = await handHistoryService.getHand('hand-1');
    expect(fixture.tableSelect).toContain('arena:clubs!fk_tables_club_id(asset)');
    expect(hand?.arenaAsset).toBe('diamonds');
    expect(adaptServiceHandToPanel(hand!, 'hero').arenaAsset).toBe('diamonds');
  });
  it('does not infer an asset from a Diamond-looking table name', async () => {
    fixture.asset = undefined;
    const hand = await handHistoryService.getHand('hand-1');
    expect(hand?.table_name).toBe('Diamond NLH');
    expect(hand?.arenaAsset).toBeUndefined();
  });
});
