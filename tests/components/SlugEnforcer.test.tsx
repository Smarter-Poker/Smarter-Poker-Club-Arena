import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import SlugEnforcer from '@/components/common/SlugEnforcer';
import { supabase } from '@/lib/supabase';

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useLocation: vi.fn(),
  useNavigate: vi.fn(),
}));

// Mock supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

describe('SlugEnforcer', () => {
  const navigateMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useNavigate as any).mockReturnValue(navigateMock);
  });

  const setupMockQuery = (clubData: any, unionData: any) => {
    const maybeSingleClub = vi.fn().mockResolvedValue({ data: clubData, error: null });
    const eqClub = vi.fn().mockReturnValue({ maybeSingle: maybeSingleClub });
    const selectClub = vi.fn().mockReturnValue({ eq: eqClub });

    const maybeSingleUnion = vi.fn().mockResolvedValue({ data: unionData, error: null });
    const eqUnion = vi.fn().mockReturnValue({ maybeSingle: maybeSingleUnion });
    const selectUnion = vi.fn().mockReturnValue({ eq: eqUnion });

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'clubs') return { select: selectClub };
      if (table === 'unions') return { select: selectUnion };
      return { select: vi.fn() };
    });
  };

  it.each(['path', 'search', 'hash', 'unmount'] as const)(
    'retires an old slug lookup after the %s changes',
    async (change) => {
      let finishOld!: (result: unknown) => void;
      let finishNew!: (result: unknown) => void;
      const oldClub = new Promise((resolve) => {
        finishOld = resolve;
      });
      const newClub = new Promise((resolve) => {
        finishNew = resolve;
      });
      let clubReads = 0;
      (supabase.from as any).mockImplementation((table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              table === 'clubs'
                ? ++clubReads === 1
                  ? oldClub
                  : newClub
                : Promise.resolve({ data: null, error: null }),
          }),
        }),
      }));
      const initial = {
        pathname: '/clubs/12345678-1234-1234-1234-123456789012/table-management',
        search: '?section=ticker',
        hash: '#old',
      };
      (useLocation as any).mockReturnValue(initial);
      const view = render(<SlugEnforcer />);
      if (change === 'unmount') view.unmount();
      else {
        (useLocation as any).mockReturnValue({
          ...initial,
          ...(change === 'path' ? { pathname: '/leaderboard' } : {}),
          ...(change === 'search' ? { search: '?create=table&game=nlh' } : {}),
          ...(change === 'hash' ? { hash: '#current' } : {}),
        });
        view.rerender(<SlugEnforcer />);
      }
      await act(async () => {
        finishOld({ data: { slug: 'test-club', is_union: false }, error: null });
      });
      expect(navigateMock).not.toHaveBeenCalled();
      if (change === 'search' || change === 'hash') {
        await act(async () => {
          finishNew({ data: { slug: 'test-club', is_union: false }, error: null });
        });
        expect(navigateMock).toHaveBeenCalledExactlyOnceWith(
          `/clubs/test-club/table-management${change === 'search' ? '?create=table&game=nlh' : initial.search}${change === 'hash' ? '#current' : initial.hash}`,
          { replace: true }
        );
      }
    }
  );

  it('rewrites non-union club UUID to slug without dropping the nested Data path', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/clubs/12345678-1234-1234-1234-123456789012/data',
      search: '',
      hash: '',
    });

    setupMockQuery(
      { slug: 'test-club', union_id: '87654321-4321-4321-4321-210987654321', is_union: false },
      null
    );

    render(<SlugEnforcer />);

    // flush promises
    await new Promise(process.nextTick);

    expect(navigateMock).toHaveBeenCalledWith('/clubs/test-club/data', { replace: true });
  });

  it('rewrites union hub club UUID to union route preserving UUID', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/clubs/12345678-1234-1234-1234-123456789012',
      search: '',
      hash: '',
    });

    setupMockQuery(
      { slug: 'union-hub', union_id: '87654321-4321-4321-4321-210987654321', is_union: true },
      null
    );

    render(<SlugEnforcer />);

    await new Promise(process.nextTick);

    expect(navigateMock).toHaveBeenCalledWith('/unions/87654321-4321-4321-4321-210987654321', {
      replace: true,
    });
  });

  it('leaves /unions/<uuid> alone when the union has no slug to offer', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/unions/12345678-1234-1234-1234-123456789012',
      search: '',
      hash: '',
    });

    setupMockQuery(
      { slug: 'union-hub', union_id: '12345678-1234-1234-1234-123456789012', is_union: true },
      null
    );

    render(<SlugEnforcer />);

    await new Promise(process.nextTick);

    // Should NOT have navigated because the path shouldn't be altered
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('rewrites /unions/<uuid> to /unions/<slug> (Dan 2026-09-04: the union slug must be present)', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/unions/fade0000-0000-0000-0000-000000000001/table-management',
      search: '?create=table',
      hash: '',
    });

    setupMockQuery(
      { slug: 'midway-union', union_id: 'fade0000-0000-0000-0000-000000000001', is_union: true },
      { id: 'fade0000-0000-0000-0000-000000000001', slug: 'midway-union' }
    );

    render(<SlugEnforcer />);

    await new Promise(process.nextTick);

    expect(navigateMock).toHaveBeenCalledWith(
      '/unions/midway-union/table-management?create=table',
      {
        replace: true,
      }
    );
  });

  it('sends a union house club row straight to /unions/<slug>, in one hop', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/clubs/fade0000-0000-0000-0000-000000000001/financials',
      search: '',
      hash: '',
    });

    setupMockQuery(
      { slug: 'midway-union', union_id: 'fade0000-0000-0000-0000-000000000001', is_union: true },
      { id: 'fade0000-0000-0000-0000-000000000001', slug: 'midway-union' }
    );

    render(<SlugEnforcer />);

    await new Promise(process.nextTick);

    expect(navigateMock).toHaveBeenCalledWith('/unions/midway-union/settlement', { replace: true });
  });

  it('rewrites UUID to /unions/ fallback if club lookup fails but union lookup succeeds', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/clubs/12345678-1234-1234-1234-123456789012',
      search: '',
      hash: '',
    });

    setupMockQuery(
      null, // not found in clubs
      { id: '12345678-1234-1234-1234-123456789012' }
    );

    render(<SlugEnforcer />);

    await new Promise(process.nextTick);

    expect(navigateMock).toHaveBeenCalledWith('/unions/12345678-1234-1234-1234-123456789012', {
      replace: true,
    });
  });
});
