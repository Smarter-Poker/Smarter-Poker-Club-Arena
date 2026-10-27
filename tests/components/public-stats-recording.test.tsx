import { act, cleanup, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { publicHandStatsFrame } from '../../server/src/engine/presentation/publicHandStats';
import { usePlayerStats, __resetPlayerStatsForTests } from '../../src/hooks/usePlayerStats';
import MiniHUD from '../../src/components/table/MiniHUD';
import { STORAGE_KEYS } from '../../src/lib/storage';
let capture: ReturnType<typeof usePlayerStats>['observePublicEvent'];
function Harness() {
  const stats = usePlayerStats('viewer');
  capture = stats.observePublicEvent;
  return <MiniHUD stats={stats.getStats('opponent')} isVisible />;
}
beforeEach(() => {
  localStorage.clear();
  __resetPlayerStatsForTests();
});
afterEach(cleanup);
describe('committed server summary through the live browser store', () => {
  it('renders measured HUD rates and persists counters with the same replay receipt', () => {
    render(<Harness />);
    act(() => {
      capture('table', 'hand_complete', { hand_id: 'uncommitted', winner_ids: ['opponent'] });
      for (let i = 1; i <= 5; i++) {
        const handId = `hand-${i}`;
        const frame = publicHandStatsFrame({
          tableId: 'table',
          handNumber: i,
          handId,
          timestamp: i,
          facts: [
            {
              hand_id: handId,
              user_id: 'opponent',
              vpip: true,
              pfr: false,
              returned: 0,
              hole_cards: ['Ah', 'Ad'],
            },
          ],
          bigBlind: 2,
          actions: [{ userId: 'opponent', action: 'call', amount: 2, stage: 'preflop' }],
        })!;
        capture('table', String(frame.type), frame);
        capture('proxy-room', String(frame.type), frame);
      }
    });
    expect(screen.getByText('100')).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PLAYER_STATS_SWR)!);
    expect(stored.version).toBe(2);
    expect(stored.receipts).toHaveLength(5);
    expect(Object.values(stored.stats)).toEqual([
      expect.objectContaining({
        handsPlayed: 5,
        vpipCount: 5,
        pfrCount: 0,
        aggressiveActions: 0,
        callActions: 5,
        aggressionMeasured: true,
      }),
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/hole_cards|Ah|Ad/);
  });
});
