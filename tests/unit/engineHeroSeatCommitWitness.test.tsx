import { useEffect, useRef, useState } from 'react';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  useEngineHeroSeatInvariant,
  type AppliedSeatSnapshot,
} from '../../src/hooks/useEngineHeroSeatInvariant';
import { mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';
import { reportError } from '../../src/utils/errorReporter';

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const snapshot = {
  table_id: 'table-a',
  max_seats: 9,
  pot: 0,
  current_bet: 0,
  stage: 'preflop',
  dealer_seat: 1,
  big_blind: 2,
  small_blind: 1,
  players: [{ seat: 8, user_id: 'hero', stack: 100 }],
  action_history: [],
  community_cards: [],
  side_pots: [],
  winners: [],
  disconnect_states: {},
} as unknown as Parameters<typeof mapEngineSnapshot>[0];
const initial = () => ({
  tableId: 'table-a',
  players: Array<{ id?: string } | null>(9).fill(null),
  maxPlayers: 9,
  heroSeat: 0,
});

function MountedTableEffects({ dropMappedHero = false }: { dropMappedHero?: boolean }) {
  const [tableState, setTableState] = useState(initial);
  const [appliedSnapshot, setApplied] = useState<AppliedSeatSnapshot | null>(null);
  const leftSeatPendingRef = useRef(false);
  // The real mapper and real invariant run in their actual TablePage order.
  useEffect(() => {
    const mapped = mapEngineSnapshot(snapshot, 'hero', 9);
    setApplied({ snapshot, tableId: 'table-a', userId: 'hero' });
    setTableState((prev) => ({ ...prev, players: dropMappedHero ? prev.players : mapped.players }));
  }, [dropMappedHero]);
  useEngineHeroSeatInvariant({
    engineSnapshot: snapshot,
    appliedSnapshot,
    tableId: 'table-a',
    userId: 'hero',
    tableState,
    setTableState,
    lightningObserver: false,
    USE_ENGINE_WS: true,
    leftSeatPendingRef,
  });
  return (
    <div data-testid="roster">
      {tableState.players[7]?.id || 'empty'}:{tableState.heroSeat}
    </div>
  );
}

it('does not report an old render closure while the real mapped hero is committing', () => {
  render(<MountedTableEffects />);
  expect(screen.getByTestId('roster').textContent).toBe('hero:0');
  expect(reportError).not.toHaveBeenCalled();
});

it('still reports and retains the existing bounded reconcile when the committed roster loses the hero', () => {
  const view = render(<MountedTableEffects dropMappedHero />);
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(reportError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'engine seats hero at 8 but client renders no seat (maxPlayers=9, rows=9)',
    }),
    'TablePage.EngineHeroSeatNotRendered'
  );
  expect(screen.getByTestId('roster').textContent).toBe('empty:8');
  view.rerender(<MountedTableEffects dropMappedHero />);
  expect(reportError).toHaveBeenCalledTimes(1);
});

it.each(['snapshot', 'tableId', 'userId'] as const)(
  'rejects a stale %s witness but reports once the exact identity commits',
  (key) => {
    const exact = { snapshot, tableId: 'table-a', userId: 'hero' };
    const stale = { ...exact, [key]: key === 'snapshot' ? { ...snapshot } : 'other' };
    const { rerender } = renderHook(
      ({ witness }) => {
        const [tableState, setTableState] = useState(initial);
        const leftSeatPendingRef = useRef(false);
        useEngineHeroSeatInvariant({
          engineSnapshot: snapshot,
          appliedSnapshot: witness,
          tableId: 'table-a',
          userId: 'hero',
          tableState,
          setTableState,
          lightningObserver: false,
          USE_ENGINE_WS: true,
          leftSeatPendingRef,
        });
      },
      { initialProps: { witness: stale } }
    );
    expect(reportError).not.toHaveBeenCalled();
    rerender({ witness: exact });
    expect(reportError).toHaveBeenCalledTimes(1);
  }
);

it('wires the actual TablePage invariant after its existing snapshot application with that commit witness', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/TablePage.tsx'), 'utf8');
  expect(source).toContain(
    'setAppliedExitSnapshot({ snapshot: engineSnapshot, tableId, userId });'
  );
  expect(source).toMatch(
    /useEngineHeroSeatInvariant\(\{\s*engineSnapshot,\s*appliedSnapshot: appliedExitSnapshot,\s*tableId,\s*userId,\s*tableState,\s*setTableState,\s*lightningObserver,\s*USE_ENGINE_WS,\s*leftSeatPendingRef,/
  );
  expect(source.indexOf('useEngineHeroSeatInvariant({')).toBeGreaterThan(
    source.indexOf('players: nextPlayers')
  );
});
