import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MiniHUD, { type MiniHUDStats } from '../../src/components/table/MiniHUD';
import SeatSlot, { type SeatPlayer } from '../../src/components/table/SeatSlot';

const stats: MiniHUDStats = {
  handsPlayed: 100,
  vpipCount: 31,
  pfrCount: 25,
  aggressiveActions: 40,
  callActions: 10,
  aggressionMeasured: true,
  threeBetCount: 10,
  cBetCount: 15,
  wtsdCount: 20,
  wonCount: 30,
  totalBuyIn: 1000,
  totalCashOut: 1500,
};
const opponent: SeatPlayer = {
  id: 'opponent',
  name: 'Mongo',
  stack: 1000,
  status: 'active',
  isHero: false,
  showCards: false,
};
afterEach(cleanup);

describe('opponent HUD retirement', () => {
  it.each([true, false])(
    'the legacy renderer emits nothing even with visible=true and compact=%s',
    (compact) => {
      const { container } = render(<MiniHUD stats={stats} isVisible compact={compact} />);
      expect(container).toBeEmptyDOMElement();
    }
  );

  it.each([null, 'all_in'])(
    'an opponent seat ignores stale HUD and classification props during %s',
    (lastAction) => {
      // Old callers, persisted values, and replayed state cannot opt back in.
      const legacy = {
        showHUD: true,
        hudStats: stats,
        playerStyle: {
          style: 'shark',
          label: 'Shark',
          icon: 'S',
          color: 'red',
          bgColor: 'red',
          confidence: 1,
          tooltip: 'Opponent profiling',
        },
      };
      const { container } = render(
        <SeatSlot
          seatNumber={3}
          player={opponent}
          position={null}
          isActive={false}
          lastAction={lastAction}
          showBadges
          {...legacy}
        />
      );
      expect(container.textContent).toContain('Mongo');
      expect(container.querySelector('.mini-hud, .seat__style-badge')).toBeNull();
      expect(container.textContent).not.toMatch(/Shark|REG|VPIP|PFR/);
    }
  );
});
