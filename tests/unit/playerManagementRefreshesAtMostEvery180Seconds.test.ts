/**
 * Dan, 2026-10-25: "STOP AUTO REFRESHING THE PLAYER MANAGEMENT PAGE. ONCE
 * EVERY 180 SECONDS IS FINE, NOTHING SOONER."
 *
 * Every automatic roster re-read (live record signals, membership events,
 * window focus, tab return) is scheduled through scheduleStructuralRefresh,
 * which waits until liveRosterRefreshPolicy.minIntervalMs after the last read.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../src/hooks/useProfilePresence', () => ({
  useOnlineNow: (_id: string, loaded: boolean) => loaded,
}));

import { liveRosterRefreshPolicy } from '../../src/pages/ClubMembersPage';

const PAGE = readFileSync(resolve(__dirname, '../../src/pages/ClubMembersPage.tsx'), 'utf8');

describe('Player Management refreshes itself at most once every 180 seconds', () => {
  it('sets the automatic refresh floor to 180 seconds', () => {
    expect(liveRosterRefreshPolicy.minIntervalMs).toBe(180_000);
  });

  it('routes every automatic re-read through the floor', () => {
    expect(PAGE).toContain('liveRosterRefreshPolicy.minIntervalMs - sinceLastRead');
    // No polling timer re-reads the roster on its own clock.
    expect(PAGE).not.toMatch(/setInterval\(/);
  });
});
