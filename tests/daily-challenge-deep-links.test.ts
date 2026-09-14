import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(__dirname, '../src/App.tsx'), 'utf8');
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
const authGuard = readFileSync(resolve(__dirname, '../src/components/auth/AuthGuard.tsx'), 'utf8');
const routeFallback = readFileSync(
  resolve(__dirname, '../src/components/challenges/DailyChallengesRouteFallback.tsx'),
  'utf8'
);
const challengeRoute = readFileSync(
  resolve(__dirname, '../src/components/challenges/DailyChallengesRoute.tsx'),
  'utf8'
);

describe('Daily Challenge cycle deep links', () => {
  it('routes Daily, Weekly, and Monthly as bookmarkable subpages', () => {
    expect(app).toContain('path="challenges/:cycle?"');
    expect(page).toContain("cycle === 'daily' || cycle === 'weekly' || cycle === 'monthly'");
    expect(page).toContain(
      'withClubContext(`/challenges/${tier}${location.search}${location.hash}`'
    );
    expect(page).toContain('data-mission-cycle={activeTier}');
  });

  it('recovers malformed cycle bookmarks without dropping query, hash, or club context', () => {
    expect(page).toContain('`/challenges${location.search}${location.hash}`');
    expect(page).toContain('withClubContext(');
    expect(page).toContain('routeClubId');
    expect(page).toMatch(/replace:\s*true/);
    expect(page).toContain("setActiveTier('daily')");
  });

  it('keeps club context through tier, mission, and arena navigation', () => {
    expect(page).toContain('navigate(withClubContext(action.path, routeClubId))');
    expect(page.match(/routeClubId \? `\/clubs\/\$\{routeClubId\}` : '\/'/g)).toHaveLength(2);
  });

  it('uses the cinematic Daily Missions master during auth checks and render recovery', () => {
    expect(app).toContain("import('./components/challenges/DailyChallengesRoute')");
    expect(app).not.toContain("from './components/challenges/DailyChallengesRouteFallback'");
    expect(challengeRoute).toContain('loadingFallback={<DailyChallengesAuthLoading />}');
    expect(challengeRoute).toContain(
      '<DailyChallengesCrashFallback error={error} onRetry={retry} />'
    );
    expect(challengeRoute).toContain('<Suspense fallback={<DailyChallengesAuthLoading />}>');
    expect(challengeRoute).toContain(
      "lazyWithRetry(() => import('../../pages/DailyChallengesPage'))"
    );
    expect(authGuard).toContain('if (loadingFallback) return <>{loadingFallback}</>;');
    expect(routeFallback).toContain('data-daily-missions-auth-loading=""');
    expect(routeFallback).toContain('data-daily-missions-crash-fallback=""');
    expect(routeFallback).toContain('daily-missions-casino-v2.webp');
    expect(routeFallback).toContain('<CasinoControlIcon');
    expect(routeFallback).not.toMatch(/\p{Extended_Pictographic}/u);
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
