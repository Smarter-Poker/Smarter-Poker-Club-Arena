import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { initialArenaIndex, orderArenaCards } from '../../src/components/home/arenaSelection';
import { DIAMOND_ARENA_CLUB_ID } from '../../src/lib/constants';
import {
  InTabLobbyContext,
  arenaTargetFromTo,
  useAppNavigate,
} from '../../src/context/InTabLobbyContext';

const shark = { id: 'shark', club_id: 25450 };
const diamond = { id: DIAMOND_ARENA_CLUB_ID, slug: 'diamond-arena' };
const joined = [{ id: 'first' }, { id: 'second' }];

describe('Poker Arena selection', () => {
  it('keeps platform entries adjacent while preserving joined club preferences', () => {
    const cards = orderArenaCards(
      [...joined, diamond, shark],
      ['second'],
      ['first', 'shark', 'second']
    );
    expect(cards.map((c) => c.id)).toEqual(['shark', DIAMOND_ARENA_CLUB_ID, 'second', 'first']);
    expect(initialArenaIndex(cards, 'retired')).toBe(0);
    expect(initialArenaIndex(cards, 'diamond-arena')).toBe(1);
    expect(initialArenaIndex(cards, 'first')).toBe(3);
  });
  it('ignores malformed saved order and does not mutate the directory', () => {
    const cards = [diamond, ...joined, shark];
    expect(orderArenaCards(cards, [], { old: 'shape' })[0]).toBe(shark);
    expect(cards[0]).toBe(diamond);
  });
  it('does not intercept seats, finance pages, search-only edits or invalid escapes', () => {
    for (const path of ['/table/live', '/clubs/shark/finance', '/clubs/%ZZ', '?filter=cash']) {
      expect(arenaTargetFromTo(path)).toBeNull();
    }
    expect(arenaTargetFromTo({ pathname: '/clubs/diamond-arena' })).toEqual({
      clubKey: 'diamond-arena',
    });
  });
  it('selects Diamond and returns to the carousel without leaving the running table route', () => {
    const openArena = vi.fn(() => true);
    function Controls() {
      const navigate = useAppNavigate();
      const location = useLocation();
      return (
        <>
          <output>{location.pathname}</output>
          <button onClick={() => navigate('/clubs/diamond-arena')}>Diamond</button>
          <button onClick={() => navigate('/')}>Selector</button>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/table/running']}>
        <InTabLobbyContext.Provider
          value={{ openArena, openTournament: () => false, openHub: () => false, goBack: () => {} }}
        >
          <Controls />
        </InTabLobbyContext.Provider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Diamond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Selector' }));
    expect(openArena.mock.calls).toEqual([['diamond-arena'], [null]]);
    expect(screen.getByText('/table/running')).toBeTruthy();
  });
});
