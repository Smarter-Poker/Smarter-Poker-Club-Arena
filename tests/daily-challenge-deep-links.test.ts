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

  it('closes a stale reroll confirmation when returning to the base route', () => {
    const baseRouteBranch = page.slice(
      page.indexOf('if (!cycle)'),
      page.indexOf("if (cycle === 'daily'")
    );
    expect(baseRouteBranch).toContain("setActiveTier('daily')");
    expect(baseRouteBranch).toContain('setConfirmingRerollId(null)');
  });

  it('preserves path, query, and hash through the signed-out login handoff', () => {
    expect(authGuard).toContain('location.pathname + location.search + location.hash');
    // 2026-09-07: the redirect is built by src/lib/signIn.ts (same web URL,
    // path + search + hash preserved; the in-app AuthPage on native).
    expect(authGuard).toContain(
      'const back = location.pathname + location.search + location.hash;'
    );
    expect(authGuard).toContain('window.location.href = signInUrl(back);');
    const signIn = readFileSync(resolve(__dirname, '../src/lib/signIn.ts'), 'utf8');
    expect(signIn).toContain('redirect=${encodeURIComponent(toWebPath(returnTo))}');
  });
});
