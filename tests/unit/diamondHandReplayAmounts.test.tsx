import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { buildReplay, replayInputFromRow } from '../../src/utils/handReplay';
import HandDetailView from '../../src/components/handdetail/HandDetailView';
import HandReplay from '../../src/components/replay/HandReplay';
import { buildReplayFrames } from '../../src/utils/replayFrames';
import { HandDetailModal } from '../../src/components/table/HandDetailModal';
import type { HandRecord } from '../../src/components/table/HandHistoryPanel';
vi.mock('../../src/services/StatsFactsService', () => ({
  StatsFactsService: { getHandRakeShare: async () => null },
}));
vi.mock('../../src/hooks/useAuthUser', () => ({ useAuthUser: () => ({ user: null }) }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: new Proxy({}, { get: () => vi.fn() }),
  haptic: new Proxy({}, { get: () => vi.fn() }),
}));
afterEach(cleanup);
function hand(arenaAsset?: 'chips' | 'diamonds') {
  return {
    ...buildReplay(
      replayInputFromRow({
        hand_number: 77,
        game_variant: 'nlh',
        small_blind: 1,
        big_blind: 2,
        pot_size: 20,
        players: [
          { userId: 'a', username: 'Alice', seat: 1, stack: 110, cards: [] },
          { userId: 'b', username: 'Bob', seat: 2, stack: 90, cards: [] },
        ],
        actions: [
          { seat: 1, userId: 'a', action: 'raise', amount: 10, stage: 'preflop' },
          { seat: 2, userId: 'b', action: 'call', amount: 8, stage: 'preflop' },
        ],
        winners: [{ userId: 'a', amount: 20, potIndex: 0 }],
      })
    ),
    arenaAsset,
  };
}
describe('actual hand amounts follow the authoritative arena through detail and replay', () => {
  it.each(['diamonds', 'chips', undefined] as const)(
    'renders %s amounts in the real rundown',
    (asset) => {
      const { container } = render(<HandDetailView model={hand(asset)} />);
      const amounts = [...container.querySelectorAll('.hdv__amt,.hdv__street-pot,.hdv__stack')]
        .map((n) => n.textContent)
        .filter(Boolean);
      expect(amounts.length).toBeGreaterThan(2);
      for (const amount of amounts) {
        if (asset === 'diamonds') expect(amount).not.toContain('.');
        else expect(amount).toMatch(/\.\d{2}$/);
      }
    }
  );
  it.each(['diamonds', 'chips', undefined] as const)(
    'renders %s amounts on the real replay felt',
    (asset) => {
      const { container } = render(
        <HandReplay source={{ model: hand(asset), tableName: 'Arena', handNumber: 77 }} />
      );
      expect(container.querySelector('.hr-felt__pot-value')?.textContent).toBe(
        asset === 'diamonds' ? '0' : '0.00'
      );
    }
  );
});

describe('the remaining replay caption and previous-hand summary consumers', () => {
  it.each(['diamonds', 'chips', undefined] as const)(
    'keeps %s denomination in action/result captions',
    (asset) => {
      const frames = buildReplayFrames(hand(asset));
      const actions = frames.filter((f) => f.row && f.row.amount !== 0);
      expect(actions.length).toBeGreaterThan(0);
      for (const frame of actions) {
        if (asset === 'diamonds') expect(frame.caption).not.toMatch(/\.\d{2}/);
        else expect(frame.caption).toMatch(/\.\d{2}$/);
      }
      expect(frames[frames.length - 1].caption).toMatch(
        asset === 'diamonds' ? /Main 20$/ : /Main 20\.00$/
      );
    }
  );
  it.each(['diamonds', 'chips', undefined] as const)(
    'keeps %s denomination in the real Previous Hand summary',
    (asset) => {
      const model = hand(asset);
      const record: HandRecord = {
        id: 'hand77',
        handNumber: 77,
        timestamp: 0,
        gameType: 'NLH',
        blinds: '1/2',
        players: [],
        streets: [],
        winners: [{ playerId: 'a', playerName: 'Alice', amount: 20 }],
        heroId: 'a',
        heroResult: 10,
        potTotal: 20,
        wentToShowdown: false,
        muckedIds: [],
        rake: 0,
        bbjFee: 0,
        replay: model,
        arenaAsset: asset,
      };
      const { container } = render(
        <HandDetailModal isOpen onClose={() => {}} hands={[record]} heroId="a" />
      );
      expect(container.querySelector('.hdm-potline__pots')?.textContent).toBe(
        asset === 'diamonds' ? 'Main 20' : 'Main 20.00'
      );
    }
  );
});
