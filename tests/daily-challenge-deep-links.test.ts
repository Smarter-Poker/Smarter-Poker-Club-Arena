import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const authGuard = readFileSync(resolve(__dirname, '../src/components/auth/AuthGuard.tsx'), 'utf8');

describe('Daily Challenge cycle deep links', () => {
  it('routes Daily, Weekly, and Monthly as bookmarkable subpages', () => {
    expect(app).toContain('path="challenges/:cycle?"');
    expect(page).toContain("cycle === 'daily' || cycle === 'weekly' || cycle === 'monthly'");
    expect(page).toContain('navigate(`/challenges/${tier}`)');
    expect(page).toContain('data-mission-cycle={activeTier}');
  });

  it('recovers malformed cycle bookmarks to the safe Daily ledger', () => {
    expect(page).toContain("navigate('/challenges', { replace: true })");
    expect(page).toContain("setActiveTier('daily')");
  });

  it('preserves path, query, and hash through the signed-out login handoff', () => {
    expect(authGuard).toContain('location.pathname + location.search + location.hash');
    expect(authGuard).toContain('encodeURIComponent(redirectUrl)');
  });
});
