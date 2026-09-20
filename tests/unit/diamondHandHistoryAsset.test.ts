import { describe, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  asset: 'diamonds' as string | undefined,
  tableSelect: '',
  /** The selection and the `.eq()` filters the hand_history query was built with. */
  handSelect: '',
  filters: [] as Array<[string, unknown]>,
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
          if (table === 'hand_history') fixture.handSelect = selection;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          if (table === 'hand_history') fixture.filters.push([column, value]);
          return chain;
        },
        in: () => chain,
        contains: () => chain,
        order: () => chain,
        range: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: table === 'hand_history' ? rawHand : null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data, error: null }),
      };
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  },
}));
vi.mock('../../src/lib/authUtils', () => ({ readLocalSession: () => null }));
import {
  handHistoryService,
  HAND_HISTORY_ARENA_EMBED,
  HAND_HISTORY_ARENA_FILTER_COLUMN,
  HAND_HISTORY_COLUMNS,
} from '../../src/services/HandHistoryService';
import { adaptServiceHandToPanel } from '../../src/lib/handHistoryAdapter';
import { DIAMOND_ARENA_CLUB_ID } from '../../src/lib/constants';

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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DIAMOND PLAYER'S RECORD IS THE ARENA'S RECORD (2026-09-20)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The tests above hold the LABEL: a hand carries the asset of the club its
 * table belonged to, and never infers one from a table name. They say nothing
 * about which hands are fetched, because until now there was no way to ask.
 *
 * `getPlayerHands` had no club or asset filter at all, so the Diamond footer's
 * Hand History door could only ever open the cross-club archive: a Diamond
 * player's own record with every chip hand they have ever played mixed into it,
 * and the page's per-asset totals computed over both.
 *
 * The scope is the SERVER'S, and that is the part worth pinning. `hand_history`
 * has no club column and no foreign key to `tables` (verified against
 * production 2026-09-20: its only inbound keys are `ca_hand_facts`,
 * `ca_hand_flags` and `ca_hand_notes`, and it has no outbound one), so the
 * `tables -> clubs` join that labels a row cannot filter the query that
 * produces it. `ca_hand_facts` can: one row per player per hand, carrying the
 * table's `club_id`, under `ca_hand_facts_hand_id_fkey` and an RLS policy of
 * `user_id = auth.uid()`. Embedded `!inner` it is a server-side filter on
 * exactly the hands THIS player played in THAT club, so the page, the order and
 * Load More all remain the database's.
 *
 * A client-side filter would have been wrong in a way that is invisible until
 * it matters: page one of fifty cross-club hands can contain no Diamond hands
 * at all, and "no hands" is indistinguishable from "none on this page".
 */
describe('a Diamond hand history is scoped by the server', () => {
  it('asks for no club filter by default, which is the cross-club archive', async () => {
    fixture.handSelect = '';
    fixture.filters = [];
    await handHistoryService.getPlayerHands('hero', 50);
    expect(fixture.handSelect).toBe(HAND_HISTORY_COLUMNS);
    expect(fixture.handSelect).not.toContain('ca_hand_facts');
    expect(fixture.filters).toEqual([]);
  });

  it('filters on the facts row when a club id is given', async () => {
    fixture.handSelect = '';
    fixture.filters = [];
    await handHistoryService.getPlayerHands('hero', 50, { clubId: DIAMOND_ARENA_CLUB_ID });
    expect(fixture.handSelect).toContain(HAND_HISTORY_ARENA_EMBED);
    // The named constraint, not a bare `ca_hand_facts(...)`: an unnamed embed
    // resolves today and errors the day a second path appears, at runtime, on
    // a player's own page.
    expect(HAND_HISTORY_ARENA_EMBED).toContain('!ca_hand_facts_hand_id_fkey');
    expect(HAND_HISTORY_ARENA_EMBED).toContain('!inner');
    expect(fixture.filters).toEqual([[HAND_HISTORY_ARENA_FILTER_COLUMN, DIAMOND_ARENA_CLUB_ID]]);
  });

  it('resolves the diamond asset to the one open club, so the footer need not know a uuid', async () => {
    fixture.handSelect = '';
    fixture.filters = [];
    await handHistoryService.getPlayerHands('hero', 50, { asset: 'diamonds' });
    expect(fixture.filters).toEqual([[HAND_HISTORY_ARENA_FILTER_COLUMN, DIAMOND_ARENA_CLUB_ID]]);
  });

  it('treats an absent scope as absent, never as the arena', async () => {
    for (const opts of [{}, { clubId: null }, { asset: null }, { clubId: '   ' }] as const) {
      fixture.handSelect = '';
      fixture.filters = [];
      await handHistoryService.getPlayerHands('hero', 50, opts);
      expect(fixture.filters, JSON.stringify(opts)).toEqual([]);
      expect(fixture.handSelect, JSON.stringify(opts)).not.toContain('ca_hand_facts');
    }
  });

  it('keeps the table scope and the arena scope independent', async () => {
    fixture.handSelect = '';
    fixture.filters = [];
    await handHistoryService.getPlayerHands('hero', 50, {
      tableId: 'table-1',
      asset: 'diamonds',
    });
    expect(fixture.filters).toEqual([
      ['table_id', 'table-1'],
      [HAND_HISTORY_ARENA_FILTER_COLUMN, DIAMOND_ARENA_CLUB_ID],
    ]);
  });

  it('prefers an explicit club id over the asset, the more specific statement winning', async () => {
    fixture.handSelect = '';
    fixture.filters = [];
    await handHistoryService.getPlayerHands('hero', 50, {
      clubId: 'some-other-club',
      asset: 'diamonds',
    });
    expect(fixture.filters).toEqual([[HAND_HISTORY_ARENA_FILTER_COLUMN, 'some-other-club']]);
  });
});
