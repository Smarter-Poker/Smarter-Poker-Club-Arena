import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const maintenance = vi.hoisted(() => ({
  active: false,
  phase: 'idle',
  breakEndsAtMs: null as number | null,
  reason: '',
}));
vi.mock('../../src/hooks/useMaintenanceBreak', () => ({
  useMaintenanceBreak: () => ({ maintenanceBreak: maintenance }),
}));
vi.mock('../../src/utils/serverClock', () => ({ serverNow: () => Date.now() }));
import { MaintenanceBreakBanner } from '../../src/components/common/MaintenanceBreakBanner';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T08:56:00Z'));
  Object.assign(maintenance, { active: false, phase: 'idle', breakEndsAtMs: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('maintenance banner release follows the current Chicago clock immediately', () => {
  it('does not restore a cached upcoming notice after the daily break ends', () => {
    const view = render(<MaintenanceBreakBanner />);
    expect(screen.getByRole('status').textContent).toContain('Daily Maintenance At 4 AM');
    vi.setSystemTime(new Date('2026-10-21T08:58:00Z'));
    Object.assign(maintenance, { active: true, phase: 'last_hand' });
    view.rerender(<MaintenanceBreakBanner />);
    expect(screen.getByRole('status').textContent).toContain('Finishing Their Current Hand');
    vi.setSystemTime(new Date('2026-10-21T09:05:00Z'));
    Object.assign(maintenance, { active: false, phase: 'idle' });
    view.rerender(<MaintenanceBreakBanner />);
    // No interval advance: release must refresh the cached pre-break value now.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a valid upcoming notice immediately when an emergency ends during its lead-in', () => {
    maintenance.active = true;
    maintenance.phase = 'finalizing';
    vi.setSystemTime(new Date('2026-10-21T08:54:00Z'));
    const view = render(<MaintenanceBreakBanner />);
    vi.setSystemTime(new Date('2026-10-21T08:56:00Z'));
    Object.assign(maintenance, { active: false, phase: 'idle' });
    view.rerender(<MaintenanceBreakBanner />);
    expect(screen.getByRole('status').textContent).toContain('Daily Maintenance At 4 AM');
  });
});
