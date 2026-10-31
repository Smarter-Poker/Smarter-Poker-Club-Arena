import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EntriesTab from '../../src/components/tournament/details/EntriesTab';
import type { TournamentTabProps } from '../../src/components/tournament/details/types';
const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: db }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
function props(rebuys: number | undefined): TournamentTabProps {
  return {
    tournament: { id: 'event', status: 'RUNNING', is_rebuy: true },
    entries: [
      {
        id: 'p',
        user_id: 'u',
        username: 'Player',
        chips: 100,
        status: 'playing',
        rebuys,
        add_ons: 0,
      },
    ],
    tables: [],
    blindLevels: [],
    isRegistered: true,
  } as TournamentTabProps;
}
function total(container: HTMLElement) {
  return [...container.querySelectorAll('.tl-stat')]
    .find((x) => x.textContent?.includes('Rebuys'))
    ?.querySelector('.tl-stat__value')?.textContent;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('entry register uses the live field supplied by its owner', () => {
  it('does not let an older detail fetch override a newly committed rebuy', async () => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order']) q[k] = () => q;
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'p', rebuys: 1, add_on: false }], error: null }).then(resolve);
    db.from.mockReturnValue(q);
    const view = render(<EntriesTab {...props(1)} />);
    await waitFor(() => expect(total(view.container)).toBe('1'));
    view.rerender(<EntriesTab {...props(2)} />);
    expect(total(view.container)).toBe('2');
  });
  it('uses the complete supplied field without another capped read', () => {
    db.from.mockImplementation(() => {
      throw new Error('Unexpected duplicate field read');
    });
    const p = props(1);
    p.entries = Array.from({ length: 1001 }, (_, i) => ({
      ...p.entries[0],
      id: `p${i}`,
      user_id: `u${i}`,
      rebuys: 1,
    }));
    const view = render(<EntriesTab {...p} />);
    expect(total(view.container)).toBe('1,001');
    expect(db.from).not.toHaveBeenCalled();
  });
  it('keeps missing rebuy metadata unknown instead of claiming zero', () => {
    const view = render(<EntriesTab {...props(undefined)} />);
    expect(total(view.container)).toBe('-');
    expect(view.container.textContent).toContain('Rebuy And Add-On Counts Could Not Be Loaded');
  });
  it('updates satellite qualification and add-on marks from the same live row', () => {
    const p = props(0);
    const view = render(<EntriesTab {...p} />);
    expect(view.container.querySelector('.et-marks')?.textContent).not.toContain('Add-On');
    view.rerender(
      <EntriesTab
        {...{ ...p, entries: [{ ...p.entries[0], add_ons: 1, is_satellite_qualifier: true }] }}
      />
    );
    expect(view.container.querySelector('.et-marks')?.textContent).toContain('Add-On');
    expect(view.container.textContent).toContain('Satellite Winner');
    expect(db.from).not.toHaveBeenCalled();
  });
});
