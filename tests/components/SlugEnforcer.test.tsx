import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
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

  it('rewrites non-union club UUID to slug', async () => {
    (useLocation as any).mockReturnValue({
      pathname: '/clubs/12345678-1234-1234-1234-123456789012',
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

    expect(navigateMock).toHaveBeenCalledWith('/clubs/test-club', { replace: true });
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

  it('preserves UUID on /unions/ route and does NOT rewrite to slug', async () => {
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
