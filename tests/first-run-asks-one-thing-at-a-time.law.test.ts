/**
 * A NEW PLAYER IS ASKED ONE THING AT A TIME (2026-10-17).
 *
 * The two referred players of 2026-10-17 met, in this order: the terms, the
 * profile gate WITH the welcome already mounted underneath it (9999 vs
 * 10000), then the welcome, then the daily bonus sheet, all on the invite
 * page, before they could press Join. Dinodollars joined eight minutes after
 * verifying. These pins keep the welcome off the screen until the profile
 * gate has decided and is down, and keep the bonus sheet off an invite
 * landing, whose one job is the join.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isQuietPath } from '../src/components/daily-bonus/entryState';

const layout = readFileSync(resolve(__dirname, '../src/components/layouts/AppLayout.tsx'), 'utf8');

describe('the first-run prompts take turns', () => {
  it('the welcome mounts only once the profile gate has decided and is down', () => {
    expect(layout).toMatch(
      /isReady && !!user && profileReady && !showProfileModal && \(\s*<ClubArenaWelcomeModal/
    );
    // and it does not hold the prompt lane while it is not on screen
    expect(layout).toMatch(
      /useHoldPromptLane\(\s*'welcome',\s*isReady && !!user && profileReady && !showProfileModal && showWelcome\s*\)/
    );
  });

  it('the daily bonus sheet never opens over an invite landing', () => {
    expect(isQuietPath('/invite/a41434bb-8d0c-400a-8f0d-e8b3d65afed4')).toBe(true);
    expect(isQuietPath('/i/ZG9YGMZ')).toBe(true);
    // ...and still opens in the club itself
    expect(isQuietPath('/clubs/shark-club')).toBe(false);
  });
});
