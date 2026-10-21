import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClubBrandRedirect from '../../src/components/common/ClubBrandRedirect';
afterEach(cleanup);
describe('retired club brand links', () => {
  it.each([
    [
      '/clubs/shark-club/cashier?tab=history#recent',
      '/clubs/kings-club/cashier?tab=history#recent',
    ],
    ['/clubs/SHARK-CLUB', '/clubs/kings-club'],
    [
      '/invite/shark-club?code=join&ref=player&i=token#join',
      '/invite/kings-club?code=join&ref=player&i=token#join',
    ],
    ['/stats?club=shark-club&days=7#games', '/stats?club=kings-club&days=7#games'],
    ['/marketplace?club_id=shark-club', '/marketplace?club_id=kings-club'],
    ['/clubs/shark-clubhouse?days=7', '/clubs/shark-clubhouse?days=7'],
    ['/clubs/other-club?club=other-club', '/clubs/other-club?club=other-club'],
  ])('canonicalizes %s and keeps the table shell mounted', (before, after) => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function TableShell() {
      const location = useLocation();
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <output data-testid="current-route">
          {location.pathname}
          {location.search}
          {location.hash}
        </output>
      );
    }
    render(
      <MemoryRouter initialEntries={[before]}>
        <ClubBrandRedirect />
        <TableShell />
      </MemoryRouter>
    );
    expect(screen.getByTestId('current-route').textContent).toBe(after);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
