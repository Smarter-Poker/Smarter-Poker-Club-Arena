import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ read: vi.fn(), filters: [] as unknown[] }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      m.filters.push(['table', table]);
      const q: any = { select: () => q, maybeSingle: () => m.read() };
      for (const op of ['eq', 'gte', 'lt'])
        q[op] = (column: string, value: string) => {
          m.filters.push([op, column, value]);
          return q;
        };
      return q;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import UnionAccountingRunStatus from '../../src/components/agent/UnionAccountingRunStatus';
beforeEach(() => {
  vi.clearAllMocks();
  m.filters.length = 0;
});
const mount = () => render(<UnionAccountingRunStatus unionId="union-a" periodEnd="2026-09-14" />);
it('shows a failed waterfall despite previously delivered invoices', async () => {
  m.read.mockResolvedValue({
    data: { status: 'failed', result: { success: false, error: 'union_rakeback_wrong_club' } },
    error: null,
  });
  mount();
  expect(await screen.findByText('Automatic Weekly Close Incomplete')).toBeInTheDocument();
  expect(screen.getByText(/Wrong Club/)).toBeInTheDocument();
  expect(m.filters).toEqual(
    expect.arrayContaining([
      ['eq', 'union_id', 'union-a'],
      ['gte', 'period_end', '2026-09-14T00:00:00.000Z'],
      ['lt', 'period_end', '2026-09-15T00:00:00.000Z'],
    ])
  );
});
it('keeps no run distinct from success', async () => {
  m.read.mockResolvedValue({ data: null, error: null });
  mount();
  expect(
    await screen.findByText('No Verified Automatic Close Recorded For This Period')
  ).toBeInTheDocument();
});
it.each([
  { data: null, error: { message: 'offline' } },
  { data: { status: 'complete', result: { success: false } }, error: null },
])('refuses unavailable or contradictory evidence', async (response) => {
  m.read.mockResolvedValue(response);
  mount();
  expect(await screen.findByText('Automatic Close Status Unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Automatic Weekly Close Posted')).not.toBeInTheDocument();
});
it('does not show a late result from another union', async () => {
  let resolve!: (v: unknown) => void;
  m.read
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    )
    .mockResolvedValueOnce({ data: null, error: null });
  const view = render(
    <UnionAccountingRunStatus key="a" unionId="union-a" periodEnd="2026-09-14" />
  );
  view.rerender(<UnionAccountingRunStatus key="b" unionId="union-b" periodEnd="2026-09-14" />);
  await screen.findByText('No Verified Automatic Close Recorded For This Period');
  await act(async () =>
    resolve({ data: { status: 'complete', result: { success: true } }, error: null })
  );
  expect(screen.queryByText('Automatic Weekly Close Posted')).not.toBeInTheDocument();
});
